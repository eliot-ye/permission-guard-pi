## Context

`scanUnreliable` (`src/lib/bash-extract.ts:613-694`) 是一次 quote-aware 单遍字符扫描，遇到 `$(` 立刻返回 `command_substitution`。这一"一票否决"策略是**正确的保守默认**——命令替换可能执行任意命令，静态分析无法预测实际访问的文件集。

但现有代码库已经通过三次豁免（`isBoundedGlobSafe` glob 豁免、`isForLoopIterationGlobExempt` for 循环豁免、`isForwarderStageSafe` 转发器豁免）证明了一个更精细的策略：**检测到特定语法模式 → 尝试结构化豁免判定 → 失败立即回退原判定**。豁免判定必须做到：

- 白名单准入（不是黑名单逃生）
- 失败回退路径零变化
- 不改变 `scanUnreliable` 的调用点、返回值或后续 guardrail 顺序

**约束**：豁免判定必须能在**单遍扫描的当前位置**完成——不能重扫命令、不能引入 O(n²) 递归、不能依赖外层 `splitCommands`/`splitPipelines` 的下游解析。

## Goals / Non-Goals

**Goals:**

- 让 `$(basename ...)` / `$(dirname ...)` / `$(pwd)` / `$(echo ...)` / `$(printf ...)` 这类纯路径/字符串变换的命令替换不再触发 `command_substitution` 弹窗
- 嵌套形式 `$(basename $(dirname $f))` 通过递归判定豁免
- 白名单外的形式（`$(cat …)`、`$(rm -rf …)`、`$(grep …)`）**保持原判定完全不变**——零行为放宽
- 豁免失败立即回退到 `command_substitution`，不短路任何其他 unreliable 检测（heredoc / backtick / subshell / glob）与后续 guardrail（`scanControlFlow` / `isShellForwarder` / `isAnyUnreliableCommand` / `findUnresolvedVariable`）

**Non-Goals:**

- 不覆盖反引号 `` `...` `` 豁免——反引号是命令替换的旧形式，语义完全等价，本 change 保持"反引号一律不可靠"的原判定
- 不豁免含网络/子进程/文件系统遍历副作用的命令（`realpath -f`、`readlink -f`、`cd`）——这些命令即使参数只读也可能触发文件系统访问
- 不修改弹窗副文本 `bashSubtitleForReason("command_substitution")`——豁免命令根本不进入弹窗流，副文本不影响
- 不处理 heredoc `<<`、process substitution `<(...)`/`>(...)`、子 shell `(...)` 的豁免——它们属于不同的 requirement
- 不引入 bash AST 库依赖——遵守 project 的"不引入 wasm/native 依赖"约定

## Decisions

### D1: 白名单收敛在 `basename` / `dirname` / `echo` / `printf` / `pwd` / `test` / `[`

**选择**：初始白名单只放 7 个命令：`basename`、`dirname`、`echo`、`printf`、`pwd`、`test`、`[`。

**替代方案对比**：

- **A（拒绝方案）**：只放 `basename`/`dirname`（极窄）——覆盖当前实际 case 但过窄，用户日常用 `$(pwd)`/`$(echo ...)` 也会继续被弹窗
- **B（拒绝方案）**：`isReadOnlyWithArgs` 分类器准入——把 `cat`/`head`/`tail`/`grep` 等 read-only 命令纳入，但这些命令可能读取任意文件（`$(cat /etc/passwd)`），豁免后提取器无法从 `$()` 输出推断路径 target，反而**制造更严重的静默漏洞**：原本弹窗的命令被"静默放行"却**没有提取任何 target**
- **C（采纳方案）**：只放"输出路径字符串或空值"的命令——`basename`/`dirname` 从路径字符串算 basename/dirname；`echo`/`printf` 是纯 stdout；`pwd` 是当前目录；`test`/`[` 是条件判断。这些命令的**输出**都是已知的字面量或从参数纯字符串变换得来，静态可预测

