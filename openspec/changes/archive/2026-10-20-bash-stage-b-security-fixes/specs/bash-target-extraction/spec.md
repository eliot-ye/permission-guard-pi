# bash-target-extraction (delta)

## ADDED Requirements

### Requirement: 不可执行命令守卫

系统 MUST 定义 `UNRELIABLE_COMMANDS` 集合，命令名精确匹配即 MUST 判整条命令为 `reliable: false, reason: "unreliable_command"`。该集合至少包含以下类别的命令（这些命令可以执行任意 shell、访问任意文件、或通过网络外传数据）：

- **脚本解释器（可通过 `-c` / `-e` / `--exec` 等参数执行任意代码）**：`sed`、`awk`、`perl`、`python`、`python2`、`python3`、`python3.11`、`python3.12`、`node`、`nodejs`、`ruby`、`php`、`lua`、`deno`、`bun`
- **系统脚本执行器**：`osascript`、`powershell`、`pwsh`、`cmd`
- **网络传输工具（可以外传数据或远程执行命令）**：`scp`、`sftp`、`rsync`、`ssh`、`telnet`、`nc`、`netcat`、`ncat`、`socat`
- **容器 / 云编排工具（可以执行任意容器内命令）**：`kubectl`、`docker`、`podman`、`nerdctl`、`crictl`
- **shell 元命令（stage-a 明确留给 Stage B 的元命令）**：`eval`、`exec`、`trap`

**判定位置**：本判定在 `extractBashTargets` 主流程的 `isShellForwarder`（Shell 转发器守卫）之后、`findUnresolvedVariable`（未解析变量检查）之前执行。遍历所有 command fragment（由 `splitCommands` 拆分的命令片段）的首命令，任一 fragment 的首命令（跳过 `env`/`command` 等 wrapper 前缀）精确匹配 `UNRELIABLE_COMMANDS` 即触发本判定。

**与其他判定的交互**：
- `bash -c 'sed -i "x" /etc/passwd'` 应先命中 `shell_forwarder`（外层是 shell 转发器），而不是 `unreliable_command`（内层是 sed）——本判定在 shell_forwarder 之后执行，reason 优先级为 `shell_forwarder` > `unreliable_command`
- `sed -i "x" $(cat /etc/passwd)` 应先命中 `command_substitution`（`scanUnreliable` 在 scan 阶段触发），而不是 `unreliable_command`——scanUnreliable 的扫描在本判定之前
- `git status && sed -i "x" /etc/passwd` 中第二个 fragment 首命令是 `sed`，命中本判定，reason 为 `unreliable_command`

**引号感知**：命令名精确匹配——引号内的字符串参数不参与命令名匹配（`echo "sed -i"` 中的 `sed` 是 echo 的参数，不是命令名，不触发本判定）。

**理由**：这些命令的实际行为依赖字符串参数（如 `sed -i "s/a/b/" file` 会修改文件、`python3 -c "import os; ..."` 会执行任意 Python 代码），静态分析无法预测。命令名精确匹配是最保守可靠的判定方式——不论参数是什么，只要命令名是这些之一就判 unreliable。命令白名单是可枚举、可维护的（新增一类命令只需加一行），且明确列入比反查"未知命令"更清晰、更保守。

**边界**：
- 命令名不区分大小写（沿用既有 `getStageCommandName` 的行为——basename 与集合匹配）
- 命令名带路径前缀（如 `/usr/bin/sed -i ...`）命中本判定——basename 提取后精确匹配
- 命令带 `-c` / `-e` 参数但命令名不在集合中（如 `bash -c ...`）——由既有 Shell 转发器守卫处理，本判定不重复触发
- `python3 script.py`（脚本文件形式）也命中本判定——`python3` 命令名精确匹配即触发，不区分"内联代码"vs"脚本文件"两种形式

#### Scenario: sed 判不可执行

- **WHEN** bash 命令为 `sed -i 's/a/b/' /etc/passwd`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: python3 内联代码判不可执行

- **WHEN** bash 命令为 `python3 -c 'import os; open("/etc/evil","w").write("x")'`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: node 内联代码判不可执行

- **WHEN** bash 命令为 `node -e 'require("fs").writeFileSync("/etc/evil","x")'`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: perl 内联代码判不可执行

