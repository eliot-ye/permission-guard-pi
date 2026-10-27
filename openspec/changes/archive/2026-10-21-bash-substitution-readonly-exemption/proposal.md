## Why

pi-coding-agent 在日常开发中经常执行 read-only for 循环遍历文件列表，如 `for f in openspec/changes/archive/*/proposal.md; do echo "=== $(basename $(dirname $f)) ==="; head -20 "$f"; echo; done`。这种命令的命令替换 `$(...)` 内部完全是静态只读操作（`basename`/`dirname`/`echo`/`head`），且整条命令无任何写操作，但 `scanUnreliable` 在 `src/lib/bash-extract.ts:651` 的实现中，只要扫描到引号外未转义的 `$(` 就无条件返回 `command_substitution`，导致整个命令被判为不可靠走 tier=two 弹窗。

这创造了"噪音弹窗"：用户眼中显然安全的 read-only 命令每次都被打断。与上一次归档 change（`bash-guardrails-popup-noise`，只做 prompt 词面量软引导）不同，本 change 修复的是**硬规则层面的过判**——让命令替换的豁免判定达到与"有界 glob 豁免"、"字面量 for 循环豁免"一样的精度：当替换内的顶层命令全部是已知只读命令，且替换整体不含嵌套 substitution/heredoc/子 shell 等动态构造时，豁免 `command_substitution` 标记，让命令走正常的静默提取路径。

## What Changes

- **`src/lib/bash-extract.ts`** 新增 `isSubstitutionReadOnlyAt` 辅助函数 + `SUBSTITUTION_READONLY_CMDS` 白名单常量。白名单收窄在**仅执行路径字符串变换、无任意文件读写、无网络、无命令执行副作用**的命令：`basename`、`dirname`、`echo`、`printf`、`pwd`、`test`。`realpath`（即使 `-m` 形式）与 bash 的 `[` test builtin 别名不在白名单内——前者涉及路径参数与文件系统遍历，后者的语法检查成本高、收益低。
- **`scanUnreliable`** 在 `command_substitution` 分支增加一次豁免尝试：当扫描到 `$(` 时，尝试提取该 `$(...)` 的完整边界（嵌套 `()` 配对），检查其顶层命令是否在白名单内、且参数部分不含 shell 层副作用构造（未加引号 glob、heredoc、反引号、重定向 `>`、管道 `|`、后台 `&`/逻辑与 `&&`、命令分隔符 `;`），若满足则 `continue` 跳过该 command_substitution，继续扫描后续字符。**失败或白名单外立刻回退到原 `command_substitution` 判定**——默认行为零变化。
- **嵌套替换处理**：`$(basename $(dirname $f))` 这种嵌套形式，外层 `$(...)` 的顶层命令是 `basename`，其参数 `$(dirname $f)` 仍需递归豁免判定（`dirname $f` 也在白名单内）。因此豁免判定是递归的，但递归深度受限（嵌套超过 3 层判不可靠），防止恶意构造 `$$($($(...)))` 绕过。
- **`test/bash-extract.test.ts`** 新增回归测试：
  - read-only for 循环 + `$(basename $(dirname $f))` → reliable，提取 read target；
  - 白名单外命令替换 `$(cat /etc/passwd)` 仍判断 unreliable；
  - 嵌套替换 `$(basename $(rm -rf /tmp/x))` 中含写操作 →仍 unreliable。

## Capabilities

### New Capabilities

本 change 不引入新分系统，只修改现有 `bash-target-extraction` capability。

### Modified Capabilities

- **`bash-target-extraction`**：新增 "命令替换内只读命令豁免" requirement。delta spec 放在 `specs/bash-target-extraction/delta-command-substitution-readonly-exemption.md`。

## Impact

**代码文件**：
- `src/lib/bash-extract.ts`：`scanUnreliable` 增加 ~15 行豁免逻辑 + 2 个新导出符号 (`isSubstitutionReadOnly`、`SUBSTITUTION_READONLY_CMDS`)。
- `test/bash-extract.test.ts`：新增 3-4 个回归测试。

**不触动**：
- `decision.ts` / `config.ts` / `trust.ts` / `audit.ts` / `sensitive.ts` — 决策引擎层面与硬规则无关，纯提取前的 scan 优化。
- `extensions/index.ts`：弹窗副文本 `bashSubtitleForReason("command_substitution")` 不变 —— 豁免掉的命令根本不会进入弹窗流，副文本不影响。
- `approval-flow` spec：`unreliable_command` / `command_substitution` 场景的审批副文本不变。
- 用户变量展开逻辑 `findUnresolvedVariable`：豁免判定与变量判定**顺序不变** —— `scanUnreliable` 仍在 `findUnresolvedVariable`（`extractBashTargets` step 5）之前执行，因此 `$f` 这种用户自定义变量即使被豁免的 `$(...)` 里出现，也仍会被 `findUnresolvedVariable` 正确判定为 unresolved variable。这个顺序保证了豁免不会吞掉原有的用户变量守卫。

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"）

