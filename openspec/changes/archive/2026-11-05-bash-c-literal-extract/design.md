# Design: bash -c 纯字面量递归提取

## Context

`bash -c "cat ~/.ssh/id_rsa"` 的字符串参数是纯字面量（无 `$`、无 `$(...)`、无控制流），但当前 `isShellForwarder` 命中后**无条件**判 shell_forwarder 不可靠（`entry.ts:60-62`），导致三档可持久化弹窗，可绕过敏感硬底线。

现状的关键事实（经实测）：
- `tokenize('bash -c "cat ~/.ssh/id_rsa"')` → `["bash", "-c", "cat ~/.ssh/id_rsa"]`——引号被剥掉，`-c` 后紧跟**一个完整字符串 token**
- `extractBashTargets('cat ~/.ssh/id_rsa')` → `{ reliable: true, targets: [read ~/.ssh/id_rsa] }`——内层字符串可独立解析
- 但 `extractBashTargets('cat $(echo x)')` → **误提取** `read ~/.ssh/id_rsa)`（带 `)`）——tokenizer 把 `$(echo` 和 `~/.ssh/id_rsa)` 拆开，`scanUnreliable` 未识别命令替换
- `extractBashTargets('for f in *.ts; do cat $f; done')` → `{ reliable: true, targets: [] }`——for 豁免导致 0 目标判可靠

**结论**：无脑递归不安全（`$(...)` 误提取、0 目标误放行）。必须带"纯字面量护栏 + 0 目标回退"。

## Goals / Non-Goals

**Goals**：
- 对**可证明为纯字面量**的 shell 转发器字符串参数，递归解析提取精确目标，交既有决策层判定
- 非纯字面量（含 `$`、`$(...)`、反引号、控制流、glob、brace expansion）保持 shell_forwarder 不可靠——行为**不变**
- **安全性质（核心）**：精确化后的权限判定 **≤ 直接执行该命令**（即不比对用户直接跑 `<命令>` 更宽松）。论证：有目标时走与直接执行完全相同的路径决策；0 目标时回退 shell_forwarder 弹窗（比直接执行的放行更严）。故不引入新风险，且堵住敏感文件持久化绕过

**Non-Goals**：
- **不新增**字符串内部引号/转义/拼接的解析逻辑——护栏作用于 `tokenize` 已归一化的 `-c` 字符串参数。相邻引号拼接（`bash -c "c""at x"`）由 `tokenize` 合并为单一 clean token，若结果纯字面量则精确提取（与 bash 拼接语义一致，安全）；更复杂的转义拼接（`bash -c 'cat '\''x'`）不做额外处理，直接依赖 `tokenize` 归一化结果 + 0 目标回退兜底，不单独实现拼接解析
- 不改变授权记忆（`trusted.json.bashGrants`）的持久化语义
- 不改变 `keypoints` 等价类判定
- 不处理解释器内联（`python3 -c`、`node -e`）——仍是 unreliable_command，不在本 change 范围

## Decisions

### D1: 纯字面量护栏判定（核心）

