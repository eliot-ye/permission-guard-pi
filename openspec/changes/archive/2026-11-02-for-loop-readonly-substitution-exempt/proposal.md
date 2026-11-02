# Proposal: for-loop-readonly-substitution-exempt

## Why

只读 for 循环统计命令（如 `for f in openspec/specs/*/spec.md; do n=$(grep -c '^### Requirement:' "$f"); ...; done`）误报 `glob_expansion` 弹窗——用户全程只读的命令被权限守卫打断。根因两层叠加：

1. `isForBodyReadOnly`（`src/lib/bash-extract/silent.ts:926`）不识别变量赋值形态：`n=$(grep -c ...)` 经 tokenize 后 `tokens[0]` 是 `n=$(grep`（赋值+替换是单个 token），不是合法命令名 → 判 body 非只读 → `isForLoopIterationGlobExempt`（`readonly.ts:306`）失败 → 迭代集 glob 落入 `glob_expansion`。
2. 即使修了赋值层，body 内 `$(grep -c ...)` 仍触发 `command_substitution`——`SUBSTITUTION_READONLY_CMDS`（`scan.ts:85`）刻意不含 grep/cat/head/tail（`readonly.ts:476-490` 注释：豁免顶层 `$(grep /etc/passwd)` 会成 silent no-op，绕过授权）。

只修第一层不够：修完用户命令会暴露第二层 `command_substitution` 仍弹窗。本 change 双层一起修。

## What Changes

- **第一层**：`isForBodyReadOnly`（`silent.ts`）识别 `VAR=...` 赋值形态——右侧纯字面量（`n=5`）视为只读；右侧含 `$()` 时走第二层替换豁免检查。
- **第二层**：新增 for-body 迭代变量绑定的命令替换窄豁免——`$()` 内部命令 ∈ 只读命令集（grep/cat/head/tail/wc 等扩展），且 `$()` 内所有文件路径参数必须静态绑定（for 迭代变量 `$f` 且迭代集 bounded，或项目内字面路径），才豁免 `command_substitution`。
- **fail-closed 判据**：`$(rm "$f")`、`$(grep "$f" /etc/passwd)`、`$(grep "$f" $OTHER)`（未绑定变量）、顶层 `$(grep /etc/passwd)`（无 for 上下文）、`for f in /etc/*` 迭代——全保持拒绝。
- 涉及文件：`src/lib/bash-extract/silent.ts`（赋值识别）+ `src/lib/bash-extract/readonly.ts`（绑定豁免）+ `src/lib/bash-extract/scan.ts`（替换豁免路径）；`test/bash-extract.test.ts` 补正反例。

## Capabilities

### New Capabilities

无（本 change 修改既有能力，不引入新 capability 路径）。

### Modified Capabilities

- `bash-target-extraction`: 修改「复杂语法导致不可靠」requirement 的 `command_substitution` 反例边界（新增 for-body 迭代变量绑定豁免），以及「有界 glob 免不可靠标记」requirement 的 for 循环体只读判定（接受赋值形态）。

## Impact

- **代码**：`src/lib/bash-extract/silent.ts`、`src/lib/bash-extract/readonly.ts`、`src/lib/bash-extract/scan.ts`；测试 `test/bash-extract.test.ts`。
- **公共契约**：无——`bash-target-extraction` spec 的 requirement 文本有行为边界修改，但无 `ExtractResult` 类型变更、无 wire 结构变化、无授权语义放宽（只在窄上下文内放行只读替换）。
- **依赖**：无新增依赖。
- **系统**：仅 `bash-extract` 子系统（tier-medium）内部；不触碰 policy-core、extension-orchestration、audit。

## 系统工程影响评估

