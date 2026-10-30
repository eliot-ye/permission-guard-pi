# Proposal: bash-cd-chain-pipeline-exempt

## Why

cd 跟踪豁免（`analyzeCd` D2a，`shell-forwarder.ts`）的条件 3「无管道」对管道**一刀切**：`cd <绝对> && npm test 2>&1 | tail -25` 这类下游零路径引用的纯 stdin 管道命令被判 `cd_chdir` 弹窗，而语义等价的 `cd <绝对> && npm test`（无管道）静默放行。真实噪音案例即本仓库日常命令 `npm test 2>&1 | tail -25`。管道各 stage 继承 `cd` 后的 cwd，其语义与下游片段完全一致——既有条件 4~11（cwd 锚点 / glob / 裸词 / 无 extractor 命令 / git 写子命令检查）本就有能力逐内容判定，条件 3 的整体拒绝没有对应的安全增量。

## What Changes

- 放宽 `analyzeCd` D2a 条件 3：从「每个片段 `splitPipelines` 结果恰好 1 stage，否则整体拒绝」改为「每个下游片段的**每个 pipeline stage** 逐 stage 通过与下游片段相同的路径安全检查（条件 4~11 的 per-stage 化）」。
  - 纯 stdin 管道（`| tail -25`、`| head -5`、`| grep pattern` 读 stdin 等）不再误弹 `cd_chdir`。
  - 含相对路径引用（`cd /etc && cat passwd | head -5`）、不可提取裸词（`sort sub | wc -l`）、cwd 锚点、glob、转发器的管道仍拒绝，维持 `cd_chdir`。