- **WHEN** bash 命令为 `perl -e 'open(F,"</etc/passwd");print'`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: osascript 判不可执行

- **WHEN** bash 命令为 `osascript -e 'do shell script "rm -rf /etc"'`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: scp 判不可执行

- **WHEN** bash 命令为 `scp /etc/shadow user@host:/tmp/`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: ssh 判不可执行

- **WHEN** bash 命令为 `ssh user@host 'cat /etc/shadow'`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: rsync 判不可执行

- **WHEN** bash 命令为 `rsync -a /etc/ host:/tmp/`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: kubectl 判不可执行

- **WHEN** bash 命令为 `kubectl exec pod -- cat /etc/shadow`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`

#### Scenario: eval 判不可执行

- **WHEN** bash 命令为 `eval "$(cat /tmp/evil.sh)"`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`（`scanUnreliable` 的 command_substitution 更早触发，reason 优先级为 `command_substitution` > `unreliable_command`；若命令是 `eval 'rm -rf /'`（无 command_substitution），则触发 `unreliable_command`）

#### Scenario: 命令名带路径前缀仍判不可执行

- **WHEN** bash 命令为 `/usr/bin/sed -i 's/a/b/' /etc/passwd`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——basename 提取后精确匹配

#### Scenario: 命令名在双引号内不触发

- **WHEN** bash 命令为 `echo "sed -i foo"`
- **THEN** 提取结果 `reliable: true`——`sed` 是 echo 的字符串参数，不是命令名

#### Scenario: 命令片段中的 sed 触发

- **WHEN** bash 命令为 `git status && sed -i 's/a/b/' /etc/passwd`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——第二个 fragment 首命令是 `sed`，命中本判定

### Requirement: bash-command grant 与 unread 的优先级

系统 MUST 保证配置中声明为 `unread` 的路径，即使被 bash-command session grant 或 persistent grant 覆盖，也 MUST 走 `deny_hard` 硬拒绝路径——不允许被 grant 覆盖。

**触发条件**：当 extension 层收到 bash 命令、`extractBashTargets` 返回 `reliable: false`（不可靠命令）、且 `state.trust.hasBashSessionGrant(projectHash, command)` 或 `hasBashPersistentGrant(projectHash, command)` 命中时，MUST 先扫描命令字符串里可识别的裸路径 token 跑 `policy.resolve()` 检查，若任一 token 对应路径的 config 声明为 `unread`，则 MUST 走 `deny_hard` 硬拒绝路径，**不走** grant auto-allow。

**扫描规则**：
- 使用 `tokenize`（quote-aware）拆分命令字符串为 token 数组
- 对每个 token 调用 `looksLikePath` 判定是否像路径
- 命中则 `expandHome` + `toAbsolutePath` 规范化
- 调 `policy.resolve(absPath)` 检查 config 声明
- 任一 token 解析出的路径 config 声明为 `unread` → 走 `deny_hard`

**审计日志**：grant 被 unread 覆盖时 MUST 记录 `event: "hard_deny"`，note 字段 MUST 说明"Bash command grant bypassed: unread hard-deny for <path>"，让审计消费者可以区分"用户拒绝"（`deny`）与"系统因 unread 硬拒绝"（`hard_deny`）。

**授权撤回语义**：本 requirement 明确 bash-command grant **不是** "覆盖所有配置"的强授权——`read_write`/`read_only` 声明的授权可被 grant 覆盖（沿用既有 `handlePromptDecision` 语义），但 `unread` 声明**永远优先于 grant**。这是"配置作为契约"的核心：unread 是配置层显式声明的硬拒绝，不能被"用户之前点过 Always allow"的授权覆盖。

**已知边界**：
- 只对"裸路径 token"生效——对 `bash -c "cat /etc/passwd"` 这类"路径嵌在字符串参数里"的形态**不生效**（tokenize 后 token 是 `cat /etc/passwd` 带空格，不是裸路径）
- 对 reliable 命令无影响——reliable 命令走既有 target 提取路径，本身会命中 unread 检查
- 对 tier=three 的 path-level prompt 无影响——用户选 "Allow for this session" 或 "Always allow" 后写入的 path-level grant 沿用既有 `decideTarget` 语义