**决策**：新增 `isPureLiteralShellArg(s: string): boolean`，返回 true 当且仅当字符串不含：
- `$`（覆盖 `$VAR`、`$(...)`、`$((...))`、`$VAR` 引用——统一拦截）
- 反引号 `` ` ``
- 控制流关键字（`while`/`for`/`if`/`case`/`until`/`do`/`done` 等，独立 token 或边界匹配）
- glob 元字符 `* ? [ { }`（未加引号的；`{ }` 覆盖 brace expansion `{a,b}`——多文件展开不可静态确定，保守拦截）。**`]` 不在拦截集**：bash 中 `]` 单独出现非 glob 活跃字符（字符类需 `[` 开启，而 `[` 已被拦），拦 `]` 只会误伤合法文件名（如 `cat foo]bar`）无安全收益——故实现 regex `[*?[{]` 拦 glob 活跃字符 + `}` 拦 brace，不拦 `]`
- 换行（`\n`——heredoc/多行命令不可静态确定）

**Why**：这是**充分条件**而非必要条件——只要字符串不含上述任何构造，它就是一个可静态确定的字面量命令。`$` 的拦截是保守的（`$HOME` 虽安全但简化判定——非纯字面量统一回退，安全方向）。`~` 和相对路径不在拦截列表（`extractBashTargets` 内部已处理 `expandHome`/`toAbsolutePath`）。

**两点澄清（防误读）**：
1. **判定作用于 tokenize 后的 `-c` 字符串参数**。相邻引号拼接（`"c""at x"`）被 `tokenize` 合并为单一 token `cat x`，该 token 纯字面量 → 精确提取（与 bash 拼接语义一致，安全）。故嵌套引号拼接**不回退**（见 spec 对应 Scenario）。
2. **未拦花括号展开 `{a,b}`、进程替换 `<(...)`（无 `$`）**——但二者经 `extractBashTargets` 与直接执行走完全相同路径，且提取不全时 0 目标回退（D3）兜底，安全性质"≤ 直接执行"仍成立。这些非字面量构造的安全**不靠护栏拦截，靠"与直接执行同路径 + 0 目标回退"双保险**。

**Alternatives**：
- (A) 只拦 `$` 不含控制流/glob——拒绝，`for f in *.ts; do cat $f; done` 会误判纯字面量（含 `$f` 其实被 `$` 拦了，但 `for` 无 `$` 时如 `for f in a b; do cat /etc/x; done` 含控制流）→ 需要控制流拦截
- (B) 复用现有 `scanUnreliable` 判定内层——拒绝，`scanUnreliable` 对 `$(echo` token 拆分形式**有遗漏**（实测），不能作为唯一护栏；`isPureLiteralShellArg` 的字符级 `$` 检查是更强的充分条件

### D2: 递归解析 + 深度限制

**决策**：护栏通过后，递归调用 `extractBashTargets(inner, projectRoot, env)`。**允许的最深 `bash -c` 递归层数 = 1**：顶层命令是 depth 0，`-c` 字符串提取是 depth 1（允许）；若提取出的内层字符串**本身仍是 `bash -c ...`**，则该内层在递归时再次命中 shell 转发器，但已到深度上限（再递归将是 depth 2）→ **回退 shell_forwarder**。深度计数起点：顶层命令 depth=0，每次 `-c` 递归 +1，depth > 1 即回退。

**Why**：递归解析内层字符串语义正确（bash `-c` 执行该字符串就是把它当 shell 命令解析）。深度限制防止恶意嵌套 `bash -c "bash -c \"...\""` 造成栈溢出/无限递归。"允许 1 层"覆盖最常见的 `bash -c "cat ~/.ssh/id_rsa"`（单层纯字面量），同时把嵌套转发器（`bash -c "bash -c ..."`）保守回退到弹窗。

**Alternatives**：
- (A) 不递归、只提取第一层——拒绝，`bash -c "cat x && rm y"` 的复合命令需要完整递归才能提取多目标（这是同一层内的复合命令拆分，非嵌套 `-c` 递归，depth 1 允许）
- (B) 深度无限制——拒绝，嵌套攻击面

### D3: 0 目标强制回退（安全底线）

**决策**：递归结果为 `{ reliable: true, targets: [] }`（如 `bash -c "echo hi"`）时，**必须回退 shell_forwarder 不可靠**，不得返回 0 目标可靠。

**Why**：0 目标 reliable 会静默放行——内层若无目标命令（`echo hi`）本无害，但"0 目标 = 放行"在 bash 上下文是 fail-open 方向（内层若实际访问了文件但提取不到，会漏放行）。回退到弹窗是 fail-safe。这也保证安全性质"权限判定 ≤ 直接执行"——`echo hi` 直接执行放行，但 `bash -c "echo hi"` 回退弹窗（**更严**，保守方向），不更宽松。

**Alternatives**：
- (A) 返回 0 目标可靠——拒绝，fail-open 且与直接执行行为不一致（放宽）
- (B) 对 0 目标单独弹窗——等价于回退 shell_forwarder，无需新决策

### D4: 集成点——`isShellForwarder` 命中后、返回不可靠之前

**决策**：在 `entry.ts` 的 `isShellForwarder` 分支（`entry.ts:60-62`）**之前**插入递归提取检查：先 `isShellForwarder` 命中 → 提取 `-c` 字符串 → `isPureLiteralShellArg` 通过 → 递归 `extractBashTargets` → 有目标则返回 `{ reliable: true, targets }`，否则回退 shell_forwarder。

**Why**：保持现有守卫顺序（find_write_flag → scanUnreliable → control_flow → cd_chdir → shell_forwarder）不变，只在 shell_forwarder 命中处做"纯字面量精确化"。`shell_forwarder` 是当前最保守的分支，在其上精确化最安全——其他守卫已先行拦截更危险的构造。

**外层形态限制（实施中发现的安全增强，回写）**：递归提取**仅当外层命令是单 fragment 单 pipeline stage** 时才进行（`splitCommands` 长度 1 且 `splitPipelines` 长度 1）。复合（`bash -c "..." && rm y`）或管道（`bash -c "..." | head`）外层形态**保守回退 shell_forwarder**，不精确化。

**Why（形态限制）**：复合/管道外层下，只提取 `-c` 内层目标会**丢掉外层其余 stage 的目标**（如 `bash -c "cat x" && rm /etc/important` 里的 `rm /etc/important` 写目标）→ 0 目标误判 / 安全洞。故非单 stage 外层形态一律回退弹窗（与现状一致）。内层命令本身可含复合/管道（递归时 `extractBashTargets` 正常 splitCommands/splitPipelines，目标不丢）。这保证"精确化后权限判定 ≤ 直接执行该命令"无反例。**未加引号 `-c` 边界**：`bash -c cat /etc/passwd`（无引号）只取 `-c` 后第一个 token `cat` 作为命令字符串（`/etc/passwd` 是 `$0`，bash 不读）→ 0 目标 → 回退，不误提取。

**Alternatives**：
- (A) 放在 `scanUnreliable` 之前——拒绝，`bash -c "cat $(echo x)"` 的 `$(` 需先被 scanUnreliable 拦截（虽然实测有遗漏，但顺序仍应保持 scanUnreliable 优先）
- (B) 放在决策层 `decideTarget` 前——拒绝，提取是 bash 层的职责，决策层应保持纯函数只接收目标
- (C) 复合/管道外层也逐 stage 提取并合并目标——本 change 不做（需处理跨 stage 目标合并与守卫交互，复杂度高；保守回退已足够，覆盖最常见单命令形态）。

## Risks / Trade-offs

- **[纯字面量检测误判 → 误提取]** → 缓解：`isPureLiteralShellArg` 是保守充分条件（`$`/反引号/控制流/glob 任一出现即回退）；且递归结果必须非空目标才采用，0 目标回退。误判概率趋近 0
- **[`$(...)` 内层误提取（实测存在）]** → 缓解：`isPureLiteralShellArg` 的字符级 `$` 检查直接拦截 `$(echo ...)`，不会到达递归；这是独立于本 change 的 `scanUnreliable` 边界，本 change 通过护栏规避，不修复该底层问题（另立 change 评估）
- **[递归深度/性能]** → 缓解：允许最深 1 层 `-c` 递归（depth≥1 不再递归），且只在 shell_forwarder 命中 + 纯字面量通过 + 外层单 stage 时才递归，常规命令零开销
- **[行为变化：纯字面量命令从弹窗变精确判定]** → 缓解：精确化使 `bash -c "<纯字面量>"` 获得与直接执行 `<命令>` 相同的权限判定——项目外读（如 `cat /etc/passwd`）从弹窗变静默放行（**与直接执行一致**，非新风险，用户本就能静默读）；敏感文件（如 `~/.ssh/id_rsa`）从三档可持久化弹窗变**两档不可持久化弹窗**（**收严**，堵风险 1）；写/删（`rm -rf /tmp/x`）保持弹窗。0 目标回退弹窗（比直接执行更严，保守）。整体安全性质：**≤ 直接执行该命令**，不引入新风险。既有测试 `BMG8/9/10/12`（用纯字面量断言 shell_forwarder）需同步更新为精确提取断言

## Migration Plan

无迁移——这是提取行为的增强，不涉及配置/数据格式变化。纯字面量 `bash -c` 命令从"三档弹窗"变为"精确判定"，用户无需迁移。已持久化的 `trusted.json.bashGrants` 中 `bash -c "<纯字面量>"` 条目不再命中（因为不再走 unreliable 通道），属安全方向（用户可手动清理）。

## Open Questions

无（所有决策已在 D1-D4 解决，无改变 spec/approach/task 的遗留未知）。