- **影响哪些分系统**：仅 `bash-extract`（tier-medium 子系统）内部——`silent.ts`（`isForBodyReadOnly`）+ `readonly.ts`（`isForLoopIterationGlobExempt` / 新增绑定豁免）+ `scan.ts`（`scanUnreliable` 替换豁免路径）。不触碰 policy-core（decision/config/trust）、extension-orchestration、audit；无公共契约变更、无 wire 结构变化。
- **整体性能预期变化**：零运行时性能影响（纯静态分析，豁免只减少弹窗，不改变提取目标集）。用户可观察行为：原先因 `glob_expansion` 弹窗打断的只读 for 循环统计命令，现在自动放行；仍弹窗的写操作命令（`$(rm "$f")` 等）行为不变。
- **这是局部优化还是全局协调**：局部优化（减少误报弹窗）。
- **如果是局部优化，对全局失调的风险**：豁免面写太宽会让 `command_substitution` 的安全边界失守（顶层 `$(grep /etc/passwd)` silent no-op 绕过授权）。风险由 fail-closed 判据控制：`$f` 必须绑定 bounded 迭代集、`$()` 内命令只读、无 for 上下文仍拒绝。不全局放宽，属窄条件豁免。
- **预期行为模型**：输入 `for f in openspec/specs/*/spec.md; do n=$(grep -c '^### Requirement:' "$f"); echo "$n"; done`（projectRoot 内、迭代集 bounded、body 只读赋值+替换）→ 预期输出 `reliable: true`，不触发弹窗。验证：新增正例测试断言 `extractBashTargets` 返回 `reliable: true`；反例测试断言 `$(rm "$f")`、`$(grep "$f" /etc/passwd)`、顶层 `$(grep /etc/passwd)` 仍返回 `reliable: false`。既有 700+ 测试全绿。
- **与既有架构/风格的遵循关系**：遵循既有架构——纯函数模块（无 UI/IO）、fail-closed 保守判定、窄条件豁免（对齐既有 `isForLoopIterationGlobExempt` 的窄豁免风格）。不偏离既有架构或风格，无重构。

## caller impact 分析

- **变更点清单**：
  - `isForBodyReadOnly`（`silent.ts:926`）——模块级内部函数（导出但仅同子系统内消费），签名可能从 `(body: string)` 扩展为 `(body, forCtx, projectRoot?)`。类别：**无四类变更点**（不改变公共 API 签名、不改变装配点、不改变错误契约、不改变数据契约；模块级内部函数签名调整，调用方同子系统内且同步适配，见下）。
  - `isForLoopIterationGlobExempt`（`readonly.ts:306`）——导出但仅被 `scan.ts` 消费（同子系统内部），签名不变。类别：无四类变更点（行为收窄放宽，非契约变更）。
  - `scan.ts` `scanUnreliable` 的替换豁免路径——内部逻辑，无公共符号变更。类别：无四类变更点。
- **高危标记**：无——不涉及公共符号 / 装配点变更。全部为子系统内部行为扩展。
- **已知 caller**：
  - `isForBodyReadOnly` 被 `readonly.ts`（`isForLoopIterationGlobExempt`，`readonly.ts:7` import）与 `control-flow.ts`（`control-flow.ts:6` import，字面量 for 豁免路径）消费——**两个真实调用方**。若签名扩展为 `(body, forCtx, projectRoot?)`，两处调用点需同步适配；`control-flow.ts` 的字面量 for 豁免路径会受 D1 赋值识别变更影响（`for f in a b c; do n=$(grep "$f"); done` 形态从判不可靠变为按只读处理，行为变更属设计内，需同步确认）。预判：兼容（同子系统内部，签名扩展 + 调用点同步适配，不破坏公共契约）。
  - `isForLoopIterationGlobExempt` 仅被 `scan.ts` 消费。预判：兼容（签名不变）。

**判断依据**：本 change 所有变更都是既有函数内部的行为扩展（识别新形态 + 新增窄豁免），不改变任何**公共契约**签名（`ExtractResult`、授权决策入口、导出到 `extensions/index.ts` 的 barrel 接口均不变）、不改变装配点、不改变错误/数据契约。模块级内部函数签名可能扩展（`isForBodyReadOnly`），调用方同子系统内（`readonly.ts` + `control-flow.ts`）且同步适配，不构成公共契约变更。故无四类变更点。

## 实际系统工程影响 vs 预期

> 归档复盘节（td-archive 步骤 3 强制，tier-medium 全部 5 字段）。对照 proposal「系统工程影响评估」节 + 主 spec baseline delta（`openspec show --diff`，CLI 1.12.0 ≥ 1.11）。