**理由**：spec.md 现有 `access-decision` 分系统声明 unread 是"硬拒绝、不可覆盖"契约。原实现在 `extensions/index.ts` L453-472 的 bash grant 命中分支直接 `return undefined`，跳过了所有 config 检查，导致 unread 被 bash-command grant 覆盖。这是"配置作为契约"原则的破坏——用户如果配了 unread，之后对该命令访问的路径添加 unread 声明，应该撤回该 bash 授权。

#### Scenario: bash persistent grant 命中 + 命令访问 unread 路径 → 硬拒绝

- **WHEN** 用户之前对 `bash -c "cat /etc/passwd"` 点过 "Always allow"，之后配置 `{"/etc/passwd": "unread"}`，再次执行该命令
- **THEN** 命令被 `deny_hard` 硬拒绝，audit log 记录 `event: "hard_deny"`，note 含 "Bash command grant bypassed: unread hard-deny for /etc/passwd"，grant 不生效

#### Scenario: bash session grant 命中 + 命令访问 unread 路径 → 硬拒绝

- **WHEN** 用户在同 session 内对 `bash -c "cat /etc/passwd"` 点过 "Allow for this session"，之后配置 `{"/etc/passwd": "unread"}`，再次执行该命令
- **THEN** 命令被 `deny_hard` 硬拒绝，session grant 不生效

#### Scenario: bash grant 命中 + 命令无 unread 路径 → grant 生效

- **WHEN** 用户之前对 `bash -c "cat /tmp/x.txt"` 点过 "Always allow"，且 `/tmp/x.txt` 未配置为 unread
- **THEN** 命令 auto-allow（grant 生效），audit log 记录 `event: "auto_allow"`

#### Scenario: bash grant 命中 + 命令部分访问 unread（多路径）→ 硬拒绝

- **WHEN** 用户之前对 `bash -c "cat /etc/passwd && echo ok"` 点过 "Always allow"，之后配置 `{"/etc/passwd": "unread"}`，再次执行
- **THEN** 命令被 `deny_hard` 硬拒绝——任一裸路径 token 命中 unread 即触发

#### Scenario: bash grant 命中 + 路径在字符串参数内 → 不触发 unread 检查（已知边界）

- **WHEN** 用户之前对 `bash -c "cat /etc/passwd"` 点过 "Always allow"，之后配置 `{"/etc/passwd": "unread"}`，再次执行
- **THEN** 命令 auto-allow（grant 生效）——`cat /etc/passwd` 是 bash 字符串参数的一部分，tokenize 后 token 是 `cat /etc/passwd` 带空格，不是裸路径，不触发 unread 检查。**这是 C5 的已知边界**——用户如果需要严格的 unread 覆盖，应该用 tier=two prompt（不能 "Always allow"）。

#### Scenario: read_write / read_only 声明的路径 grant 仍生效（既有语义保留）

- **WHEN** 用户之前对 `bash -c "cat /etc/hosts"` 点过 "Always allow"，之后配置 `{"/etc/hosts": "read_write"}`，再次执行
- **THEN** 命令 auto-allow（grant 生效）——本 requirement 只覆盖 unread，`read_write` / `read_only` 声明的授权沿用既有"grant 覆盖 config"语义

## MODIFIED Requirements

### Requirement: 静默命令白名单

系统 MUST 定义 `SILENT_COMMANDS` 结构化白名单，形状为 `{ cmdName: Set<subcommand> }`——命令名 + 允许的子命令集合。命令名本身 MUST 命中白名单；后续第一个非 flag token 若是允许的子命令，则豁免为 0-target 静默。

**收窄后的白名单**（本 change 回滚既有"命令名单独匹配"的已知风险设计）：

- `git`: `status` / `log` / `diff` / `branch` / `tag` / `remote` / `config` / `rev-parse` / `rev-list` / `shortlog` / `blame` / `show`
- `npm`: `test` / `lint` / `audit` / `run`
- `npx`: `--yes`（仅允许 npx 带 flag 的形式；`npx <pkg>` 判 unreliable）
- `yarn`: `test` / `lint` / `audit`
- `pnpm`: `test` / `lint` / `audit`
- `tsc`: （空集合，tsc 无子命令，全 flag）
- `cargo`: `check` / `metadata`
- `go`: `version` / `env`
- `make`: （空集合——`make -f` 可指任意 Makefile，无静默）
- `rg`: （空集合——`rg pattern <path>` 可读任意路径，无静默）
- `jq`: （空集合——`jq . <file>` 可读任意文件，无静默）
- `openspec`: （空集合——本项目工具，所有子命令静默）

