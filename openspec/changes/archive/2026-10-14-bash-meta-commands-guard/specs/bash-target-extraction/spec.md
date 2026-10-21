# bash-target-extraction

## ADDED Requirements

### Requirement: 控制流关键字守卫

以下 bash 控制流关键字作为**引号外独立 token**出现时 MUST 触发"不可靠"标记，整条命令走 tier=two 弹窗而非尝试解析：

- `while`、`do`、`done`
- `for`
- `until`
- `if`、`then`、`else`、`elif`、`fi`
- `case`、`in`、`esac`

**理由**：控制流关键字使得命令的实际执行取决于运行时条件或循环变量，静态分析无法预测循环体内变量的取值，也无法预测 `if`/`case` 分支的实际路径。这与管道转发器同类问题（"实际访问的文件集无法静态确定"），处理策略一致。

**引号感知**：控制流关键字判定 MUST 遵循引号语义——

- 单引号 `'...'` 内的关键字 MUST 视为字面量，不触发
- 双引号 `"..."` 内的关键字 MUST 视为字面量，不触发
- 引号外的关键字 MUST 作为独立 token（前后为空白或命令分隔符）时才触发;作为更长 token 的一部分（如变量名 `whileFoo`、路径 `/tmp/if.txt`）MUST NOT 触发

**检测位置**：控制流检查 MUST 在 pipeline 拆分**之前**执行——一旦检测到控制流，整条命令判不可靠，无需再拆分 stage。

#### Scenario: while 关键字判不可靠

- **WHEN** bash 命令为 `while read x; do cat $x; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: for 关键字判不可靠

- **WHEN** bash 命令为 `for f in a b; do cat $f; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: until 关键字判不可靠

- **WHEN** bash 命令为 `until ls /; do echo hi; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: case 关键字判不可靠

- **WHEN** bash 命令为 `case "$x" in a) cat a;; b) cat b;; esac`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: if 关键字判不可靠

- **WHEN** bash 命令为 `if true; then cat /etc/passwd; fi`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: 控制流关键字在引号内视为字面

- **WHEN** bash 命令为 `echo "while" && cat /etc/passwd`（`while` 在双引号内）
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd] }`——引号内关键字不触发;命令按 stage 正常提取

#### Scenario: 控制流关键字作为 token 子串不触发

- **WHEN** bash 命令为 `cat /tmp/if.txt`（`if` 是文件名的一部分）
- **THEN** 提取结果为 `{ reliable: true, targets: [read /tmp/if.txt] }`——`if` 不作为独立 token 出现，不触发

### Requirement: Shell 转发器守卫

当 bash 命令的**第一个 token** 是 shell 转发器（`bash`、`sh`、`dash`、`zsh`）并紧跟 `-c` 参数时，MUST 触发"不可靠"标记。

**检测规则**：

- 命令的**第一个 token**（`splitCommands` 拆出的第一个 command，`splitPipelines` 拆出的第一个 stage）MUST 是 `bash`/`sh`/`dash`/`zsh`
- 后续 token 中 MUST 出现 `-c` 标志（`-c` 独立 token 或与首个字符合写如 `-c`、`-xc`、`-lc` 等）
- 若第一个 token 是 `env` 或 `command`，其参数中出现 `bash`/`sh`/`dash`/`zsh -c ...` 组合时同样触发

**理由**：shell 转发器把字符串内的命令作为参数执行，字符串内容中的文件系统访问不被当前 tokenize/extract 流程识别（字符串里的 `rm -rf /` 不会被当成 target）。这是"实际访问的文件集无法静态确定"的另一类形态，与管道转发器同类。

**反例（不触发）**：

- `bash /tmp/x.sh`：`bash` 后跟路径参数（不是 `-c`），是"执行脚本文件"——脚本文件路径本身就是可静态分析的 target
- `bash --version`：无 `-c` 参数，只是查询版本
- `echo bash` / `which bash`：`bash` 是普通参数

#### Scenario: bash -c 判不可靠

- **WHEN** bash 命令为 `bash -c "rm -rf /"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: sh -c 判不可靠

- **WHEN** bash 命令为 `sh -c "cat /etc/passwd"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: zsh -c 判不可靠