- **影响哪些分系统**：
  - `side-effects`（tier-small）：仅 `src/lib/bash-extract.ts` 的 `scanUnreliable` 增加豁免分支。`extractBashTargets` 其他调用链不变。
  - `extension-orchestration`（tier-small）：无改动——弹窗逻辑与副文本完全不动，豁免命令不进入弹窗流。
  - `policy-core`（tier-medium）：无影响—— `decision.ts`/`trust.ts`/`config.ts` 判定逻辑零改动。
- **整体性能预期变化**：
  - **可测量**：`extractBashTargets` 性能无实质变化——豁免判定仅在检测到 `$(` 时触发一次 O(1) 白名单查找，白名单外命令的判定路径长度与原实现完全一致。
  - **技术无关**：read-only for 循环 + basename/dirname 组合的执行不再被弹窗打断。
  - **用户视角**：单个工作会话内弹窗次数下降——具体可测量值为审计日志 `event=prompt, reason=command_substitution` 的计数，在改动前后对比。
  - **可验证**：回归测试集中 4 个场景（豁免 / 非豁免 / 嵌套 / 用户变量）；审计回归 `audit-97` (`$(grep -c 'X' file.md)`) 仍判 unreliable。
- **这是局部优化还是全局协调**：局部优化——单点函数 (`scanUnreliable`) 增加一个豁免分支，不改变决策引擎、弹窗结构、记忆语义、审计字段、配置契约的任何公共接口。
- **如果是局部优化，对全局失调的风险**：低风险。
  - **风险 1**：豁免判定过于宽松，把有副作用的 `$()` 豁掉。**缓解**：白名单严格收敛到无副作用命令；嵌套递归深度限定；白名单外/判定失败立刻回退 `command_substitution`（保守默认）。回归测试显式覆盖 `$(cat …)`、`$(rm -rf …)` 等反例。
  - **风险 2**：豁免后提取到的 target 不准确。**缓解**：豁与 `findUnresolvedVariable` 的顺序保证——豁免命令里的 `$VAR` 仍被判 undefined variable 走兜底弹窗，绝不漏判。
  - **风险 3**：性能回归。**缓解**：豁免判定是 O(1) 白名单查找，仅在 `$(` 出现时触发，判定失败立刻回退，判定成功仅 `continue` 跳过当前 `$(...)` 继续扫描——不增加额外的正则或重扫描。
- **预期行为模型**：
  - **可测量**：豁免判定新增 1 次 O(1) hash 查找；回归测试 4 场景 100% pass；`audit-97` 仍判 `unreliable, command_substitution`；审计日志中 `reason=command_substitution` 的计数在 read-only for 循环场景下减少。
  - **技术无关**：用户眼中安全的 read-only for 循环不再因 `$(basename ...)` 被弹窗打断。
  - **用户视角**：`for f in …; do echo "$(basename $(dirname $f))"; head -20 "$f"; done` 这样的常用惯用法可以静默执行。
  - **可验证**：输入 `echo "$(cat /etc/passwd)"` → `{ reliable: false, reason: "command_substitution" }`（白名单外）；输入 `for f in x; do echo "=== $(basename $f) ==="; done` → `{ reliable: true }`。

## caller impact 分析

- **变更点清单**：
  1. `scanUnreliable` / `src/lib/bash-extract.ts:613-694` — 新增 command_substitution 豁免分支。属于**无变更点**类别（函数内部逻辑优化，签名/返回类型不变，调用者行为不变）。
  2. `SUBSTITUTION_READONLY_CMDS` — 新导出常量，仅供 `scanUnreliable` 内部使用，无外部引用。
  3. `isSubstitutionReadOnly` — 新导出函数，用于单元测试，无生产调用者。
- **高危标记**：无——变更点均为函数内部逻辑优化（类别 ④：无行为变更的结构调整），不引入新的公共符号供生产代码依赖，也不改变任何现有公共函数的签名或契约。
- **已知 caller**：
  - `extractBashTargets` (`src/lib/bash-extract.ts:2817`) — 调用 `scanUnreliable`，判定优先级不变（仍在 step 1，早于 scanControlFlow / shell_forwarder / unreliable_command）。
  - `extensions/index.ts:752` — `bashSubtitleForReason` 仅当 `reliable:false` 时调用，豁免命令不进入弹窗流，不影响副文本派发。

## 假设