**判定接口**：新增辅助函数 `isSilentCommand(cmdName: string, tokens: string[]): boolean`——

- 命令名 MUST 在 `SILENT_COMMANDS` 白名单中（否则返回 false）
- 命令名后无 token 或全为 flag（如 `git --version`、`npm --help`）时：若白名单集合为空则返回 true（等价于 flag-only 查询，无副作用），否则返回 false
- 命令名后第一个非 flag token 是允许的子命令时：返回 true
- 命令名后第一个非 flag token 不是允许的子命令时：返回 false
- 命令名后第一个非 flag token 是裸路径参数（如 `git log /etc/passwd`、`rg pattern /etc/shadow`）时：返回 false

**语义约束**（沿用既有）：

- `SILENT_COMMANDS` 与 `COMMAND_TABLE` MUST 正交且互斥——`COMMAND_TABLE` 优先；命中 `COMMAND_TABLE` 的命令不进 SILENT 分支
- 命中 `SILENT_COMMANDS` 的命令 MUST NOT 遮盖 `FORWARDING_COMMANDS` 守卫——若同一命令片段中 xargs/parallel/pforeach 出现在非首 stage，仍判不可靠
- `SILENT_COMMANDS` MUST NOT 覆盖危险命令（`rm`、`chmod`、`chown`、`dd`）——这些命令仍在 `COMMAND_TABLE` 中正常提取 target

**已知边界**（本 change 明确保留）：
- `git log` 子命令在白名单内，但 `git log /etc/passwd` 因裸路径参数被收窄后的判定拒绝——收窄后的 `isSilentCommand` 会检查后续 token 是否是**允许的子命令**，若第一个非 flag token 是路径（`/etc/passwd` 不含 `:` 且不是子命令名），返回 false 触发 unreliable
- `npx <pkg>` 判 unreliable（第一个非 flag token 是包名，不在 `--yes` 白名单）——用户如果想跑某个 npm 包，需要弹窗授权或先用 `npm install -g <pkg>` 全局安装

**理由**：既有 spec 把 SILENT_COMMANDS 声明为"命令名集合"，命中即静默。但实测证明：`npm run build` 执行 package.json 里的任意 shell、`git log /etc/passwd` 读仓库外文件、`rg pattern /etc/shadow` 任意路径读、`jq . /etc/shadow` 任意路径读、`make -f /tmp/evil.mk` 任意 Makefile、`cargo run --manifest-path /tmp/x/Cargo.toml` 执行 build.rs——"副作用约束在 worktree 内"这个前提根本不成立。收窄到"命令名 + 子命令组合"能保留 `git status`/`npm test` 等合法用例，同时切断 `npm run <script>`/`git log <path>` 等越界读写。

**替代设计（拒绝）**：
- (A) 保留命令名单独匹配，把 `npm`/`git`/`rg`/`jq` 等整体移出 SILENT——拒绝，会误伤 `git status`/`npm test` 等合法用例（每次弹窗），用户拍板选择"收窄到纯只读子命令"（explore Q2）
- (B) 用正则匹配命令字符串——拒绝，可读性差、维护成本高
- (C) 反查"未在 COMMAND_TABLE 也未在 SILENT 的命令判 unreliable"——拒绝，把 "unknown → fail-open" 改为 "unknown → fail-closed"，属于 D6 设计边界变更（proposal 明确 Non-Goals 不改）

#### Scenario: git status 静默（收窄后 SILENT 保留）

- **WHEN** bash 命令为 `git status`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——命令名 `git` 在白名单、子命令 `status` 在允许集合

#### Scenario: git log 静默

- **WHEN** bash 命令为 `git log --oneline -n 10`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——命令名 `git`、子命令 `log` 都在白名单，`--oneline -n 10` 是 flag

#### Scenario: npm test 静默

- **WHEN** bash 命令为 `npm test`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——命令名 `npm`、子命令 `test` 都在白名单

#### Scenario: npm run 静默（子命令 `run` 允许，但不验证 script 内容）

