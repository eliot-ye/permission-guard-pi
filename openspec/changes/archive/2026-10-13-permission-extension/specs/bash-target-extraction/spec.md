## Purpose

定义 bash 命令的文件目标路径提取契约——用正则从 bash 命令文本中可靠提取需要访问的文件路径，并明确"无法解析"的边界，交由决策引擎走"未配置路径"兜底弹窗。

## ADDED Requirements

### Requirement: 支持的文件写入 / 删除命令

系统 SHALL 从以下命令中提取文件目标路径（作为"写目标"）：

- `rm`（含 `-r`, `-rf`, `-f`, `--recursive` 变体）——写目标
- `mv`（第二参数）——写目标
- `cp`（第二参数）——写目标
- `tee`（含 `-a` 追加）——写目标
- `install`——写目标
- `ln -s`（第二参数）——写目标
- `chmod` / `chown`——写目标（元数据写）
- `truncate`——写目标
- `dd of=`——写目标（value 参数）

#### Scenario: `rm -rf` 提取路径

- **WHEN** bash 命令为 `rm -rf /tmp/build`
- **THEN** 提取写目标 `/tmp/build`

#### Scenario: `mv` 提取目标路径

- **WHEN** bash 命令为 `mv /tmp/a.txt /dest/b.txt`
- **THEN** 提取写目标 `/dest/b.txt`

### Requirement: 支持的文件读取命令

系统 SHALL 从以下命令中提取文件目标路径（作为"读目标"）：

- `cat`——读目标
- `head` / `tail`——读目标
- `wc`——读目标
- `grep`——读目标（文件参数）
- `cp` / `mv`（第一参数）——读目标

#### Scenario: `cat` 提取路径

- **WHEN** bash 命令为 `cat /etc/passwd`
- **THEN** 提取读目标 `/etc/passwd`

### Requirement: 支持的重定向

系统 SHALL 从 `>`、`>>`、`2>`、`2>>` 提取写目标路径。

#### Scenario: 重定向提取

- **WHEN** bash 命令为 `echo foo > /tmp/out.txt`
- **THEN** 提取写目标 `/tmp/out.txt`

### Requirement: 网络工具目标提取

系统 SHALL 从 `curl -o <path>`、`curl --output <path>`、`wget -O <path>`、`wget <url> -O <path>` 中提取本地写目标路径（URL 不视为文件系统路径）。

#### Scenario: `curl -o` 提取写目标

- **WHEN** bash 命令为 `curl https://x.com/a -o /tmp/a.bin`
- **THEN** 提取写目标 `/tmp/a.bin`

### Requirement: 变量展开与展开失败

系统 SHALL 尝试展开常见 shell 变量（`$HOME`、`${HOME}`、`$PWD`、`${PWD}`）。其他变量（用户自定义 `$X`）MUST NOT 尝试展开——若命令中出现未展开的用户变量，整个命令 MUST 判定为"不可靠"，走"未配置路径"兜底弹窗。

#### Scenario: `$HOME` 展开

- **WHEN** bash 命令为 `cat $HOME/.ssh/id_rsa`，`HOME=/Users/eliot`
- **THEN** 提取读目标 `/Users/eliot/.ssh/id_rsa`

#### Scenario: 用户变量导致不可靠

- **WHEN** bash 命令为 `cat $MYSECRETS`（`MYSECRETS` 未展开）
- **THEN** 提取结果为 `{ reliable: false, rawCommand: "..." }`，触发 tier=two 兜底弹窗

### Requirement: 复杂语法导致不可靠

以下 bash 语法 MUST 触发"不可靠"标记（走兜底弹窗而非尝试解析）：

- 命令替换：`$(...)`、反引号 `` `...` ``
- 管道：`|`
- 子 shell：`(...)`
- Process substitution：`<(...)`、`>(...)`
- Heredoc：`<<EOF`
- 嵌套引号内的复杂展开：`"${VAR:?err}"`

#### Scenario: 管道命令不可靠

- **WHEN** bash 命令为 `cat /etc/passwd | grep root`
- **THEN** 提取结果为 `{ reliable: false }`

#### Scenario: 命令替换不可靠

- **WHEN** bash 命令为 `rm -rf $(cat /etc/hosts)`
- **THEN** 提取结果为 `{ reliable: false }`

### Requirement: 相对路径规范化

提取到的相对路径 MUST 相对于当前 `<projectRoot>`（或工具调用时的 cwd）解析为绝对路径后再交给决策引擎。

#### Scenario: 相对路径解析

- **WHEN** `<projectRoot> = /proj`，bash 命令为 `cat src/main.ts`
- **THEN** 提取读目标 `/proj/src/main.ts`

### Requirement: 提取结果数据结构

bash-target-extraction 模块的输出 MUST 为：

```ts
type ExtractResult =
  | { reliable: true; targets: Array<{ action: "read" | "write" | "delete"; path: string }> }
  | { reliable: false; rawCommand: string; reason?: string }
```

多个 targets 时，决策引擎 MUST 对每个 target 独立决策；任一 target 触发 prompt 则整条命令阻塞等待弹窗。

#### Scenario: 多目标命令

- **WHEN** bash 命令为 `cp /a /b && cp /c /d`（`&&` 视为命令序列）
- **THEN** 提取 4 个 targets（2 读 2 写），任一未授权即触发弹窗

#### Scenario: 不可靠命令返回 raw

- **WHEN** 命令包含 `|`
- **THEN** 返回 `{ reliable: false, rawCommand: "..." }`
