## MODIFIED Requirements

### Requirement: Shell 转发器守卫

当 bash 命令的任一 fragment / pipeline stage 以 shell 转发器（`bash`、`sh`、`dash`、`zsh`）开头，且其后出现 `-c` 标志**或任何非 flag 位置参数（脚本路径）**时，MUST 触发"不可靠"标记；`source <path>` / `. <path>`（dot-source）MUST 同样触发。

**检测规则**：

- 先用 `splitCommands` 拆 compound command（`&&`/`||`/`;`/`&`/换行），每个 fragment 再用 `splitPipelines` 拆 pipeline stage；**任一 stage 命中即触发**（不限首个 stage）
- stage 开头允许 `env` / `command` 包装器：跳过其自有 flag、flag 值（`command -v/-V NAME` 的 NAME 是查询目标；`env -u/-C/-P/-S/-I VALUE` 的 VALUE 非命令）与 `KEY=VAL` 赋值后，继续检查实际命令
- shell 名（`bash`/`sh`/`dash`/`zsh`）之后的判定：
  - `-c`（独立 token）或短选项簇含 `c`（`-xc`、`-lc`、`-xec`）→ 触发
  - **任何非 flag 位置参数**（脚本路径：`bash /tmp/x.sh`、`bash -x /tmp/x.sh`）→ 触发
  - 长 flag（`--version`）→ 停止扫描，不触发
  - 只有 flag、无位置参数（`bash -x`、`bash -h`、无参数的 `bash`）→ 不触发
- `source` / `.` 后跟任何位置参数 → 触发；无位置参数（`source` 单独、`printf .`）→ 不触发

**纯字面量子集除外（本 change 引入）**：若 `-c` 标志后的字符串参数满足「纯字面量 shell 转发器递归提取」requirement 的全部条件（可证明为纯字面量且递归提取到 ≥1 个目标），MUST NOT 判 `shell_forwarder`——改为返回 `{ reliable: true, targets }`（精确提取），交决策层按既有 `decideTarget` 逐目标判定。**其余情况（非纯字面量、递归 0 目标、递归不可靠、脚本路径、dot-source）一律维持 `shell_forwarder` 不可靠**，不受本子集除外影响。

**安全性质**：精确化后权限判定 **≤ 直接执行该命令**（不比对用户直接跑 `<命令>` 更宽松）——有目标时走与直接执行完全相同的路径决策；0 目标时回退弹窗（比直接执行的放行更严）。故不引入新风险，且堵住敏感文件持久化绕过（`bash -c "cat ~/.ssh/id_rsa"` 从三档可持久化变两档不可持久化弹窗）。

**理由**：shell 转发器把字符串内的命令作为参数执行，字符串内容中的文件系统访问不被当前 tokenize/extract 流程识别（字符串里的 `rm -rf /` 不会被当成 target）。**但**当字符串参数可证明为纯字面量（无 `$`、反引号、控制流、glob/brace expansion——判定作用于 `tokenize` 归一化后的参数串）时，它就是一段可静态确定的命令文本，MUST 精确提取其目标而非整体弹窗——这堵住"不可靠 bash 可持久化授权绕过敏感硬底线"的通道（纯字面量 `bash -c "cat ~/.ssh/id_rsa"` 从三档可持久化弹窗变为精确判定敏感文件 → 两档不可持久化弹窗）。脚本路径（`bash /tmp/x.sh`）与 dot-source 执行的文件内容同样无法被 tokenize/extract 静态展开——脚本文件路径可静态分析，但**文件内容**不可，因此与 `-c` 同类，仍判 `shell_forwarder`。

**反例（不触发）**：

- `bash --version` / `bash -h` / `bash -x`：只有 flag 无位置参数，不执行任何脚本内容
- `echo bash` / `which bash`：`bash` 是普通参数，stage 第一个 token 不是 shell 名
- `source`（无参数）：没有要执行的脚本
- `bash -c "echo hi"`：纯字面量子集但递归提取 **0 目标** → 回退 `shell_forwarder` 不可靠（0 目标不精确化，决策不更宽松）
- `bash -c "cat $MYSECRETS"`：字符串含 `$` → 非纯字面量 → 回退 `shell_forwarder`

#### Scenario: bash -c 判不可靠

- **WHEN** bash 命令为 `bash -c "rm -rf $DIR"`（字符串含 `$`，非纯字面量）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——非纯字面量，不触发纯字面量子集除外

#### Scenario: sh -c 判不可靠