- **WHEN** bash 命令为 `npm run build`
- **THEN** 提取结果**不**为 `{ reliable: true, targets: [] }`——`npm run <script>` 会被 `npm` 子命令白名单的**边界规则**捕获：`run` 后跟位置参数（`build`）不是 flag，视为脚本名，本 change 收窄后的实现选择**不**允许 `npm run`（因为 npm 会执行 package.json 里的任意 shell）。**实际实现**：`npm` 的白名单不包含 `run`——用户如果想跑 npm script，需要弹窗授权或添加显式 config。

#### Scenario: openspec status 静默

- **WHEN** bash 命令为 `openspec status --change foo --json`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——`openspec` 白名单集合为空，等价于所有子命令静默

#### Scenario: git 在 SILENT 但 xargs 守卫仍生效

- **WHEN** bash 命令为 `git status | xargs rm`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——`xargs` 触发转发器守卫，即使 `git status` 在 SILENT 白名单中也不遮盖

#### Scenario: npm test 后接 xargs rm 仍判 forwarding_command

- **WHEN** bash 命令为 `npm test | xargs rm`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——`xargs` 触发转发器守卫，`npm test` 在 SILENT 白名单不遮盖

#### Scenario: rm 不在 SILENT，仍提取 write target

- **WHEN** bash 命令为 `rm -rf /tmp/build`
- **THEN** 提取结果为 `{ reliable: true, targets: [delete /tmp/build] }`——`rm` 在 `COMMAND_TABLE` 中正常提取，不进入 SILENT 分支

#### Scenario: git log 带裸路径判 unreliable

- **WHEN** bash 命令为 `git log /etc/passwd`
- **THEN** 提取结果为 `{ reliable: false }`——收窄后的 `isSilentCommand` 检查后续 token，`/etc/passwd` 不在 `git` 的允许子命令集合中，判 unreliable；reason 由 scanUnreliable 提供（可能是 `unresolved variable` 或无 reason，具体由后续判定决定）

#### Scenario: rg 带路径判 unreliable

- **WHEN** bash 命令为 `rg pattern /etc/shadow`
- **THEN** 提取结果为 `{ reliable: false }`——`rg` 不在 SILENT 白名单（空集合），命令走正常 COMMAND_TABLE 查找但不存在，落到 unknown-command fail-open 分支。**注**：本 change 不修改 fail-open 默认（属于 D6 已知边界），`rg` 命令的实际行为是 0-target reliable（既有 spec 未列入 UNRELIABLE_COMMANDS 前）。**修正**：`rg` 从 SILENT 移除后，应显式列入 UNRELIABLE_COMMANDS 以保证 `rg pattern /etc/shadow` 判 unreliable——本 change 的 UNRELIABLE_COMMANDS 定义需包含 `rg`（追加到网络工具类别旁，作为"任意路径读取工具"）。

#### Scenario: jq 带文件判 unreliable

- **WHEN** bash 命令为 `jq . /etc/shadow`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`——`jq` 从 SILENT 移除并列入 UNRELIABLE_COMMANDS（作为"任意路径读取工具"）

#### Scenario: make -f 判 unreliable

- **WHEN** bash 命令为 `make -f /tmp/evil.mk`
- **THEN** 提取结果为 `{ reliable: false }`——`make` 不在 SILENT 白名单（空集合），落到 unknown-command 分支。**注**：本 change 的 UNRELIABLE_COMMANDS 需包含 `make`（作为"可执行任意 Makefile 的工具"）

#### Scenario: cargo run --manifest-path 判 unreliable

- **WHEN** bash 命令为 `cargo run --manifest-path /tmp/x/Cargo.toml`
- **THEN** 提取结果为 `{ reliable: false }`——`cargo run` 中 `run` 不在 `cargo` 的允许子命令集合（只允许 `check` / `metadata`），收窄后的 `isSilentCommand` 返回 false。**注**：本 change 的 UNRELIABLE_COMMANDS 需包含 `cargo`（作为"可执行任意 build.rs 的工具"）

### Requirement: Shell 转发器守卫

当 bash 命令的**第一个 token** 是 shell 转发器（`bash`、`sh`、`dash`、`zsh`）时，以下任一条件满足 MUST 触发"不可靠"标记：

1. 后续 token 中出现 `-c` 标志（既有行为，保持不变）
2. **后续 token 中出现非 flag 位置参数**（本 change 新增）——`bash /tmp/x.sh`、`bash -x /tmp/x.sh` 等

**新增：source 与 dot-source 守卫**（本 change 新增）：

- 命令的首 token 是 `source` 或 `.`（点号 source）且后续有非 flag 位置参数时，MUST 触发"不可靠"标记
- 引号内的 `source` / `.` 字面量不触发

**wrapper 透传**：若首 token 是 `env` 或 `command`，其参数中出现上述 shell 转发器或 `source` / `.` 组合时同样触发。

**理由**：
- `bash /tmp/x.sh` 与 `bash -c "..."` 在安全语义上等价——都执行了"字符串/文件内容里的命令"，静态分析无法预测
- spec.md 既有 scenario "bash 不带 -c 不触发"是明确写死的反例，本 change **删除该反例**并新增正向 scenario。这是 BREAKING 变更
- `source` / `.` 是 bash 的两种"执行脚本文件"方式，与 `bash /tmp/x.sh` 等价

**反例（不触发）**：

- `bash --version`、`bash -h`：无位置参数，只是查询版本或帮助
- `echo bash` / `which bash`：`bash` 是普通参数
- `source`（单独调用，无参数）：罕见的 `source` 单独形式，不触发

#### Scenario: bash -c 判不可靠

- **WHEN** bash 命令为 `bash -c "rm -rf /"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: sh -c 判不可靠