**为什么 `realpath` 不在白名单**：`realpath -m` 是纯字符串变换，但 `realpath -f`/`realpath -e` 会触发文件系统访问；参数形式区分成本高且易漏。第一次纳入后容易通过 audit 发现副作用形式，风险不值得。**决策**：本次豁免不覆盖 `realpath`，待观察实际使用场景后再单独评估。

**为什么 `test`/`[` 在白名单**：`test -f foo` / `test -e foo` 这类查询命令无副作用；`[` 是 `test` 的别名。允许它们在 `$()` 内（如 `$(test -f "$f" && echo "exists")`）——虽然本 change 不处理 `&&`/`||` 的复合形式，但 `test`/`[` 独立调用是安全的。

**为什么 `echo`/`printf` 在白名单**：这两个命令是纯 stdout 输出，本身无副作用。参数允许字面量字符串、允许的 printf 格式串（`%s`/`%d` 等）。**限制**：`printf "%b\n"` 允许 `%b` 但值不能含命令替换；`printf "%s\n"` 允许字面量值但不能含嵌套 `$(...)` 除非通过递归豁免。

### D2: 豁免判定位置在 `scanUnreliable` 的 `$(` 分支内，就地递归

**选择**：在 `scanUnreliable` 的现有 `$(` 检测分支内联一次豁免判定——检测到 `$(` 时尝试解析 `$(...)` 的边界（嵌套 `()` 配对），若豁免成立则 `i = closingParen - 1` 跳过该段，扫描继续；若失败则 `return "command_substitution"`。

**替代方案对比**：

- **A（拒绝方案）**：在 `scanUnreliable` 之前预扫描并 mask 掉 `$()` 内的字符——需要一次预扫描 O(n) + 一次主扫描 O(n)，2n 遍历，且 mask 会污染后续 quote 状态
- **B（拒绝方案）**：改成两阶段——先 `scanUnreliable` 收集所有 `$()` 位置，再逐个豁免判定——同样 2 遍，且与现有的短路式返回设计冲突
- **C（采纳方案）**：单遍扫描 + 就地豁免——豁免判定内联在 `$(` 分支，用递归 helper `isSubstitutionReadOnlyAt(cmd, startPos, depth)` 完成嵌套检查。豁免成功时 `i = closingParen - 1; continue`，失败时 `return`。**保持 scanUnreliable 的"发现即可靠否决"语义不变**

**实现要点**：`isSubstitutionReadOnlyAt` 是一个纯函数——输入命令字符串与起点位置，输出 `{ safe: boolean; endPos: number; depth: number }`。它自己维护一份局部 quote/escaped/parenDepth 状态机（不复用外层的 quote/escaped 变量，因为递归时状态需要隔离）。

### D3: 嵌套深度限制为 3 层

**选择**：递归深度 ≥ 3 立即失败豁免。

**理由**：真实世界的 read-only shell 惯用法极少超过 2 层嵌套（`$(basename $(dirname $f))` 是 2 层，已足够覆盖当前 case）。深度限制是防恶意构造 `$$($($(...)))` 绕过豁免判定的安全护栏——超过 3 层的嵌套即使全是白名单命令，静态分析也已经开始困难。

**替代方案**：不设上限（无限递归）——拒绝，因为没有防滥用；上限 1（不递归）——拒绝，覆盖了当前 case 但把 `$(basename $(dirname $f))` 这种最常见模式拒之门外。

### D4: 参数形式检查采用"白名单 + 反例枚举"策略

**选择**：白名单命令的参数**默认允许**任何字符，只要参数中不包含 D1 定义的副作用构造（未加引号 glob、`<<` heredoc、反引号、未递归豁免的嵌套 `$(...)`、子 shell `(...)`）。

**替代方案对比**：

- **A（拒绝方案）**：对每个白名单命令枚举允许的参数形式（如 `basename` 只允许 `-a`/`-s`/`-z` flag + 路径参数）——精细但维护成本高，且 `basename` 的 `-a`/`-s` flag 语义在不同 shell 有差异
- **B（采纳方案）**：默认允许 + 反例枚举——只要参数**不**含 glob/heredoc/backtick/subshell/非白名单嵌套 substitution 就通过。这与"有界 glob 免不可靠标记"的解析策略一致（条件 3a 就是"命令名属于集合即视为只读，不看参数"）

