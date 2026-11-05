## Context

当前 `cd_chdir` 判定由 `analyzeCd`（`src/lib/bash-extract/shell-forwarder.ts`）决定：返回 `{ d2a, d2b }`，`scanCdChdir` 在 `!d2a && !d2b` 时触发。`d2a`（cd 跟踪豁免）要求纯 `&&` 链（条件 1）+ cd 目标全绝对（条件 2）+ 下游路径安全（条件 3-11）。重放真实 audit log（150 条去重 bash 命令，2026-10-28~11-03）诊断：弹窗 68 条中 `cd_chdir` 独占 57 条（84%），其中 47 条卡在条件 1（`;`/`||`/`\n` 即 fail-closed）。

条件 1 是**安全护栏**，非过保守误拦：`;` 分隔下 cd 失败时下游仍执行、cwd 不更新，cwd 不可静态确定。该护栏历史上修过 `>&file` 静默放行写的 critical 洞（spec 记录见「cd cwd 变更判不可靠」requirement）。

同时，`AuditRecord`（`src/lib/audit.ts:38-68`）无 `reason` 字段，`cd_chdir` 等不可靠判定不落审计——放宽后的弹窗降幅无法持续度量。

安全约束：不引入 bash ATS/AST 解析器（既有 AST 否决记录见 `2026-10-27-bash-grant-whitespace-normalize` design D5）；不放宽写形态、解释器、转发器、git 写子命令的拦截。

## Goals / Non-Goals

**Goals:**
- 放宽 `analyzeCd` 的条件 1，允许 `;`/`||` 分隔的 cd 链走 cd 跟踪豁免，**仅当 `;`/`||` 后所有片段不含 cwd 相对路径引用**。含相对引用的片段使豁免不适用，回退 `cd_chdir`。
- `AuditRecord` 加可选 `bash_reason?: string` 字段，bash 不可靠命令的审计记录携带 extractor reason 原文。向后兼容（旧日志无此字段仍可解析）。
- b2 为 b1 的效果验证提供数据基础——archive 阶段可重放真实日志度量 `cd_chdir` 弹窗降幅。

**Non-Goals:**
- 不引入完整 bash AST/ATS 解析器（维持 Non-Goal「不做完整 shell 解析」）。
- 不改变 `ExtractResult` 公共类型（reason 语义不变）。
- 不放宽写/执行/解释器/转发器/git 写子命令/网络外传目标的 `cd_chdir` 拦截——即使它们出现在 `;`/`||` 段且无 cwd 相对引用。
- 不改变既有 cd 跟踪豁免（纯 `&&` 链）和全绝对下游豁免的行为。

## Decisions

### D1: 放宽 COND1 的实现——分段检查 + 全片段作用域

**决策**：`analyzeCd` 内部把条件 1 的检测从布尔 `pureAnd` 改为**记录分隔符类型列表**：`separatorType: "pure-and" | "mixed"`。当检测到 `;`/`||`/`\n` 时，`separatorType` 记为 `"mixed"`，但**不立即 fail d2a**——继续进入条件 2-11 的下游片段检查。

**加严作用域（架构 review Issue 1 修正）**：`mixed` 时加严 MUST 作用到**全部非豁免片段**，不仅限 `cdSeen` 之后的片段——
1. **`;`/`||` 之后的所有片段**（含 `cd` 片段与普通片段）——一律加严（无 bareDirOk 豁免、无 cwd 相对引用）。
2. **`;`/`||` 之后的 `cd` 片段**——MUST 一律 fail d2a（**无论目标是相对还是绝对**，与 spec 条件 1 的全量禁止对齐）。理由：`;` 下前一个 cd 可能失败，后一个 cd 的落点（及其后下游片段的 cwd 基线）依赖"前一个 cd 是否成功"，**不可静态确定**。相对目标（`cd rel`）会顺序模拟 cwd 把下游相对路径解析到错误落点（如 `cd /abs && ls; cd rel && grep x dist/` 的 `dist/` 会被误解析为 `<原cwd>/rel/dist`，0-target 静默放行）；绝对目标（`cd /abs2 && grep x dist/`）虽 cwd 确定为 `/abs2`，但禁止更简单且与 spec 条件 1 单一事实源一致，避免"仅禁相对"与 spec"禁任意"强度不一致（架构 review 复审 minor 修正）。这是架构 review 指出的静默放行洞（现有 `downstreamStages` 收集只覆盖 `cdSeen` 后片段，`shell-forwarder.ts:889-906`）。
3. **cd 片段自身**——mixed 时 cd 片段的 `splitPipelines` 结果 MUST 仍恰好 1 stage（`cd a | b` 不可静态确定）。

