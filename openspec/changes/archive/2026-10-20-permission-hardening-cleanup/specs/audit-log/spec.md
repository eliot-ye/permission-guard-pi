## MODIFIED Requirements

### Requirement: 日志记录字段

每条审计记录 MUST 包含以下字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ts` | ISO8601 字符串 | 事件时间戳，由系统在写入时注入 |
| `event` | `"allow_once" \| "allow_session" \| "allow_persistent" \| "deny" \| "hard_deny" \| "conflict_prompt" \| "auto_allow"` | 事件分类 |
| `tool` | `"read" \| "write" \| "edit" \| "bash" \| "powershell"` | pi 工具名 |
| `project` | 字符串 | 项目 hash |
| `projectRoot` | 绝对路径 | 当前 projectRoot |
| `path` | 绝对路径 \| null | 目标路径（bash 命令可能为 null） |
| `command` | 字符串 \| null | bash 命令原文（文件工具为 null）。当字符串长度 > 512 字符时，MUST 被截断为前 511 字符 + 尾部 `…`，并追加 `note: "command truncated"` |
| `region` | `"project_inner" \| "project_outer"` | 区域判定 |
| `declaration` | `"read_write" \| "read_only" \| "unread" \| "sensitive_default" \| "unconfigured"` | 触发本次决策的声明类型 |
| `permission` | `"read_write" \| "read_only" \| null` | 若已配置则记录权限级别 |
| `toolCallId` | 字符串 | pi 分配的 tool call id |
| `note` | 字符串 \| 缺省 | 附加说明（如"no UI, denied"、"unreliable bash extraction"、"command truncated"） |

`command` 字段截断约束（本 change 新增）：

- 阈值固定为 512 字符
- 截断保留前 511 字符并追加 Unicode 省略号 `…`
- 截断时若 `note` 字段已有内容，系统 MUST NOT 覆盖既有 `note`；应把截断标记追加到既有 `note` 末尾（用 `; command truncated` 连接），若既有 `note` 缺省则直接使用 `command truncated`
- 长度 ≤ 512 字符的 `command` 字段 MUST 保持原样，不追加 `note`
- `command` 为 `null` 时 MUST NOT 触发截断或 note 追加

#### Scenario: 记录字段完整

- **WHEN** 用户拒绝一次 tier=three 弹窗
- **THEN** 审计日志新增记录包含 `event="deny"`、`tool="write"`、`path="/abs/path"`、`projectHash`、`permission="read_write"`、`toolCallId`

#### Scenario: command 字段超过 512 字符被截断并追加 note

- **WHEN** 用户执行一次 tier=two 的 bash 命令审批，`command` 长度为 800 字符
- **THEN** 审计日志新增记录中 `command` 字段长度为 512（前 511 字符 + `…`），`note` 字段包含字符串 `command truncated`

#### Scenario: command 字段 ≤ 512 字符保持原样

- **WHEN** 用户执行一次 bash 命令审批，`command` 长度为 120 字符
- **THEN** 审计日志新增记录中 `command` 字段为原始 120 字符内容，`note` 字段不包含 `command truncated`

#### Scenario: 截断不改变既有 note 字段语义

- **WHEN** 一条审计记录既有 `note: "unreliable bash extraction"` 又触发 command 截断
- **THEN** 审计日志中 `note` 字段为 `unreliable bash extraction; command truncated`——原有说明保留，截断标记追加在末尾

#### Scenario: command 为 null 时不触发截断

- **WHEN** 一条审计记录 `command = null`（文件工具产生的记录）
- **THEN** 审计日志中 `command` 字段仍为 `null`，`note` 字段不包含 `command truncated`

## ADDED Requirements

### Requirement: 日志文件目录与文件权限

审计日志目录与日志文件 MUST 以最小必要权限创建，防止同机其他用户 / 进程读取到审计内容（其中包含 bash 命令原文与敏感路径）。

具体约束：

- 首次创建 `~/.pi/agent/extensions/@permission-system:pi-extension/logs/` 目录时，MUST 使用 `0o700` 权限（`fs.mkdir({ mode: 0o700, recursive: true })`）
- 每次审计写入前，MUST 尝试将目标日志文件权限收敛为 `0o600`——但仅当文件属主为当前进程用户时才执行 chmod；属主不匹配时 MUST 跳过 chmod 且不阻塞审计写入（避免在共享账号或多用户环境下造成权限混乱）
- chmod 失败 MUST NOT 阻塞工具调用或触发错误提示——审计写入的 fire-and-forget 语义不变（见"日志写入不影响决策流程"requirement）
- Windows 环境下 `fs.chmod` 是 no-op，本 requirement 在 Windows 上自动无操作

#### Scenario: 首次写入自动创建 0o700 目录

- **WHEN** 用户首次运行扩展并触发一次审计写入，`logs/` 目录不存在
- **THEN** `logs/` 目录被创建，`fs.stat(logsDir).mode & 0o777 === 0o700`

#### Scenario: 已存在日志文件首次写入前收敛到 0o600

- **WHEN** `logs/permission-review.jsonl` 已存在且权限为 `0o644`，属主为当前用户，本次会话首次触发审计写入
- **THEN** `fs.stat(logFile).mode & 0o777 === 0o600`，日志文件正常追加一行

#### Scenario: 属主不匹配时跳过 chmod

- **WHEN** `logs/permission-review.jsonl` 属主非当前用户（`stat.uid !== process.getuid()`）
- **THEN** 系统不执行 chmod，日志追加行为不变；不向用户报告错误

#### Scenario: chmod 失败不阻塞审计写入

- **WHEN** `fs.chmod` 抛出异常（如只读文件系统）
- **THEN** 工具调用按决策结果放行 / 拒绝，不因 chmod 失败而阻塞；后续 appendFile 仍按原有 fire-and-forget 队列执行