- cd 跟踪豁免的 cwd 模拟解析在管道 stage 上保持现有语义（stage 内相对路径按模拟 cwd 解析）。
- 全绝对下游豁免（D2b）不变；`cd_chdir` i18n 文案同步修正「无管道」边界描述。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bash-target-extraction`：「cd cwd 变更判不可靠」requirement 的 cd 跟踪豁免条件 3 从「无管道」改为「管道逐 stage 通过路径安全检查」，新增对应 scenario（纯 stdin 管道豁免 + 含相对引用 / 裸词 / 转发器的管道反例）。

## Impact

- 代码：`src/lib/bash-extract/shell-forwarder.ts`（`analyzeCd` 条件 3 及下游片段遍历逻辑）、`src/lib/i18n.ts`（`cd_chdir` 中英文文案各一处）。
- 测试：`test/bash-extract.test.ts` 补 cd 链 + 管道场景断言；`test/security-probe.mjs` 若有「cd 链含管道 → cd_chdir」类断言需按预期行为变化更新。
- 不改变 ExtractResult 数据结构、不改 decision.ts 分派逻辑、不新增公共导出符号。

## caller impact 分析

- 变更点清单：`analyzeCd`（shell-forwarder.ts:720）内部判定逻辑收紧条件 3 的拒绝面——属第 4 类（内部实现细化），非公共符号签名变更；`scanCdChdir`（:948）导出签名不变（`"cd_chdir" | undefined`），属第 1 类符号但**签名与语义枚举不变**，仅返回值分布变化（部分管道命令从 `"cd_chdir"` 变为 `undefined`），标**高危待确认**——见下方已知 caller。
- 已知 caller：
  - `src/lib/bash-extract/entry.ts:53` `scanCdChdir(rawCommand) === "cd_chdir"` → 预判**兼容**：豁免时返回 `undefined`，entry 继续走后续守卫（shell-forwarder / 转发器 / 管道 stage 提取），不跳过任何安全扫描。
  - `src/lib/i18n.ts` reason 文案映射 → 预判**需适配**（文案描述的豁免边界变化，非代码适配）。

## 系统工程影响评估

- 影响哪些分系统：bash-extract（tier-medium）单一分系统；decision / policy-core / extension-orchestration 不受影响（ExtractResult 结构与 decision 分派逻辑均不变）。
- 整体性能预期变化：无性能变化——豁免判定仍是纯函数静态分析，新增的逐 stage 检查复用既有 tokenize/collectStagePathRefs，复杂度不变量级。
- 这是局部优化还是全局协调：局部放宽（cd 链豁免的管道边界），但与全局协调一致——管道 stage 语义（继承 cwd）本就与下游片段相同，全局安全不变量「cwd 漂移下的相对路径引用必须可静态解析或判不可靠」保持完整。
- 如果是局部优化，对全局失调的风险：低。风险点是「cd 链 + 管道 + 相对路径」误放行——由逐 stage 化的条件 4~11 排除（相对引用、裸词、cwd 锚点、glob 在任一 stage 命中即整体拒绝）；转发器风险由既有 forwarding_command 守卫兜底（cd 守卫豁免后 entry 继续执行后续扫描，不短路）。
- 预期行为模型：`cd <绝对路径> && <零路径引用命令链含纯 stdin 管道>` 输入 → 静默放行（无弹窗），targets 为空；`cd <绝对路径> && <含相对路径引用/裸词/cwd锚点/glob/转发器的管道>` 输入 → 弹窗 `cd_chdir`。验证数据：test/bash-extract.test.ts 新增 ≥6 个场景断言（2 豁免 + 4 反例）全绿；`node --experimental-strip-types --test test/` 全量 701+ 用例无回归。
- 与既有架构/风格的遵循关系：完全遵循既有风格——豁免条件逐条编号 + 理由注释的模式（D2a 条件 1~11）、reason code 枚举不变、纯函数无 IO。无架构偏离。

## 实际系统工程影响 vs 预期（td-archive 步骤 3 复盘，tier-medium 全 5 字段）

| proposal 侧（预期） | archive 侧（实际） | 结论 |
|---|---|---|
| 影响哪些分系统：bash-extract 单一分系统；decision/policy-core/extension-orchestration 不受影响 | 实际影响：bash-extract（tier-medium）单一分系统——`analyzeCd` 条件 3 逐 stage 化 + `parse.ts` 的 `isAmpBackgroundSeparator` + `i18n.ts` 文案 + `bash-extract.test.ts` 断言。decision/policy-core/extension-orchestration 零改动（git diff 确认无涉）。parse.ts 亦属 bash-extract 子系统，不改变分系统边界结论 | ✅ 一致 |
| 整体性能预期变化：无性能变化，复杂度不变量级 | 实际：无性能变化。逐 stage 检查复用既有 `tokenize`/`collectStagePathRefs`/`splitPipelines`，判定仍是纯函数静态分析，复杂度不变量级 | ✅ 一致 |
| 局部优化还是全局协调：局部放宽，与全局协调一致 | 实际：局部放宽（cd 链豁免的管道边界），与全局协调一致——全局安全不变量「cwd 漂移下的相对路径引用必须可静态解析或判不可靠」保持完整 | ✅ 一致 |
| 局部优化对全局失调的风险：低，由逐 stage 化条件 4~11 排除 | 实际：低，已逐项验证——裸词（`sort sub \| wc -l`）、cwd 锚点（`wc -l . \| head`）、glob（`ls *.md \| wc`）、git 写子命令非首 stage（`git log \| git rm`）、转发器（`cat \| xargs rm`→forwarding_command）全部维持兜底；安全红线 `cd /etc && rm -rf .`、`cd /etc && echo x > sub`、`;` 分隔相对重定向仍 cd_chdir（CDC-PIPE-03~08 + 6.2 边界 D1/D2 全绿） | ✅ 一致 |
| 预期行为模型：`cd <绝对> && <零路径引用纯 stdin 管道>` → 静默放行；`cd <绝对> && <含相对/裸词/锚点/glob/转发器管道>` → 弹窗 | 实际：**模型已验证**——动机案例 `cd /proj && npm test 2>&1 \| tail -25` → reliable:true + 0 target；反例全部 cd_chdir/forwarding_command；B3 外区写 → prompt。验证数据 CDC-PIPE-01~09（9 断言，超预期 ≥6）+ 全量 794/794（超预期 701+ 无回归） | ✅ 模型成立 |

**预期之外的副作用**：实施中发现并修复 `parse.ts` `splitCommands` 对 `2>&1`（fd-dup）误拆的既有 bug——`["cmd 2>", "1"]`，把 `&` 当后台分隔符。该行为违反既有 baseline 契约「管道按 stage 独立提取」的 `N>&N` 例外（spec.md 已声明，`:199-201`），本 change 放宽条件 3 后暴露，经新增 `isAmpBackgroundSeparator`（判 `&>`/`& >`/`N>&N`/`N>&-` 非后台分隔符）修复。这是使实现更符合既有契约的**正向修复**，非行为模型偏差；已记入 T3 验证注记。

**scenario→test 覆盖账本**：本 change 未产出显式账本（proposal 未要求），但 CDC-PIPE-01~09 覆盖全部新增 scenario（动机案例、相对路径管道、裸词/锚点/glob/git 写/转发器反例、cd 片段自含管道、D2b 管道混合 stage）+ 既有 2 处预期行为变化断言（BTP-audit-102 / BMG-CD-pipeline-reject），无 N/A 条目。

**baseline 契约核对**：`openspec show --diff` 显示本 change 对主 spec 的真实变更行仅为条件 3（无管道→管道逐 stage 路径安全）+ 相关 scenario，条件 1/2/4~11 与 D2b 均未被触碰；baseline 声明的契约 / 不变量（含 `N>&N` 例外、`cwd 锚点排除`、`glob 排除`、`git 写子命令排除`）保持完整，无契约破坏。
