## ADDED Requirements

### Requirement: shell 转发器的长参数前缀判不可靠

若 bash 命令的片段以 `bash` / `sh` / `dash` / `zsh` 之一开头，且该 shell 命令名之后出现长参数（以 `--` 开头，如 `--posix`、`--norc`、`--noprofile`、`--rcfile FILE`），系统 SHALL 继续向后扫描以捕获 `-c`、选项簇（如 `-xc`）或非 flag 位置参数（脚本路径）三种触发条件；这些触发条件任一出现时，整条命令 MUST 判定为不可靠，reason 为 `shell_forwarder`。

长参数本身不构成 shell 转发器的证据——`bash --version` 只是打印版本信息，不是 forwarder。因此遇到长参数时扫描器 MUST NOT 直接退出循环返回"非 forwarder"，而 MUST 继续向后扫描后续参数。

#### Scenario: bash --posix -c 判不可靠

- **WHEN** bash 命令为 `bash --posix -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`--posix` 被跳过后继续扫描，`-c` 触发 shell 转发器判定

#### Scenario: sh --norc -c 判不可靠

- **WHEN** bash 命令为 `sh --norc -c 'cat /etc/passwd'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: bash --version 不触发 shell 转发器

- **WHEN** bash 命令为 `bash --version`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——只有长参数、无 `-c` / 选项簇 / 脚本路径，不构成 shell 转发器

#### Scenario: bash --rcfile 后接 -c 判不可靠

- **WHEN** bash 命令为 `bash --rcfile /dev/null -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`--rcfile` 与 `/dev/null` 被跳过后继续扫描，`-c` 触发

### Requirement: shell 外层包装器判不可靠

若 bash 命令的片段以常见外层包装器开头（`sudo`、`nohup`、`timeout`、`watch`、`nice`），且该包装器之后嵌套 `bash` / `sh` / `dash` / `zsh` 之一，系统 SHALL 跳过包装器自身的参数（含 `KEY=VAL` 赋值、`--flag` 长参数、短 flag 及其值）后，按"shell 转发器"规则审查内层 shell 命令：内层 shell 命令带 `-c`、选项簇或脚本路径时，整条命令 MUST 判定为不可靠，reason 为 `shell_forwarder`。

外层包装器本身不改变内层 shell 命令的语义（提权、忽略 SIGHUP、限时、定时循环、调整优先级），因此包装器的作用是把扫描器定位到内层实际命令，不改变既有的 shell 转发器判定规则。

**包装器的参数处理**：
- `sudo` / `nohup` / `watch`：位置参数直接是内层命令名，`skipWrapperTokens` 的通用逻辑（跳过 `KEY=VAL` / `--flag` / 短 flag + 值）足以定位到内层命令。
- `timeout`：接受"持续时间 + 命令"形式，`skipWrapperTokens` MUST 跳过第一个位置参数（持续时间，如 `5`、`1m`、`1h`）后继续扫描到内层命令。
- `nice`：接受 `-n LEVEL + 命令` 形式，`skipWrapperTokens` MUST **显式**将 `-n` 识别为取值短 flag，消费 2 个 token（`-n` + `LEVEL`）后继续扫描到内层命令。MUST NOT 依赖既有的"通用短 flag 只消费 1 token"分支——那样 `LEVEL`（如 `10`）会被当作位置参数 break，`isShellForwarderTokenStream` 随后拿到 `base = "10"`（既非 `SHELL_NAMES` 也非 `source`/`.`）返回 false，导致 `nice -n 10 bash -c '...'` 静默放行。

#### Scenario: sudo bash -c 判不可靠

- **WHEN** bash 命令为 `sudo bash -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: nohup bash /tmp/x.sh 判不可靠

- **WHEN** bash 命令为 `nohup bash /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: timeout 5 bash -c 判不可靠

- **WHEN** bash 命令为 `timeout 5 bash -c 'cat /etc/passwd'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`5` 被识别为 timeout 的持续时间位置参数并被跳过，扫描到 `bash -c` 触发

#### Scenario: watch bash -c 判不可靠

- **WHEN** bash 命令为 `watch bash -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: nice -n 10 bash -c 判不可靠

- **WHEN** bash 命令为 `nice -n 10 bash -c 'cat /etc/passwd'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: sudo env bash -c 判不可靠

- **WHEN** bash 命令为 `sudo env FOO=1 bash -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`env` 已在既有 wrapper 集合中，`sudo` + `env` 组合的包装器跳过逻辑复用现有实现

### Requirement: cd cwd 变更判不可靠

若 bash 命令为复合命令（以 `;`、`&&`、`||`、`&` 或换行分隔），且任一复合命令片段的第一个 token（basename，去掉路径前缀）为 `cd`，系统 MUST 判定整条命令为不可靠，reason 为 `cd_chdir`。

单命令形式的 `cd`（不含 `;`、`&&`、`||`、`&` 或换行分隔符）MUST NOT 触发此规则——`cd /etc` 单独执行不产生文件访问，可静默放行。

**理由**：`cd` 是 bash 内建，会改变后续所有相对路径命令的 cwd 基准。当前实现把相对路径的解析基准固定为 `<projectRoot>`，完全忽略 `cd` 的实际效果，导致 `cd /etc && rm -rf .` 中的 `.` 被解析为 `<projectRoot>/.` 而非 `/etc/`，实际执行会删除 `/etc` 内容。把整条含 `cd` 片段的复合命令判为不可靠是"静态分析无法预测相对路径实际落点"的最小侵入修复。

#### Scenario: cd 后接写入命令判不可靠

- **WHEN** bash 命令为 `cd /etc && rm -rf .`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`

#### Scenario: cd 后接读取命令判不可靠

- **WHEN** bash 命令为 `cd /etc && ls`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`

#### Scenario: 单命令 cd 不触发

- **WHEN** bash 命令为 `cd /etc`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——无复合命令片段，`cd` 单独执行不产生文件访问

#### Scenario: cd 在管道片段中判不可靠

- **WHEN** bash 命令为 `cd src && cat a.txt | sort`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——复合命令中的 `cd` 片段触发，管道不影响判定

#### Scenario: cd 在后续片段中判不可靠

- **WHEN** bash 命令为 `echo hi; cd /tmp && rm -rf .`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——任一复合命令片段的首个 token 为 `cd` 即触发

#### Scenario: cd 后接写入目标触发 tier=two 提示

- **WHEN** bash 命令为 `cd /etc && rm -rf .`，bash-target-extraction 判定为 `{ reliable: false, reason: "cd_chdir" }`
- **THEN** access-decision 决策为 prompt，tier=two，弹窗展示完整命令文本——`cd_chdir` 属于"无法静态解析"的 bash 命令，走兜底弹窗
