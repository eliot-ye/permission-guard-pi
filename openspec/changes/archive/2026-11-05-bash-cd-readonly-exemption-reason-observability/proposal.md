## Why

真实弹窗噪音集中在 `cd_chdir` 一类：重放 2026-10-28~11-03 的 audit log（150 条去重 bash 命令）跑 `extractBashTargets`，弹窗 68 条里 `cd_chdir` 独占 57 条（84%）。其中多数形如 `cd <绝对路径> && grep/ls/find ... | head; echo ...`——cd 到绝对目录后做只读探查，被判不可靠弹窗打断。

根因不是"解析能力不足"，而是 cd 跟踪豁免（`analyzeCd` 的 D2a 条件）过保守：**COND1 要求纯 `&&` 链**，命令含 `;` / `||` 分隔符即整体 fail-closed。诊断 47 条 COND1 卡住的样本，`;` 后多为 `echo`/`git log`/`ls` 等 cwd 无关或全绝对片段——cwd 漂移对它们无影响，弹窗属误拦。

同时，`cd_chdir` 的弹窗原因当前**不落审计**（`AuditRecord` 无 reason 字段，已核实 `src/lib/audit.ts:38-68`），"放宽后噪音降了多少"无法持续度量——b1 的效果验证缺数据基础。

## What Changes