- **WHEN** bash 命令为 `zsh -c "ls /etc"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: bash 不带 -c 不触发

- **WHEN** bash 命令为 `bash /tmp/x.sh`（bash 后跟路径参数，非 `-c`）
- **THEN** 提取结果 `reliable: true`，**不触发 shell_forwarder**——`bash` 未命中转发器守卫（缺少 `-c` 标志）。`bash` 命令本身不在 `COMMAND_TABLE` 与 `SILENT_COMMANDS` 中，不提取任何 target（与上一 change 的 SILENT 语义无关）

#### Scenario: env bash -c 判不可靠

- **WHEN** bash 命令为 `env PATH=/usr/bin bash -c "cat /etc/passwd"`（env 后接 bash -c）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——env 是环境修饰符，bash -c 仍是实际执行的转发器

#### Scenario: bash -c 嵌套控制流判不可靠

- **WHEN** bash 命令为 `bash -c "for f in /etc/*; do cat $f; done"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`bash -c` 作为 token 命中 shell 转发器守卫；而引号内的 `for`/`do` 关键字不被控制流检查命中（因为它们在双引号内是字面量）

### Requirement: Shell 内置变量白名单

以下 shell 内置变量（无路径影响的纯数字 / 标量值）MUST 视为已解析，MUST NOT 被标记为 `unresolved variable: special:*`：

- `$?` —— 上一条命令的 exit status（值域 0-255）
- `$!` —— 最后一个后台进程的 PID（纯数字）
- `$#` —— 位置参数个数（纯数字）
- `$$` —— 当前 shell 进程的 PID（纯数字）

**理由**：这四个变量展开后是纯数字（或 PID），不可能携带文件路径，不会改变命令实际访问的目录 / 文件集。之前把它们当作 `special:*` 判不可靠会导致大量开发场景命令被误弹窗（如 `git status && echo "cached_exit=$?"`——本仓库自己频繁使用）。

**对比组（仍判不可靠）**：以下 shell 特殊参数可能携带路径（位置参数可以是任意文件名），MUST 保持原有 `special:*` 判不可靠行为：

- `$@`、`$*` —— 全部位置参数（展开后可以是任意路径列表）
- `$-` —— shell 标志字符（可能包含 `-n` 之类影响命令行为的选项）
- `$0`..`$9` —— 具体位置参数（`$0` 是脚本名、`$1`..`$9` 是位置参数，都可能是路径）

#### Scenario: `$?` 作为 exit status 不判不可靠

- **WHEN** bash 命令为 `echo "cached_exit=$?"`
- **THEN** 提取结果 `reliable: true`，不再被标记为 `unresolved variable: special:?`

#### Scenario: git status 真实场景回归

- **WHEN** bash 命令为 `git status --short && git diff --cached --quiet; echo "cached_exit=$?"`
- **THEN** 提取结果 `reliable: true`——`$?` 在 `INERT_SPECIAL_PARAMS` 白名单内，不作为 unresolved 上报；其余命令（`git status`、`git diff`）都不在写目标命令表，不提取任何 target

#### Scenario: `$!` / `$#` / `$$` 同属无路径影响

- **WHEN** bash 命令为 `pid=$!; echo pid`（或 `count=$#` / `pid=$$`）
- **THEN** 提取结果 `reliable: true`——三个变量都在白名单内

#### Scenario: `$@` 仍判不可靠

- **WHEN** bash 命令为 `cat $@`
- **THEN** 提取结果为 `{ reliable: false, reason: "unresolved variable: special:@" }`——`$@` 不在白名单，仍可能被展开为任意路径列表

#### Scenario: 位置参数 `$0` / `$1` 仍判不可靠

- **WHEN** bash 命令为 `cat $0`（或 `cat $1`）
- **THEN** 提取结果 `reliable: false`，reason 为 `unresolved variable: special:0` / `unresolved variable: special:1`——位置参数可以是任意文件路径

#### Scenario: `$-` shell 标志仍判不可靠

- **WHEN** bash 命令为 `echo $-`
- **THEN** 提取结果 `reliable: false`，reason 为 `unresolved variable: special:-`——shell 标志可能包含影响行为的选项

#### Scenario: `$?` 在单引号内作为字面字符

- **WHEN** bash 命令为 `echo 'cached_exit=$?'`
- **THEN** 提取结果 `reliable: true`——单引号内的 `$` 是字面字符，不触发变量检测（与已有引号感知语义一致）