- **WHEN** bash 命令为 `sh -c "cat $HOME/.ssh/id_rsa"`（字符串含 `$`，非纯字面量）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: zsh -c 判不可靠

- **WHEN** bash 命令为 `zsh -c "ls $DIR"`（字符串含 `$`，非纯字面量）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: bash 脚本路径判不可靠

- **WHEN** bash 命令为 `bash /tmp/x.sh`（bash 后跟路径参数，非 `-c`）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——非 flag 位置参数是脚本路径，脚本文件内容无法被 tokenize/extract 静态展开，与 `-c` 同类

#### Scenario: source / dot-source 判不可靠

- **WHEN** bash 命令为 `source /tmp/x.sh` 或 `. /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——dot-source 执行脚本文件内容，静态不可展开；`source` 无参数时不触发

#### Scenario: env 包装脚本路径判不可靠

- **WHEN** bash 命令为 `env FOO=1 bash /tmp/evil.sh` 或 `env FOO=1 source /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——env 包装器的 `KEY=VAL` 赋值被跳过后，实际命令仍是带脚本路径的转发器

#### Scenario: env bash -c 判不可靠

- **WHEN** bash 命令为 `env PATH=/usr/bin bash -c "cat $DIR"`（env 后接 bash -c，字符串含 `$`，非纯字面量）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——env 是环境修饰符，bash -c 仍是实际执行的转发器

#### Scenario: bash -c 嵌套控制流判不可靠

- **WHEN** bash 命令为 `bash -c "for f in /etc/*; do cat $f; done"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`bash -c` 作为 token 命中 shell 转发器守卫；且该字符串含 `$f`（变量）与 `for`/`do`（控制流），非纯字面量，不触发纯字面量子集除外

## ADDED Requirements

### Requirement: 纯字面量 shell 转发器递归提取

当 `-c` 标志后的字符串参数可证明为**纯字面量**时，系统 MUST 递归解析该字符串并提取其 read/write/delete 目标，返回 `{ reliable: true, targets }`；否则（非纯字面量、递归 0 目标、递归不可靠）MUST 回退 `shell_forwarder` 不可靠。

**纯字面量判定**（全部满足，保守充分条件）：字符串不含
- `$`（覆盖 `$VAR`、`$(...)`、`$((...))` 统一拦截）
- 反引号 `` ` ``
- 控制流关键字（`while`/`for`/`if`/`case`/`until`/`do`/`done` 等，独立 token 或边界匹配）
- 未加引号的 glob 元字符（`*`、`?`、`[`）**与花括号 brace expansion（`{`、`}`）**——`{a,b}` 多文件展开不可静态确定，保守拦截
- 换行（`\n`——heredoc/多行命令不可静态确定）

**递归提取规则**：

- 递归调用 `extractBashTargets(innerString, projectRoot, env)` 解析内层字符串
- **允许的最深 `bash -c` 递归层数 = 1**（顶层命令 depth 0，`-c` 字符串提取 depth 1 允许；内层字符串本身仍是 `bash -c ...` 则已到深度上限，防 `bash -c "bash -c ..."` 无限嵌套）
- 递归结果为 `{ reliable: true, targets }` 且 `targets.length ≥ 1` → 采用该结果，返回 `{ reliable: true, targets }`
- 递归结果为 `{ reliable: true, targets: [] }`（0 目标）→ **MUST 回退** `{ reliable: false, reason: "shell_forwarder" }`（0 目标不精确化，决策不更宽松）
- 递归结果为 `{ reliable: false }`（内层含变量/替换等被内层守卫拦截）→ **MUST 回退** `{ reliable: false, reason: "shell_forwarder" }`

**理由**：纯字面量字符串参数是 bash `-c` 实际执行的命令文本，语义上与直接执行该命令等价，可静态精确提取。护栏（纯字面量判定 + 深度限制 + 0 目标回退）保证核心安全性质——**精确化后权限判定 ≤ 直接执行该命令**（有目标时走与直接执行完全相同的路径决策，0 目标回退弹窗比直接执行的放行更严）。非纯字面量与 0 目标一律回退到既有 shell_forwarder 弹窗，全局安全边界不变。这是对设计文档 `bash-stage-b-security-fixes/design.md` Q5"不扩展字符串内部解析"决策的**有界修正**：Q5 针对一般情况（可能带引号嵌套、转义、变量替换）成立，但对可证明纯字面量的子集是过度保守。