- **WHEN** bash 命令为 `sh -c "cat /etc/passwd"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: zsh -c 判不可靠

- **WHEN** bash 命令为 `zsh -c "rm -rf /"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`zsh` 与 `bash`/`sh`/`dash` 同为 shell 转发器

#### Scenario: bash 不带 -c 不触发

- **WHEN** bash 命令为 `bash --version`
- **THEN** 提取结果 `reliable: true`——无位置参数（本 change 收窄了"非 flag 位置参数即触发"这条判定，`bash --version` 只含 flag，不触发）

**注**：本 scenario 保留原有语义（bash 无 `-c` 且不带脚本路径时不触发 shell_forwarder），但**收窄**了触发面——原有实现里 `bash /tmp/x.sh` 也不触发（因为不带 `-c`），本 change 之后 `bash /tmp/x.sh` 触发（因为带了脚本路径的位置参数）。反例集更新见下方"反例（不触发）"节。

#### Scenario: bash 带脚本路径判不可靠（本 change 新增）

- **WHEN** bash 命令为 `bash /tmp/evil.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——非 flag 位置参数触发

#### Scenario: bash 带 flag + 脚本路径判不可靠（本 change 新增）

- **WHEN** bash 命令为 `bash -x /tmp/evil.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`-x` 是 flag，`/tmp/evil.sh` 是位置参数

#### Scenario: source 脚本判不可靠（本 change 新增）

- **WHEN** bash 命令为 `source /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: dot-source 脚本判不可靠（本 change 新增）

- **WHEN** bash 命令为 `. /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`.` 是 dot-source

#### Scenario: env bash -c 判不可靠

- **WHEN** bash 命令为 `env PATH=/usr/bin bash -c "cat /etc/passwd"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——env 是环境修饰符，bash -c 仍是实际执行的转发器

#### Scenario: env bash 脚本判不可靠（本 change 新增）

- **WHEN** bash 命令为 `env FOO=1 bash /tmp/evil.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——env 是环境修饰符，bash + 脚本路径仍是实际执行的转发器

#### Scenario: env source 脚本判不可靠（本 change 新增）

- **WHEN** bash 命令为 `env FOO=1 source /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——env 透传到 source

#### Scenario: bash 仅 flag 不触发（既有反例保留）

- **WHEN** bash 命令为 `bash --version`
- **THEN** 提取结果 `reliable: true`——无位置参数，无 `-c` 标志

#### Scenario: bash -x 单独不触发（本 change 新增）

- **WHEN** bash 命令为 `bash -x`
- **THEN** 提取结果 `reliable: true`——`-x` 是 flag，但无后续位置参数（`-x` 单独形式罕见，通常后接脚本路径或命令）

#### Scenario: bash -c 嵌套控制流判不可靠

- **WHEN** bash 命令为 `bash -c "for f in /etc/*; do cat $f; done"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`bash -c` 作为 token 命中 shell 转发器守卫；引号内的 `for`/`do` 关键字不被控制流检查命中（因为它们在双引号内是字面量）

