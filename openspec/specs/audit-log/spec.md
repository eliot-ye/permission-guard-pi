# audit-log Specification

## Purpose
定义审计日志的追加写入契约——所有权限决策都进入 JSONL 日志，字段覆盖用户可复核的完整上下文，串行写入保证不产生损坏行。

## Requirements

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

审计日志 MUST 写入 `~/.pi/agent/extensions/@permission-guard/pi/logs/permission-review.jsonl`，JSONL 格式（每行一条 JSON 记录，`ts` 字段由系统注入）。

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

写入前 MUST 检查 `~/.pi/agent/extensions/@permission-guard/pi/logs/` 目录存在，不存在则递归创建。

#### Scenario: 首次写入自动创建目录

- **WHEN** 用户首次运行扩展并触发一次审计写入
- **THEN** `logs/` 目录被创建，日志文件被创建

### Requirement: 日志文件目录与文件权限

审计日志目录与日志文件 MUST 以最小必要权限创建，防止同机其他用户 / 进程读取到审计内容（其中包含 bash 命令原文与敏感路径）。

具体约束：

- 首次创建 `~/.pi/agent/extensions/@permission-guard/pi/logs/` 目录时，MUST 使用 `0o700` 权限（`fs.mkdir({ mode: 0o700, recursive: true })`）
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

### Requirement: 审计记录携带授权来源标注

系统 MUST 在每次审计记录中包含 `authorization` 与 `grant_source` 两个字段（均可选，旧日志无字段兼容），使审计消费者**无需解析 note 字段**即可回答"这次决策是谁做的"与"具体从哪个来源判定"。

- `authorization` 取值范围：`"presumed" | "by_person" | undefined`
- `grant_source` 取值范围：`"config_declaration" | "allow_rule" | "grant_memory" | "bash_grant_memory" | "default" | undefined`

**语义约束**：
- `authorization` 字段表示"**谁做出了这个决策**"（不是"是否授予了权限"）——真人拒绝弹窗也是真人决策，MUST 标 `"by_person"`
- 决策引擎产生的 auto_allow（见 access-decision spec）→ `authorization` 与 `grant_source` 从决策对象透传
- 真人弹窗事件（allow_once / allow_session / allow_persistent / deny / conflict_prompt）→ `authorization === "by_person"`
- `hard_deny` 事件（系统硬拒绝）→ `authorization === "presumed"`
- 旧日志（无 `authorization` 字段）在读取时 MUST 视为 `undefined`，消费者按此判断版本并回退

**event → authorization 映射规则**（系统实现 MUST 保证）：

| event | authorization |
|---|---|
| `allow_once` | `by_person` |
| `allow_session` | `by_person` |
| `allow_persistent` | `by_person` |
| `deny` | `by_person` |
| `conflict_prompt` | `by_person` |
| `hard_deny` | `presumed` |
| `auto_allow` | 从 Decision 对象透传（见 access-decision spec） |

**grant_source 派生规则**（真人弹窗事件）：
- 弹窗触发的 Decision.declaration 为 `read_write` 或 `read_only` → `grant_source === "config_declaration"`
- 弹窗触发的 Decision.declaration 为 `sensitive_default` 或 `unconfigured` → `grant_source === "default"`
- bash 命令授权事件（bashReason 存在）→ `grant_source === "bash_grant_memory"`（本次授权将写入 bash grant memory）
- path-based 弹窗（非 bash）→ `grant_source` 缺省（真人授权事件本身不写入 path grant memory；写入的 grant 是新的，其 authorization 属性由本条审计记录的 `authorization: "by_person"` 语义表达）

#### Scenario: 真人"总是允许"选择落日志带 by_person

- **WHEN** 用户对 tier=three 弹窗选"总是允许"
- **THEN** 审计日志 `event: "allow_persistent"`，`authorization: "by_person"`，`grant_source` 按弹窗触发来源派生（如 `config_declaration` 或 `default`）

#### Scenario: 真人"拒绝"选择也标 by_person

- **WHEN** 用户对弹窗选"拒绝"
- **THEN** 审计日志 `event: "deny"`，`authorization: "by_person"`（真人拒绝也是真人决策）

#### Scenario: 系统硬拒绝标 presumed

- **WHEN** 决策为 `deny_hard`（如 unread 命中）
- **THEN** 审计日志 `event: "hard_deny"`，`authorization: "presumed"`

#### Scenario: auto_allow 从决策对象透传

- **WHEN** 决策为 auto_allow（决策对象已带 `authorization` 与 `grant_source`）
- **THEN** 审计日志的 `authorization` 与 `grant_source` 字段与决策对象字段值一致

#### Scenario: 既有日志无字段向后兼容

- **WHEN** 审计消费者读取本 change 之前的旧日志行（无 `authorization` / `grant_source` 字段）
- **THEN** 消费者按 `undefined` 处理，回退到既有 `event` 字段做兼容判断；本系统 MUST NOT 尝试给旧日志补字段

#### Scenario: grant_source 字段可缺省

- **WHEN** 一条审计记录的 `grant_source` 无法从上下文派生（如 auto_allow 决策对象未带 grant_source 的极端场景）
- **THEN** `grant_source` 字段缺省（不写入 `undefined` 到 JSON），`authorization` 字段仍按规则写入