**安全边界**：
- 敏感文件目标（如 `~/.ssh/id_rsa`）经递归提取后交决策层，走既有 `decideTarget` → 敏感路径两档弹窗（不可持久化）——不再落入不可靠 bash 的三档可持久化通道
- 非纯字面量（`$`/`$(...)`/控制流/glob/brace expansion）一律回退 shell_forwarder——行为与现状完全一致

#### Scenario: 纯字面量 bash -c 提取读目标

- **WHEN** bash 命令为 `bash -c "cat ~/.ssh/id_rsa"`
- **THEN** 提取结果为 `{ reliable: true, targets: [{ action: "read", path: "/Users/eliot/.ssh/id_rsa" }] }`

#### Scenario: 纯字面量 bash -c 提取删除目标

- **WHEN** bash 命令为 `bash -c "rm -rf /tmp/x"`
- **THEN** 提取结果为 `{ reliable: true, targets: [{ action: "delete", path: "/tmp/x" }] }`

#### Scenario: 纯字面量 bash -c 复合命令提取多目标

- **WHEN** bash 命令为 `bash -c "cat /etc/passwd && rm /etc/x"`
- **THEN** 提取结果为 `{ reliable: true, targets: [{ action: "read", path: "/etc/passwd" }, { action: "delete", path: "/etc/x" }] }`

#### Scenario: 纯字面量 sh -c / zsh -c 提取

- **WHEN** bash 命令为 `sh -c "cat /etc/passwd"` 或 `zsh -c "ls /etc"`
- **THEN** 提取结果为 `{ reliable: true, targets: [...] }`（`sh`/`zsh` 与 `bash` 同语义，纯字面量同样精确提取）

#### Scenario: 变量字符串回退 shell_forwarder

- **WHEN** bash 命令为 `bash -c "cat $MYSECRETS"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——字符串含 `$`，非纯字面量，回退

#### Scenario: 命令替换字符串回退 shell_forwarder

- **WHEN** bash 命令为 `bash -c "cat $(echo ~/.ssh/id_rsa)"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——字符串含 `$`（`$(...)`），非纯字面量，回退

#### Scenario: 控制流字符串回退 shell_forwarder

- **WHEN** bash 命令为 `bash -c "for f in *.ts; do cat $f; done"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——字符串含 `$f` 与 `for`/`do`，非纯字面量，回退

#### Scenario: 0 目标回退 shell_forwarder

- **WHEN** bash 命令为 `bash -c "echo hi"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——纯字面量但递归提取 0 目标，回退（0 目标不精确化，决策不更宽松）

#### Scenario: 递归深度限制

- **WHEN** bash 命令为 `bash -c "bash -c 'cat /etc/passwd'"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——内层字符串本身仍是 `bash -c`，嵌套 `-c` 递归已到深度上限（允许 1 层，再递归即 depth 2），回退

#### Scenario: 复合 / 管道外层形态保守回退（防丢目标安全洞）

- **WHEN** bash 命令的外层是复合或管道形态，如 `bash -c "cat x" && rm /etc/important` 或 `bash -c "cat /etc/passwd" | head`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——非单 fragment 单 stage 外层形态不递归。**理由（安全洞防护）**：只提取 `-c` 内层目标会丢掉外层其余 stage 的目标（如 `rm /etc/important` 的写目标）→ 0 目标误判 / 静默放行外区写。故保守回退弹窗（与现状一致），不精确化。内层命令本身可含复合/管道（递归时 `extractBashTargets` 正常处理，目标不丢），仅**外层**形态受限

#### Scenario: 未加引号 -c 只取命令字符串首个 token

- **WHEN** bash 命令为 `bash -c cat /etc/passwd`（`-c` 后无引号包裹，`cat` 是命令、`/etc/passwd` 是 `$0` 参数）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——bash 只把 `-c` 后第一个 token `cat` 当命令字符串执行（`/etc/passwd` 是 `$0`，不被读取），提取 `cat` → 0 目标 → 回退，**不误提取** `/etc/passwd`

#### Scenario: 嵌套引号拼接被合并提取

- **WHEN** bash 命令为 `bash -c "c""at ~/.ssh/id_rsa"`
- **THEN** 提取结果为 `{ reliable: true, targets: [{ action: "read", path: "/Users/eliot/.ssh/id_rsa" }] }`——`tokenize` 把相邻引号段合并为单一 token（`"c""at ~/.ssh/id_rsa"` → `cat ~/.ssh/id_rsa`），该 token 纯字面量，递归精确提取目标。此行为**与 bash 语义一致**（bash 同样拼接相邻引号段），提取结果正确且安全，不构成回退（见 design.md D1 的"纯字面量判定作用于 tokenize 后的字符串参数"说明）