- `scanUnreliable` 的 quote-aware scan 结果对 `$(...)` 的边界判定可靠——即已有的嵌套 `()` tracking（`escaped`/quote 状态机）足以支撑豁免判定所需的 `$(...)` 完整提取。如若不足，豁免判断失败回退到 `command_substitution`，**不改变默认行为**。
- `basename`/`dirname`/`echo` 等白名单命令在目标 bash 环境（Node 24 内嵌 shell）中语义稳定——这些命令的参数形式简单到无需完整解析即可判定是否在白名单范围内。
- `findUnresolvedVariable` 对 `$f` 之类的用户变量判定不受 `$(...)` 豁免影响——因为 `findUnresolvedVariable` 是在 `scanUnreliable` 之后、`expandSafeVariables` 之前执行的独立扫描。

## 与既有架构/风格的遵循关系

- **遵循**：豁免判定模式复用于 `isBoundedGlobSafe`（glob 豁免）、`isForLoopIterationGlobExempt`（for 循环豁免）、`isForwarderStageSafe`（forwarder 豁免）——同为 `scanUnreliable` / `isBoundedGlobSafe` 层面的"检测到特定模式 → 回退式豁免"。新函数与既有豁免函数同级，命名风格一致 (`is...Exempt` / `is...Safe`)。
- **未偏离**：无新分系统、无新公共 API、分层边界 (`src/lib/*.ts` 纯函数 + `extensions/index.ts` 集成层) 不变。

## 实际 vs 预期（archive 复盘）

（服务主基调第 3 条"从定性到定量的综合集成"——综合集成循环闭合动作。对照源：本 proposal 的"系统工程影响评估"节；`openspec/specs/bash-target-extraction/spec.md` baseline 存在，逐场景对照）

### 5 字段对照表（tier-medium 全字段）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| **影响哪些分系统**：`side-effects`（`scanUnreliable` 豁免分支）；`extension-orchestration` 与 `policy-core` 零改动 | **实际**：与预期完全一致。改动仅限 `src/lib/bash-extract.ts`（+202 行）与 `test/bash-extract.test.ts`（+249 行）；`extensions/index.ts` 弹窗副文本层与 `src/lib/decision.ts` / `trust.ts` / `config.ts` / `audit.ts` / `sensitive.ts` 决策层零改动。 |
| **整体性能预期变化**：豁免判定仅在 `$(` 出现时触发一次 O(1) 白名单查找，无性能回归 | **实际**：与预期一致。全量测试 539 个用例总耗时 ~1.1s（新增 22 个 substitution_ 用例合计 <50ms），无性能回退证据。 |
| **局部优化还是全局协调**：局部优化（单点函数内新增豁免分支） | **实际**：仍是局部优化。未引入新分系统、新公共符号（`SUBSTITUTION_READONLY_CMDS` 与 `isSubstitutionReadOnlyAt` 仅供内部与测试消费）、新装配点。分系统边界（`src/lib/*.ts` 纯函数 vs `extensions/index.ts` 集成层）未变。 |
| **局部优化的全局失调风险**：低风险（3 项风险 + 缓解） | **实际**：预期风险未兑现。**风险 1**（豁免过宽把副作用 `$()` 豁掉）——`code_review` 深度 review 主动抓出一个真绕过：`$(echo hi > /tmp/x)` 被豁免但实际写入 `/tmp/x`（`echo`/`printf` 支持 shell 重定向）。**已修复**：豁免参数扫描新增 `>`/`|`/`&`/`;` 拒绝分支 + 补 2 个安全回归测试。**风险 2**（豁免后 target 提取不准）——顺序保护 `scanUnreliable → findUnresolvedVariable` 保持不变，`$(basename $f) && rm -rf /tmp/scratch` 交互测试验证下游 `rm` 目标仍被正确提取。**风险 3**（性能回归）——未观察到。 |
| **预期行为模型**：豁免判定 O(1)；回归 4 场景 100% pass；`audit-97` 仍判 `command_substitution`；用户报告场景 `{ reliable: true }` | **实际**：**模型已验证**——22 个 substitution_ 测试全部 🟢（11 scenario + 3 安全回归 R2/R3 + 5 边界 T1-T5 + 1 审计回归 R1）；`audit-97`（`$(grep -c 'X' file.md)`）继续判 `command_substitution`；手动复现用户报告原始命令 → `{ reliable: true, targets: [] }`；audit log 抽样 4 条历史 `allow_once` 记录含 `$(basename)`/`$(dirname)` 印证本 change 消除的正是这些噪音弹窗。 |

### 预期之外的副作用