**下游片段判定按来源分段**：
- `&&` 段的下游片段：走现有条件 4-11（cwd 可跟踪，read-only 可提取命令的裸词目录经 `resolveBase` 解析，有 bareDirOk 豁免）。
- `;` / `||` 段的下游片段：在现有条件 4-11 基础上**额外加严**——该片段**不得含任何非绝对路径引用**（无论 `looksLikePath` 是 true 还是 false），无 bareDirOk 豁免。理由：`;`/`||` 段 cwd 不可跟踪，无法确定漂移后 cwd 的相对路径落点；bareDirOk 豁免依赖"cwd 已模拟、真实落点可静态确定"，在 `;` 段不成立。

**与既有守卫的判定顺序契约（架构 review Issue 3 修正 → apply 二次实测回写）**：`;` 段的解释器/转发器（`node -e`/`python -c`/`bash -c` 等）最终 reason 取决于**本豁免是否成立**，`entry.ts` 真实守卫顺序为：步骤 0 `scanFindWriteFlags` → 1 `scanUnreliable`（抓 `$()`/反引号，不查命令名）→ 2 `scanControlFlow` → 2b `scanCdChdir`（cd 守卫）→ 3 `isShellForwarder` → 4 `isAnyUnreliableCommand`。
- **豁免成立时**（`;` 后无 cd、各 `;` 片段无 cwd 相对引用）：cd 守卫（2b）因 d2a=true **不再命中** → 落到后续守卫——解释器经步骤 4 产出 `unreliable_command`、转发器经步骤 3 产出 `shell_forwarder`。**这正是两轮架构 review 声称的行为**（"解释器/转发器产出 `unreliable_command`/`shell_forwarder` 而非 `cd_chdir`"），针对放宽后行为，原结论正确。
- **豁免不成立时**（`;` 片段含 cwd 相对引用或写形态）：cd 守卫（2b）先命中产出 `cd_chdir`。
- **apply 误判与纠正记录**：RED 阶段 BM-CD-MIXED-3c 实测产出 `cd_chdir`（**改造前**现状），提案作者误判为"推翻两轮 review"，据此做了错误回写（把 artifact 改成"cd 守卫先拦产出 cd_chdir"）。2.3 实现后重测 3c 产出 `unreliable_command`（**放宽后**），暴露回写方向错误。用户拍板 (a) 二次回写：artifact 改回 review 原结论（豁免成立时 reason=`unreliable_command`/`shell_forwarder`），测试 3c 期望同步改回。fail-closed 语义全程成立（`node -e` 无论 `cd_chdir` 还是 `unreliable_command` 均判不可靠弹窗，无静默放行）。b1 安全性隐式依赖此既有判定顺序，本 change 不改变它，本 design 显式声明**修正后**的契约。

**备选方案**：
- (a) 完全移除 `pureAnd` 检测——风险：`&&` 与 `;` 段 cwd 语义不同（`&&` 短路保证 cd 成功，`;` 不保证），一律用同套条件会漏拦 `;` 后的 cwd 相对引用。弃。
- (b) 新增独立的 d2c 判定路径——代码更清晰但复杂度高，`scanCdChdir` 变三路分支。弃。
- (c) 采纳：分段检查 + 全片段作用域，最小改动，复用现有 `collectStagePathRefs` / `looksLikePath` / `containsCwdAnchor` / `containsUnquotedGlob` 判定函数。

### D2: `;`/`||` 段 cwd 相对引用检测

**决策**：新增辅助函数 `hasCwdRelativeRefInStage(stage: string): boolean`，内部逻辑：
1. 调 `collectStagePathRefs(stage)` 收集该片段所有路径引用（位置参数 + 重定向目标）。
2. 对每个 ref：若 `isExplicitAbsolutePath(ref)` 为 false 且**非** `isNetOrFdTarget(ref)`，则：
   - `looksLikePath(ref)` 为 true（如 `rel.txt`、`dist/`）→ 返回 true（cwd 相对引用）
   - `looksLikePath(ref)` 为 false（不可提取裸词如 `sub`）→ 返回 true（cwd 相对引用，无法提取为 target）
   - `containsCwdAnchor(ref)`（`.`、`..`）→ 返回 true
3. 检查片段文本是否含未加引号 glob（`containsUnquotedGlob(stage)`）或 `$PWD`/`$OLDPWD` → 返回 true。
4. 全通过 → 返回 false。

**关键区别**：与 `&&` 段条件 9 的 bareDirOk 豁免不同，`;`/`||` 段**没有** bareDirOk 豁免——`canExtractBareDir` 命令（`cat`/`grep`/`ls` 等）的裸词目录在 `;` 段**不豁免**，因为 cwd 不可模拟。