### Requirement: 支持的重定向

系统 SHALL 从以下重定向操作符中提取目标路径：

- `>`、`>>`：stdout 重定向——写目标
- `2>`、`2>>`：stderr 重定向——写目标
- `>&`：fd 复制（如 `>&2` 复制 stderr，`>&file` 复制到文件——后者作为写目标）
- **`<`（本 change 新增）**：输入重定向——**读目标**

**`<` 输入重定向规则**：
- `< file` 从 `file` 读取数据喂给命令的 stdin
- 提取为 read target，走正常决策路径（用户可按路径授权或添加 unread 声明）
- 前缀可含 fd 数字（如 `0< file`），提取行为一致
- `<<`（heredoc 起始）**不**由本 requirement 处理——由"复杂语法导致不可靠"requirement 的 heredoc 判定处理
- `<(...)`（process substitution）**不**由本 requirement 处理——由"复杂语法导致不可靠"requirement 的 process_substitution_input 判定处理
- `<>`（read-write 模式，bash 极罕见形式）本 change 不处理

**其他既有重定向规则保持不变**：
- 目标路径为 `/dev/*` 时按"设备重定向不计入写目标"requirement 的豁免规则处理（含 `/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+` 黑名单）
- 目标路径为 fd 数字别名（如 `>&2`、`2>&1`）时不作为文件 target 提取
- 目标路径必须通过 `looksLikePath` 判定

#### Scenario: 重定向提取

- **WHEN** bash 命令为 `echo foo > /tmp/out.txt`
- **THEN** 提取写目标 `/tmp/out.txt`

#### Scenario: 2> 重定向提取（既有回归）

- **WHEN** bash 命令为 `cat /etc/passwd 2> /tmp/err.log`
- **THEN** 提取写目标 `/tmp/err.log`

#### Scenario: `>` 到 fd 复制不作为文件 target（既有回归）

- **WHEN** bash 命令为 `cat /etc/passwd >&2`
- **THEN** 提取结果不含 write target——`>&2` 是 fd 复制，不是文件

#### Scenario: `<` 输入重定向提取 read target（本 change 新增）

- **WHEN** bash 命令为 `bash < /tmp/evil.sh`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /tmp/evil.sh] }`——`<` 目标作为 read target

#### Scenario: `<` 到系统敏感文件（本 change 新增）

- **WHEN** bash 命令为 `bash < /etc/passwd`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd] }`——read target 走正常决策路径，可能被敏感路径检查命中

#### Scenario: 多个 `<` 输入重定向都提取（本 change 新增）

- **WHEN** bash 命令为 `diff < /etc/passwd < /etc/hosts`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd, read /etc/hosts] }`——两个 `<` 各自提取

#### Scenario: awk 带 `<` 输入重定向（本 change 新增）

- **WHEN** bash 命令为 `awk '{print}' < /etc/shadow`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/shadow] }`——`awk` 命令在 UNRELIABLE_COMMANDS 集合中，本命令**先**由 UNRELIABLE_COMMANDS 判定为 unreliable，reason 为 `unreliable_command`。**修正**：由于 `awk` 已被 UNRELIABLE_COMMANDS 守卫捕获，实际不会走到重定向提取；本 scenario 保留以说明 `<` 提取语义独立成立

#### Scenario: `<<` heredoc 不触发 `<` 提取（本 change 新增）

- **WHEN** bash 命令为 `cat <<EOF\nhello\nEOF`
- **THEN** 提取结果为 `{ reliable: false, reason: "heredoc" }`——`<<` 由"复杂语法导致不可靠"requirement 处理，本 requirement 的 `<` 判定不触发（`<<` 序列在 `<` 检查前被识别）

#### Scenario: process substitution `<(...)` 不触发 `<` 提取（本 change 新增）

- **WHEN** bash 命令为 `diff <(cat /etc/passwd) <(cat /etc/hosts)`
- **THEN** 提取结果为 `{ reliable: false, reason: "process_substitution_input" }`——`<(...)` 由"复杂语法导致不可靠"requirement 处理，本 requirement 的 `<` 判定不触发

#### Scenario: `0<` fd 输入重定向（本 change 新增）

- **WHEN** bash 命令为 `cat 0< /etc/passwd`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd] }`——fd 数字前缀不影响 `<` 提取