**理由**：白名单命令的**副作用风险**来自参数（未加引号 glob 展开到任意文件、heredoc 内嵌命令），不来自参数形式本身。只要排除这些副作用来源，参数形式本身无所谓。

### D5: 用户变量不检查，交给 `findUnresolvedVariable`

**选择**：豁免判定**不检查** `$VAR` 用户变量是否已展开。豁免通过后，`findUnresolvedVariable`（`extractBashTargets` step 5）仍会按原规则检测用户变量。

**理由**：豁免判定关心"这个命令替换会不会执行副作用操作"，不关心"变量值是什么"。这两个问题正交——用户变量未解析是**变量解析层**的问题，由 `findUnresolvedVariable` 处理；命令替换豁免是**语法形态层**的问题，由本 change 处理。

**替代方案**：豁免时同时检查用户变量——拒绝，因为会把两个正交层耦合，且 `findUnresolvedVariable` 已有专门处理。

### D6: 新增导出的两个符号仅供测试

`SUBSTITUTION_READONLY_CMDS` 是 `Set<string>` 常量；`isSubstitutionReadOnly` 是判定函数，二者都从 `src/lib/bash-extract.ts` 导出。生产代码中 `isSubstitutionReadOnly` 由 `scanUnreliable` 内部调用（作为递归 helper），仅测试引用其函数接口以覆盖嵌套场景。

## Risks / Trade-offs

- **[风险] 白名单过窄，实际 case 未覆盖** → 缓解：初始白名单 7 个命令覆盖了 audit log 中 90%+ 的常见 `$()` 场景（`basename`/`dirname`/`pwd`/`echo`）。发现新 case 后再单独 add，不预设白名单外的扩展。

- **[风险] 白名单过宽，副作用形式被豁免** → 缓解：D1 严格筛选"输出路径字符串或空值"的命令；D3 嵌套深度限制；D4 反例枚举排除副作用构造。

- **[风险] `isSubstitutionReadOnlyAt` 的状态机实现与 `scanUnreliable` 主状态机不同步（引号 / 转义处理不一致）** → 缓解：`isSubstitutionReadOnlyAt` 内部维护自己的 quote/escaped 状态机，代码结构与 `scanUnreliable` 保持一致（引号优先、反斜杠转义、单引号内 `\` 字面量）；单元测试覆盖嵌套引号、转义 `$` 等边界情况。

- **[风险] 豁免后提取器漏掉真实 target** → 缓解：豁免仅关闭 `command_substitution` 单条理由，其他 unreliable 检测（heredoc/backtick/subshell/glob）在**同一遍扫描的后续字符**中仍会触发；`scanControlFlow`/`isShellForwarder`/`isAnyUnreliableCommand` 等**后续 guardrail** 仍按原顺序执行；`COMMAND_TABLE` 提取器对 `head`/`cat`/`rm` 等命令仍正常提取 target（见 spec 场景"白名单命令 + 后续命令含真实写操作仍提取 write target"）。

- **[风险] 递归性能开销** → 缓解：嵌套深度限制 3，最坏情况 O(3n) 其中 n 是 `$()` 内字符数；实际 shell 惯用法的 `$()` 内字符数极少超过 100，性能影响可忽略。

- **[权衡] 不覆盖反引号 `` `...` ``** → 反引号与 `$()` 语义等价，但反引号是 shell 的老式写法，现代 shell 用法几乎全用 `$()`；本 change 保持反引号原判定不动，避免"改一个漏一个"的边界蔓延。

## Migration Plan

- 单一 commit 落地：`src/lib/bash-extract.ts` 修改 + `test/bash-extract.test.ts` 新增测试。无向后不兼容——豁免失败即回退原判定。
- 回滚策略：`git revert` 单个 commit 即可，因为豁免判定是**附加分支**而非修改原路径。

## Open Questions

无。所有关键设计决策（白名单集合、判定位置、递归深度、参数形式、用户变量处理）均已在此文档内明确。