**检测范围边界（架构 review Issue 2 降级 warning，记入 Known Limitations）**：`hasCwdRelativeRefInStage` 依赖 `collectStagePathRefs`，而后者只对 `FILE_ARG_COMMANDS`/`OUTPUT_FLAG_COMMANDS` 白名单命令收集位置参数（`shell-forwarder.ts:629/677`）——非白名单命令字符串参数内的相对引用检测不到。这是既有 `&&` 段今天就有的边界（同款 `collectStagePathRefs`），非本 change COND1 放宽新引入。`eval`/`exec` 等解释器已由 `UNRELIABLE_COMMANDS`（`silent.ts:56`）在 `entry.ts` 步骤 4 先拦，走不到 cd 豁免；`xargs`/`parallel` 由既有 `FORWARDING_COMMANDS` + per-stage 检查独立拦截。残留为白名单外任意命令的既有盲区，`;` 段盲区不大于 `&&` 段，不阻塞本 change。

**条件 3 写形态拦截的单一事实源（架构 review Issue 4 修正）**：`;` 段的写/删命令检测 MUST 复用既有集合（`WRITE_DELETE`，`shell-forwarder.ts:963`）∪ 外层写分支 ∪ `UNRELIABLE_COMMANDS`（解释器），**不新造独立清单**——避免"条件 3 独立罗列"与既有 `WRITE_DELETE` 漂移。实现时条件 3 判定委托给既有集合查询；spec 罗列的命令仅为文档示例（注明「等」非穷尽，兜底靠 `collectStagePathRefs` 的 `FILE_ARG_COMMANDS` 收集 + 条件 9 相对引用排除）。

### D3: `bash_reason` 字段写入位置

**决策**：
- `src/lib/audit.ts` 的 `AuditRecord` 接口加 `bash_reason?: string`（可选，向后兼容）。
- 写入位置：`extensions/index.ts` 的 bash 审计记录构造处（弹窗路径可达）。该处已持有 `ExtractResult`，当 `!reliable` 时取 `result.reason` 写入 `bash_reason`。
- 可靠 bash 命令（`reliable: true`）、文件工具记录不写该字段。
- `truncateCommand` 函数无需改——`bash_reason` 是短字符串（reason 标注，不超过 30 字符），不参与命令截断逻辑。

**备选方案**：在 `src/lib/decision.ts` 层注入——但 reason 是 extractor 层产物，decision 层不持有；且 decision 层改动面更广。弃。

### D4: `bash_reason` 值语义——原文透传，不新造编码

**决策**：`bash_reason` 值直接用 `ExtractResult.reason` 原文（`cd_chdir`/`glob_expansion`/`command_substitution`/`control_flow`/`shell_forwarder`/`forwarding_command`/`find_write_flag`/`heredoc`/`unresolved variable: <var>`/`unreliable_command` 等），与 `BASH_REASON_CODES`（`src/lib/reason-codes.ts`）常量集对齐。不新造编码、不转换大小写。

理由：与 reason-codes.ts 的 stable contract 一致（"once introduced, never renamed"）；审计侧可直接用 `bash_reason` 值做聚合统计（`grep -c '"bash_reason":"cd_chdir"'`）。

## Risks / Trade-offs

- **[Risk] 放宽 COND1 可能引入静默放行** → 缓解：`;`/`||` 段比 `&&` 段**更严**（无 bareDirOk 豁免，任何非绝对引用即拦）；全量回归测试；b2 落地后 archive 可重放日志验证无异常放行。
- **[Risk] 实际覆盖收益不确定（16%-82% 区间）** → 38 条 COND1+有 cwd 相对引用的样本，其覆盖取决于"引用是否在 `;` 段"的逐段分析。缓解：design 阶段已明确"`;` 段有 cwd 相对引用即不豁免"，无论覆盖落到哪里，安全边界可论证。b2 让 archive 用真实数据回答"实际降了多少"。
- **[Risk] d2a 逻辑复杂化（条件 1 从布尔改为分段）** → 缓解：分段检查复用现有判定函数（`collectStagePathRefs`/`looksLikePath`/`containsCwdAnchor`），不新造工具；`separatorType` 仅影响下游片段的检查强度，不改变现有 `&&` 段行为。
- **[Trade-off] 安全边界 vs 弹窗信噪比**：本 change 选择"安全边界可论证的放宽"——宁可覆盖 16%（仅 9 条 + 条件 3-11 的 10 条 ≈ 19 条）也不冒静默放行风险。若 design 阶段逐段分析显示覆盖 <30%（收益太小），可降级到"只做条件 3-11 放宽 + b2"（不碰 COND1）。

## Migration Plan

无部署迁移。`bash_reason` 是可选新增字段，旧日志兼容（无此字段仍可解析）。

回退策略：`git revert` 单 commit 即可完全回退。b2 是纯新增字段，回退不影响既有日志。

## Open Questions

无。scope 已由用户拍板（放宽 COND1 + b2 绑定为一个 change）；实际覆盖收益的精确值由 apply 阶段逐段分析确定（记入 tasks.md 的验证项），不阻塞 apply-ready。