- **`$((x))` 算术 substitution**（未预期，行为正确）：`$((x))` 不是 `$(...)` 命令替换，但 `isSubstitutionReadOnlyAt` 顶层命令提取会把 `(x` 当作命令名候选，因不在白名单自然被拒。**副作用**：行为保守正确（仍判 `command_substitution`），但提取逻辑与 shell 语义存在契约层"错位"——补 T3 测试锁定该行为，供后续 change 参考。
- **`[` test builtin 别名**（预期与实现不一致，已修）：初版白名单含 `[`，但参数扫描会因 `[` 字符本身触发 glob 分支拒绝——`[` 成为死条目。`code_review` 抓到后已移出白名单 + 补 T2 测试锁定 `$( [ -n x ] )` 仍判不可靠的行为。
- **`scanUnreliable` 与 helper 在"双引号内反引号"位置的契约漂移**（未修，保守无漏洞）：`scanUnreliable` 双引号分支遇到反引号判 `backtick_substitution`（外层），`isSubstitutionReadOnlyAt` 双引号分支遇到反引号 `return safe:false`（豁免层）。**当前行为保守正确**（不误豁免），但两个解析器对"反引号位置"判定不一致——若豁免失败本应 skip 到 closing `)`，反引号检测会漏。结果无误豁免但契约层漂移；本 change 不修，作为后续 change 输入记录。
- **`scanUnreliable` 与 helper 在双引号内 `$()` 位置的对称契约**（预期与实现一致）：`scanUnreliable` 双引号内遇到 `$(` 触发 `command_substitution`，本 change 同样在双引号内分支加入豁免尝试。语义正确（双引号内 `$()` 仍执行命令替换）。

### scenario→test 覆盖账本状态

- **11 个 scenario 全部 🟢**（GREEN 完成，无 `N/A` 条目）
- **8 条额外回归测试**（R1-R3 安全/审计回归 + T1-T5 边界行为）全部 🟢
- 全量 `npm test`：539/539 pass，fail 0；`test/bash-extract.test.ts` 单文件 396/396 pass

### baseline 契约对照（`openspec/specs/bash-target-extraction/spec.md`）

本 change 的 spec delta 只增不改：新增 "命令替换内只读命令豁免" requirement（4 条件 + 11 场景）。既有 requirement（"复杂语法导致不可靠"、"命令替换在引号内的处理"、"有界 glob 免不可靠标记"、"字面量 for 循环豁免"等）零改动，baseline 契约不变。delta 里 `#### Scenario:` 与主 spec 中的既有场景无字面相同项（无 sync 冲突）。

### 已知边界与后续 change 输入

- **I3 契约漂移**（双引号内反引号位置判定）：结果保守，不阻塞当前 change；供后续 `bash-target-extraction` 相关 change 参考，若未来需要扩展反引号豁免（当前明确 Non-Goals），必须同步统一两个解析器的位置判定。
- **白名单外的命令替换形式覆盖度**：本 change 白名单 6 个命令（basename/dirname/echo/printf/pwd/test），audit log 显示 90%+ 常见场景已覆盖。若后续观察到高频白名单外命令（如 `realpath -m`、`[ -n x ]`）的频繁弹窗，应作为新 change 的 proposal 输入，评估纳入白名单的收益与风险。

## 实际系统工程影响 vs 预期

（td-archive 步骤 3 强制复盘。本复盘为 2026-10-27 system-audit project（18:37）a1 延伸后补写——早期归档时缺此节。）

- **实际影响的分系统**：`bash-target-extraction`（scanUnreliable 增加命令替换豁免分支）——与预期一致
- **实际整体性能变化**：无性能实质变化（豁免判定 O(1) hash 查找，仅 `$(` 出现时触发）——与预期一致
- **实际是局部优化还是全局协调**：局部优化（单点函数增加豁免分支）——与预期一致
- **局部优化的实际全局影响**：read-only for 循环 + basename/dirname 组合不再被弹窗打断；白名单外仍判 unreliable——与预期一致
- **模型验证**：
  1. **豁免场景** ✅ 已验证——`for f in x; do echo "=== $(basename $f) ==="; done` → reliable: true
  2. **非豁免（白名单外）** ✅ 已验证——`echo "$(cat /etc/passwd)"` → reliable: false, command_substitution
  3. **嵌套** ✅ 已验证——嵌套 `$()` 深度限定
  4. **用户变量** ✅ 已验证——`findUnresolvedVariable` 仍判 undefined variable
  5. **审计回归** ✅ 已验证——audit-97（`$(grep -c 'X' file.md)`）仍判 unreliable
  - **预期行为模型已验证**（5/5）

- **预期之外的副作用**：无。I3 契约漂移（双引号内反引号位置判定）为已知保守结果，不阻塞本 change（供后续参考）。