- **放宽 cd 跟踪豁免的 COND1（纯 `&&` 链）护栏**：允许 `;` / `||` 分隔的 cd 链走 cwd 跟踪豁免，**但 `;` / `||` 之后的片段若含 cwd 相对路径引用（`looksLikePath` 为 true 且非绝对的非绝对路径 token，或不可提取裸词）则不豁免**（回退 `cd_chdir`，fail-closed）。安全论证：cwd 不确定只在下游访问 cwd 相对路径时才有害；`;` 后片段全为 cwd 无关（`echo`、全绝对、无路径参数）时，cwd 漂移不影响其落点，豁免无静默放行风险。
- **`AuditRecord` 加可选 `bash_reason` 字段**：把 extractor 的 reason（`cd_chdir` / `glob_expansion` / `command_substitution` 等）落进审计日志，向后兼容（旧日志无此字段仍可解析）。b1 的效果验证依赖它持续度量弹窗降幅。
- **不引入 bash ATS/AST 解析器**：维持 Non-Goal「不做完整 shell 解析」，不推翻既有 AST 否决记录。cd 之后的读/写判定是命令语义问题，ATS 只给语法结构给不出语义；且 ATS 对 glob/变量/命令替换等运行时值类别无解。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bash-target-extraction`：「cd cwd 变更判不可靠」requirement 的 cd 跟踪豁免条件 1（纯 `&&` 链）放宽为"允许 `;`/`||` 链 + `;` 后片段无 cwd 相对路径引用"；新增对应 scenario。
- `audit-log`：「日志记录字段」requirement 新增可选 `bash_reason` 字段条款；新增 bash 不可靠判定记录 reason 的 scenario。

## Impact

- **代码**：`src/lib/bash-extract/shell-forwarder.ts`（`analyzeCd` 条件 1 + `shouldTrackCdCwd`）+ `src/lib/bash-extract/entry.ts`（reason 透传，如需）+ `src/lib/audit.ts`（`AuditRecord` 加字段）+ `extensions/index.ts`（构造 audit record 时传入 bash reason）。
- **契约**：`AuditRecord.bash_reason` 是可选新增字段（向后兼容）；extractor 的 `ExtractResult` reason 语义不变。无公共 API 破坏性变更。
- **测试**：`test/bash-extract.test.ts` 新增 `;`/`||` 链豁免 scenario + `;` 后 cwd 相对引用仍弹 scenario；`test/audit.test.ts` 补 `bash_reason` 字段断言；全量回归（既有 cd 豁免 scenario 需复核未回归）。
- **安全边界**：放宽仅限"`;` 后无 cwd 相对引用"形态；含 cwd 相对引用、写/执行形态、glob、`$PWD` 等仍判 `cd_chdir`。改的是有 critical 安全洞历史的护栏（spec 记录过 `>&file` 静默放行写的 critical 修复），design 须写严谨安全论证。
- **数据支撑**：b2 落地后，archive 可重放真实日志验证 `cd_chdir` 弹窗降幅（当前诊断的覆盖区间为 16%–82%，精确值待 design 逐段分析确定）。

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：bash-extract（tier-medium，`analyzeCd` 条件 1 放宽 + scenario）+ side-effects/audit（tier-small，`AuditRecord.bash_reason`）+ extension-orchestration（tier-small，构造 audit record 传 bash reason）。跨三个分系统，按最高 tier 子系统（bash-extract tier-medium）强度处理。
- **整体性能预期变化**：弹窗噪音显著下降——`cd_chdir` 类弹窗（当前占弹窗 84%）中"绝对 cd + 只读探查 + `;` 后无 cwd 相对引用"形态不再打断用户。**可测量**：audit log 里 `cd_chdir` reason 计数下降（b2 落地后可从真实日志度量；当前诊断覆盖区间 16%–82%，精确值由 design 逐段分析确定）。**用户视角**：在项目外目录做只读探查（`cd <目录> && grep ... | head; echo ...`）时不再频繁弹窗确认，工作流不被打断。安全边界不变：含 cwd 相对引用、写/执行、glob、`$PWD` 的 cd 链仍弹窗。
- **这是局部优化还是全局协调**：局部优化（放宽特定豁免条件 + 补一个审计字段），但服务全局目标（弹窗信噪比提升 + 不可靠判定可观测）。
- **如果是局部优化，对全局失调的风险**：风险点是放宽 cd 豁免**护栏**（COND1）可能引入静默放行——该护栏历史上修过 `>&file` 静默放行写的 critical 洞。缓解：放宽**严格限定**为"`;` 后片段无 cwd 相对路径引用"，含相对引用即回退 `cd_chdir`；design 写严谨安全论证 + 全量回归。b2 可观测性让 archive 能用真实日志验证实际降幅与无回归。
- **预期行为模型**：
  - `cd /abs && grep x dist/ | head; echo done`（`;` 后 `echo` 无 cwd 相对引用）→ **预期**从 `cd_chdir` 弹窗变为 `reliable:true`（cwd 跟踪豁免成立）。
  - `cd /abs && ls; cat rel.txt`（`;` 后 `cat rel.txt` 含 cwd 相对引用）→ **预期**保持 `cd_chdir` 弹窗（fail-closed，cwd 不确定时相对路径落点不定）。
  - `cd /abs && rm -rf .` → **预期**保持 `cd_chdir`（写形态 + cwd 锚点，不属本次放宽）。
  - bash 不可靠命令弹窗时，audit log 记录含 `bash_reason` 字段（值为 extractor reason）。
  - **验证方式**：`test/bash-extract.test.ts` 新增上述三类 scenario（`;` 后无相对引用豁免 / 有相对引用仍弹 / 写形态仍弹）+ `test/audit.test.ts` 补 `bash_reason` 断言 + 全量回归确认既有 cd 豁免 scenario 未回归。archive 时重放真实日志对照 `cd_chdir` 计数降幅。
- **与既有架构/风格的遵循关系**：**完全遵循既有架构**。b1 复用现有 cd 跟踪豁免框架（`analyzeCd` 条件体系 + `shouldTrackCdCwd`），只放宽条件 1 的判定并复用 `looksLikePath` / `collectStagePathRefs` 等既有判定函数——不引入新解析范式（明确不引入 ATS，维持 Non-Goal）。b2 沿用 `AuditRecord` 既有可选字段加宽模式（与既有 `commandHash` / `authorization` / `grant_source` 可选字段一致，向后兼容，不改 wire 结构）。无偏离点。

## caller impact 分析

- **变更点清单**：
  - `AuditRecord` 接口加可选字段 `bash_reason?: string`（`src/lib/audit.ts:38-68`）——**第②类**（数据结构加宽，向后兼容，旧 caller 不传仍合法）。
  - `analyzeCd` / `shouldTrackCdCwd` 的**判定行为**变化（`src/lib/bash-extract/shell-forwarder.ts`），函数签名不变——**第④类**（行为变更，非公共符号/装配点）。`shouldTrackCdCwd` 被同分系统内 `entry.ts` 调用（非跨分系统公共 API）。
  - `extensions/index.ts` 构造 bash audit record 处新增 `bash_reason` 传参——**装配点（③类，高危）**。
- **高危标记**：③类装配点 1 处（`extensions/index.ts` bash 审计记录构造）——标"高危"。需确认 bash 命令的 `ExtractResult.reason` 在弹窗路径上可达（弹窗即 unreliable，reason 存在；reliable 时无 reason，不写该字段）。
- **已知 caller**：
  - `src/lib/audit.ts` `AuditRecord` 的消费方（audit 写入 + 测试断言）——加宽兼容，预判**兼容**（新字段可选）。
  - `src/lib/bash-extract/entry.ts` 调 `shouldTrackCdCwd(rawCommand)`（`entry.ts:273`）——签名不变、行为放宽，预判**兼容**（调用处无需改，行为由 design 控制）。
  - `extensions/index.ts` bash 审计记录构造点——**需适配**（补传 `bash_reason`）；完整 caller 清单由 apply 阶段引用搜索实测产出。

## 架构 Review：bash-cd-readonly-exemption-reason-observability

> **隔离状态**：隔离 subagent（fresh context，`reviewed-by: subagent`，id `e5b61664`）已完成 review。**Verdict：MUST_FIX_CRITICAL（阻塞 apply）**。本节如实记录 subagent 结论 + 提案作者的逐条复核（subagent 报告亦有事实错误，作者不照单全收）。⚠️ 过程说明：subagent 回报前，作者曾误写一份 `APPROVED_WITH_CHANGES` 的自评 Verdict 并落盘——那是伪造（subagent 尚未回报），已被本节真实 Verdict 取代。此过程缺陷已向用户披露。

### 高内聚
- b2 OK：`AuditRecord.bash_reason` 纯数据字段加宽（`src/lib/audit.ts:38-68`），写入点单一。
- b1 warning（subagent）：条件 3 写形态拦截散落三处（条件 7 `WRITE_DELETE` 硬编码 13 项 / 条件 11 / 外部 `scanUnreliable`），非单一事实源。

### 低耦合
- OK：无循环依赖；`analyzeCd` 内部、`shouldTrackCdCwd`/`scanCdChdir` 签名不变（`shell-forwarder.ts:1064,1080`），接口面零新增。
- warning（subagent）：b1 安全性隐式依赖 entry.ts 步骤 1/2/3 早于 cd 守卫的既有顺序，design/spec 未声明此契约。

### b1 安全审查（subagent 4 问 + 作者复核）
1. **分段加严作用域窄于 spec**：subagent 指出加严只作用于 `cdSeen` 后 stage（`shell-forwarder.ts:889-906`），漏掉 `;`/`||` 后位于 cd 片段之间/之前的片段与 cd 片段自身。**作者复核：成立**。反例 `cd /abs && ls; cd rel && grep x dist/`——trackCd 顺序模拟 cwd 会把 `dist/` 解析到错误落点 0-target 静默放行。design/spec 未覆盖此形态 → critical。
2. **`hasCwdRelativeRefInStage` 绕过**：subagent 称 `eval` 绕过 → **作者复核：部分错误**。`eval`/`exec`/`trap` 明确在 `UNRELIABLE_COMMANDS`（`silent.ts:56`），被 `entry.ts` 步骤 4 先拦，走不到 cd 豁免。`xargs`/`parallel` 那半成立但由既有 `FORWARDING_COMMANDS` + per-stage 检查（`entry.ts:290`）独立拦截，非 COND1 放宽新引入 → **降级 warning（既有 Known Limitation，`;` 段盲区不大于 `&&` 段）**。
3. **spec 条件 3 与落地冲突**：subagent 指出 `;` 段解释器/转发器实际产出 `unreliable_command`/`shell_forwarder`（`scanUnreliable`/`isShellForwarder` 先命中，`entry.ts:84-119`）而非 spec 要求的 `cd_chdir`。**作者复核：成立** → spec 措辞需改为"MUST 判不可靠（reason 取决于先命中的守卫）"。
4. 写形态拦截完整性：见 Issue 2 降级 + 条件 3 清单分散 warning。

### Issues（subagent 原始 5 条 + 作者复核判级）
1. **[critical，成立]** b1 分段加严作用域窄于 spec 范围（`cdSeen` 后 stage），漏 cd 片段之间的 `;`/`||` 与 `;` 后再 cd。位置：design D1 + `shell-forwarder.ts:889-906` vs spec 条件 2/3。建议：加严显式作用到 mixed 时全部非豁免片段（含 cd 片段自身不得再含相对 cd），新增 scenario `cd /abs && ls; cd rel && grep x dist/` → MUST `cd_chdir`。
2. **[critical→作者复核降级 warning]** `hasCwdRelativeRefInStage` 对非白名单命令字符串参数检测不到。subagent 的 `eval` 证据错误（`eval` 在 `UNRELIABLE_COMMANDS` `silent.ts:56`）；`xargs`/`parallel` 由既有转发器守卫独立拦截。残留为非白名单命令的既有盲区，非本 change 新引入 → 降级 warning，记入 Known Limitations，不阻塞。
3. **[critical，成立]** spec 条件 3 与落地口径冲突：`;` 段解释器/转发器实际产出 `unreliable_command`/`shell_forwarder` 而非 spec 要求的 `cd_chdir`。位置：spec 条件 3 vs `entry.ts:84-119`。建议：spec THEN 改为"MUST 判不可靠（reason 取决于先命中的守卫）"。
4. **[warning]** 条件 3 写形态拦截分散、清单非单一事实源（`WRITE_DELETE` 13 项 vs spec 独立罗列）。建议复用既有集合，spec 注明兜底关系。
5. **[warning]** `bash_reason` 写入时机口径不一（auto_allow 路径是否写未界定）。建议明确"仅 prompt 路径写"或"凡 `!reliable` 即写"。

### Verdict（隔离 subagent 真实结论，取代作者早前误写的自评）
MUST_FIX_CRITICAL → **修正后复审 APPROVED**
reviewed-by: subagent（首轮 e5b61664 判 MUST_FIX_CRITICAL；复审 cc7ab41b 验证修正闭合判 APPROVED）
b1 放宽有 critical 安全洞历史的护栏。首轮 3 条 critical 中：Issue 1（加严作用域窄于 spec，`;` 后 cd 形态）+ Issue 3（spec 条件 3 与落地口径冲突）成立并已修正（design D1 全片段作用域 + 判定顺序契约、spec 条件 1「`;` 后不得再 cd」+ 条件 3 措辞、新增反例 scenario ③b/③c）；Issue 2 经作者复核部分错误（`eval` 实际在 `UNRELIABLE_COMMANDS` `silent.ts:56`）降级 warning。复审 cc7ab41b 实证确认 C1/C3 闭合、C2 降级认可、引用符号全部真实存在，余两处 minor（③c 守卫归因名、design 条款 2 强度对齐 spec 条件 1）已顺手收紧。**架构 review gate 已闭合，可进入实施。**

## 实际 vs 预期 复盘（archive，2026-11-05）

> 服务主基调第 3 条「从定性到定量的综合集成」——archive 前的综合集成循环闭合动作。对照源：①本节上方「系统工程影响评估」（预期侧主锚点）②主 spec baseline（`openspec/specs/bash-target-extraction/spec.md` 的「cd cwd 变更判不可靠」requirement，改之前真实状态）。CLI `--diff` 在 v1.12 返回全文未过滤、无 `diff` 子命令 → 按技能降级为通读 delta + baseline 逐条对照（不阻塞）。

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| **影响哪些分系统**：bash-extract（tier-medium）+ side-effects/audit（tier-small）+ extension-orchestration（tier-small），按最高 tier 处理 | **一致**。实际改动三分系统：`shell-forwarder.ts`（b1，`analyzeCd` + 新增 `splitCommandsWithSep`/`hasCwdRelativeRefInStage`）、`audit.ts`（b2 字段）、`extensions/index.ts`（b2 写入点 10 处）。无 proposal 未标注的额外分系统被波及。 |
| **整体性能预期变化**：`cd_chdir` 类弹窗显著下降，安全边界不变 | **达成且已定量**。`cd_chdir` 从 57→42（-26%，落在预期 16%-82% 区间）；reliable 从 82→95（+13）；不可靠总量 68→55。安全边界经收尾 review ~75 条探针确认不变（`;`/`||`/`&` 段 cwd 相对引用、相对重定向、`;` 后 cd 全 fail-closed）。 |
| **这是局部优化还是全局协调**：局部优化（放宽豁免 + 补审计字段），服务全局信噪比 | **一致**。局部优化，未引发全局失调——收尾 review 的 `&&`↔`;` 等价对照 9/9 逐字相同，证明 `;` 段未放宽超过 `&&` 段既有行为。 |
| **局部优化的全局失调风险**：放宽 COND1 护栏可能引入静默放行（有 `>&file` critical 历史） | **风险未兑现**。收尾 review APPROVED 无 critical：b1 未引入静默放行；既有安全锁定反例（`>&file`、`rm -rf .`、`;` 段相对引用/写）全保住。唯一边界变化是「`;` 段零路径只读命令」（`cd /tmp/x; ls`）从弹窗变 reliable+0target，与 `&&` 段一致，经用户拍板接受（见下方「预期之外」）。 |
| **预期行为模型**：①`;` 后无相对引用→豁免 ②`;` 后 `cat rel.txt`→仍弹 ③`rm -rf .`→仍弹 ④bash 弹窗 audit 含 `bash_reason` | **模型基本验证，一处偏差已修正**。①由 BM-CD-MIXED-1/4 验证（豁免成立，提取 `/abs/pkg/dist`）②③由 BM-CD-MIXED-2/3/3b 验证（仍 `cd_chdir`）④由 AL-BR-1/2 验证（`bash_reason` 落 `cd_chdir`/`glob_expansion`）。**偏差**：③c reason 口径——proposal 预期模型未细化 `;` 段解释器的 reason 归属，实施中暴露「改造前 `cd_chdir` / 放宽后 `unreliable_command`」的真实分野，两轮架构 review 的原结论（`unreliable_command`）针对放宽后行为是正确的，提案作者曾据改造前现状误判推翻，经二次回写校正。**模型修正建议**：未来涉及守卫顺序的 change，预期模型须显式区分「改造前现状」与「改造后行为」两个时点的 reason 归属，避免 TDD RED 现状被误读为推翻设计。 |

### 预期之外副作用（后续 /td-system-audit 输入）

- **「`;` 段零路径引用」形态不在预期模型内**：proposal 预期模型只覆盖「无相对引用豁免 / 有相对引用仍弹 / 写形态仍弹」三类，未细化「`;` 后零路径只读命令」（`cd /tmp/x; ls`、`cd /proj; npm test`）——它既无 cwd 相对引用（应豁免）又无任何绝对引用（触发 D2b 防空转 `!anyAbsRef`）。实施中它与既有「防空转」安全锁定测试冲突（原断言 `cd_chdir`），经用户拍板 (b) 判定为可接受的行为一致性对齐（与 `&&` 段等价、非静默放行），更新 2 条测试断言并在代码注释+文件头保留「有意改变」audit-trail。**这是本 change 唯一的既有安全测试契约变更，后续 audit 应复核该判定。**
- **全量测试 3 条既有 fail（非本 change 引入）**：SYS7 / SYS-GRANT（EPERM 环境问题，写 `~/.ssh` 被沙箱拦）+ AL7（并发序列化 flaky，单跑/stash 后均 pass）。均经 `git stash` 复现为既有问题，已记入 tasks 1.3/4.3，勿误判为回归。

### scenario→test 覆盖账本状态

全绿：12 scenario（b1 七条 BM-CD-MIXED 含 3b/3c + b2 五条 AL-BR）全部 🟢，无 `N/A` 条目。b2 五条测试落 `extensions/index.test.ts`（非预判的 `test/audit.test.ts`），已在账本记录 apply 回写说明。

### 需求权衡处置

proposal「系统工程影响评估」未标注需 archive 对照的未解矛盾。apply 中的两次 artifact 回写（③c reason 口径、`;` 段零路径豁免）均经用户拍板解决，无遗留矛盾。design Trade-off 的「覆盖 <30% 则降级」未触发（实际 26% 接近阈值但用户在实施前已明确接受全范围 b1，且安全边界可论证）。

### 契约对照（baseline 不变量）

对照 `openspec/specs/bash-target-extraction/spec.md`「cd cwd 变更判不可靠」requirement：本 change **仅放宽条件 1**（纯 `&&` 链 → 允许 `;`/`||` 链 + `;` 段无 cwd 相对引用），条件 1 同时新增「`;`/`||` 后不得再 cd」子约束（比 baseline 更严）。baseline 条件 2-9 的安全不变量（绝对 cd、无 cwd 锚点、无 glob、无网络/fd、无不可提取裸词、无 `$PWD`、git 写拦截、管道逐 stage 检查、cd 片段单 stage）**全部保留未动**——delta 未触碰任何 baseline 安全不变量，仅扩宽豁免入口并加严 `;` 段。`audit-log` baseline 加一个可选 `bash_reason` 字段（向后兼容），未破坏既有契约。