| proposal 侧（预期） | archive 侧（实际） | 复盘结论 |
|---|---|---|
| 影响哪些分系统：仅 `bash-extract` 内部（`silent.ts` + `readonly.ts` + `scan.ts`） | 实际影响：`bash-extract` 内部——`silent.ts` + `readonly.ts` + `scan.ts` **+ `control-flow.ts`**（为复用 for 结构解析 + off-by-one 修复实际触及） | **基本一致 + 一处补充**：实际额外触及 `control-flow.ts`（`parseGlobForLoop`/`isLiteralForLoop`/`scanControlFlow`/`isGlobForLoopExempt` 的行为扩展 + `collectBodyAssignments` 新导出 + off-by-one 修复）——同属 bash-extract 子系统内部，无跨分系统影响，不违反「不触碰 policy-core/extension-orchestration/audit」边界 |
| 整体性能预期变化：零运行时性能影响（纯静态分析，豁免只减少弹窗） | 实际整体性能变化：零运行时性能影响（静态分析逻辑扩展，无 IO/无运行时开销）；全量测试 921/921 绿，`tsc --noEmit` 通过 | 符合 |
| 这是局部优化还是全局协调：局部优化（减少误报弹窗） | 实际是局部优化（只读 for 统计命令不再误报弹窗） | 符合 |
| 如果是局部优化，对全局失调的风险：豁免面写太宽会让 `command_substitution` 安全边界失守（顶层 `$(grep /etc/passwd)` silent no-op 绕过授权）；由 fail-closed 判据控制 | 局部优化的实际全局影响：fail-closed 守住——顶层 `$(grep /etc/passwd)`/`$(cat /etc/passwd)`、for 写 body、glob 出界、`..` 越界均保持 `reliable: false`（BT-FSUB-4/5/6/7/8/9/12/13 + 系统级验证）；**收尾 review 发现并修复一处 B2 逃逸**（`x/../../etc/passwd` 因 `looksLikePath=false` 跳过 bounded 检查，见模型验证） | 符合（逃逸已在归档前修复并固化，无残留全局失调） |
| 预期行为模型：`for f in openspec/specs/*/spec.md; do n=$(grep -c '^### Requirement:' "$f"); echo "$n"; done` → `reliable: true`；反例（`$(rm "$f")`、`$(grep "$f" /etc/passwd)`、顶层 `$(grep /etc/passwd)`）→ `reliable: false` | 模型验证：**预期行为模型已验证**——正例 `reliable: true`（BT-FSUB-1 + 系统级用户命令 `reliable: true`），全部反例 `reliable: false` 且 reason 符合预期。**偏差记录（作为下一个 propose 的预测模型修正）**：(1) 预期模型未覆盖"系统级完整命令形态"（`&&` 链 + for + 赋值 + `$(basename $(dirname))`），系统级验证暴露既有 off-by-one（`done` 后有尾随 `&&` 时 `parseGlobForLoop`/`isLiteralForLoop` 的 `doneEnd` 偏 +1，body 多含 `done` 首字符导致误判）——已修复（`doneEnd = i` 统一语义）+ 固化 BT-FSUB-10；(2) 预期模型未覆盖双引号内 for-body 绑定 `$()` 形态（`echo "$(grep "$f")"`），系统级验证暴露引号内外 B1-B4 不一致——已修复 + 固化 BT-FSUB-11/12；(3) 预期模型未覆盖 `..` 越界路径参数（`x/../../etc/passwd`），收尾 review 暴露 B2 仅当 `looksLikePath(arg)` 时检查的漏判——已修复（B2 无条件 `hasDotDotSegment`）+ 固化 BT-FSUB-13。**模型修正建议**：B2 路径参数绑定检查不应依赖 `looksLikePath` 门控，应无条件检查 `..` 越界段 | 验证通过 + 3 处偏差（均修复并固化，作为预测模型修正记录） |

**预期之外的副作用（后续 `/td-system-audit` 输入）**：

1. **`control-flow.ts` 实际触及**（proposal 影响评估未列）：为复用既有 for 结构解析（`parseGlobForLoop` 返回字段扩展 `doPos`/`doneStart`/`iterWords`，向后兼容）+ 字面量豁免路径同步适配（`isLiteralForLoop` 加 `projectRoot?` 参数）+ `collectBodyAssignments` 新导出 + off-by-one 修复。均同子系统内部行为扩展，无跨分系统影响，但属预期文件清单之外的改动——已记录。
2. **既有 off-by-one 修复**（`parseGlobForLoop`/`isLiteralForLoop` 的 `doneEnd = i + 1` → `doneEnd = i`）：非本 change 引入的既有 bug，被系统级验证（用户完整命令形态）暴露——修复属 bug fix，不属本 change 的窄豁免设计范围，但为达成「用户命令不再误报」目标所必需。
3. **主 spec 溯源注释修正**（`本 change 新增` → `前序 change 引入`，多处）：前序 change 已归档，delta 中的 provenance 标注需修正溯源——非行为性文档修正。

**scenario→test 覆盖账本状态**：`applyRequires` 不含 `specs`（只含 `tasks`），本 change 未产出 scenario→test 账本——N/A。
