## Purpose

定义审计日志的追加写入契约——所有权限决策都进入 JSONL 日志，字段覆盖用户可复核的完整上下文，串行写入保证不产生损坏行。

## ADDED Requirements

### Requirement: 所有决策必须记录

系统 MUST 为每一次权限决策（auto_allow / deny_hard / prompt 后用户选择 / prompt 被 UI 缺失拒绝）追加一条审计记录。

**例外**：auto_allow 中"项目内非敏感路径的常规读写"（未配置、无敏感匹配、project_inner 区域）MUST NOT 记录，避免日志被日常开发噪音淹没。

#### Scenario: 弹窗放行写入审计

- **WHEN** 用户从弹窗选择"总是允许"
- **THEN** 审计日志新增一条记录，`event = "allow_persistent"`

#### Scenario: 硬拒绝写入审计

- **WHEN** 决策为 deny_hard
- **THEN** 审计日志新增一条记录，`event = "hard_deny"`

#### Scenario: 常规 auto_allow 不写审计

- **WHEN** 工具在项目内读写未配置非敏感普通文件
- **THEN** 无审计记录

### Requirement: 日志文件位置与格式

审计日志 MUST 写入 `~/.pi/agent/extensions/@permission-system:pi-extension/logs/permission-review.jsonl`，JSONL 格式（每行一条 JSON 记录，`ts` 字段由系统注入）。

#### Scenario: 日志追加写入

- **WHEN** 系统完成一次需要记录的决策
- **THEN** 日志文件末尾新增一行合法 JSON

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
| `command` | 字符串 \| null | bash 命令原文（文件工具为 null） |
| `region` | `"project_inner" \| "project_outer"` | 区域判定 |
| `declaration` | `"read_write" \| "read_only" \| "unread" \| "sensitive_default" \| "unconfigured"` | 触发本次决策的声明类型 |
| `permission` | `"read_write" \| "read_only" \| null` | 若已配置则记录权限级别 |
| `toolCallId` | 字符串 | pi 分配的 tool call id |
| `note` | 字符串 \| 缺省 | 附加说明（如"no UI, denied"、"unreliable bash extraction"） |

#### Scenario: 记录字段完整

- **WHEN** 用户拒绝一次 tier=three 弹窗
- **THEN** 审计日志新增记录包含 `event="deny"`、`tool="write"`、`path="/abs/path"`、`projectHash`、`permission="read_write"`、`toolCallId`

### Requirement: 日志写入不影响决策流程

审计日志写入 MUST 异步执行（fire-and-forget），任何写入失败（磁盘满、权限不足）MUST NOT 阻塞工具调用或触发错误提示——只允许在 `note` 字段中记录写入失败情况（尽力而为）。

#### Scenario: 磁盘满时不阻塞工具

- **WHEN** 审计日志目录不可写
- **THEN** 工具调用按决策结果放行 / 拒绝，不因日志失败而阻塞

### Requirement: 日志串行化

并发工具调用场景下，日志写入 MUST 通过串行队列，禁止并发 append 到同一文件描述符导致行错行。

#### Scenario: 并发工具调用不产生错行

- **WHEN** 两个工具调用同时触发审批，同一毫秒内完成决策
- **THEN** 日志文件中两行均为合法 JSON，无字节错位

### Requirement: 日志文件目录自动创建

写入前 MUST 检查 `~/.pi/agent/extensions/@permission-system:pi-extension/logs/` 目录存在，不存在则递归创建。

#### Scenario: 首次写入自动创建目录

- **WHEN** 用户首次运行扩展并触发一次审计写入
- **THEN** `logs/` 目录被创建，日志文件被创建
