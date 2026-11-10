# audit-log Specification

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
| `declaration` | `"read_write" \| "read_only" \| "unread" \| "sensitive_default" \| "unconfigured" \| "config_write"` | 触发本次决策的声明类型（`config_write` 见 access-decision「配置写保护」要求——config-write-hard-deny 后仅出现于 deny_hard 路径） |
| `permission` | `"read_write" \| "read_only" \| null` | 若已配置则记录权限级别 |
| `toolCallId` | 字符串 | pi 分配的 tool call id |
| `note` | 字符串 \| 缺省 | 附加说明（如"no UI, denied"、"unreliable bash extraction"、"command truncated"） |

`command` 字段截断约束：

- 阈值固定为 512 字符
- 截断保留前 511 字符并追加 Unicode 省略号 `…`
- 截断时若 `note` 字段已有内容，系统 MUST NOT 覆盖既有 `note`；应把截断标记追加到既有 `note` 末尾（用 `; command truncated` 连接），若既有 `note` 缺省则直接使用 `command truncated`
- 长度 ≤ 512 字符的 `command` 字段 MUST 保持原样，不追加 `note`
- `command` 为 `null` 时 MUST NOT 触发截断或 note 追加

#### Scenario: 记录字段完整

- **WHEN** 用户拒绝一次 tier=three 弹窗
- **THEN** 审计日志新增记录包含 `event="deny"`、`tool="write"`、`path="/abs/path"`、`projectHash`、`permission="read_write"`、`toolCallId`

#### Scenario: 配置写弹窗记录字段完整

- **WHEN** 工具写 `permission.json` 触发配置写自保护硬拒（见 access-decision「配置写保护」——config-write-hard-deny 后为 deny_hard，非弹窗）
- **THEN** 审计日志新增 `event = "hard_deny"` 记录、`declaration="config_write"`、`permission=null`（配置写无已配置权限级别）、`authorization="presumed"`（系统决策）

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

**注**：原 `config_write` 派生条目（非 bash → `default` / bash → `bash_grant_memory`）随 config-write-hard-deny 移除——config_write 不再走弹窗授权路径（已升级为 deny_hard），deny_hard 为系统决策（`authorization: "presumed"`，无 `grant_source`），不产生真人 `grant_source` 派生。

#### Scenario: 真人"总是允许"选择落日志带 by_person

- **WHEN** 用户对 tier=three 弹窗选"总是允许"
- **THEN** 审计日志 `event: "allow_persistent"`，`authorization: "by_person"`，`grant_source` 按弹窗触发来源派生（如 `config_declaration` 或 `default`）

#### Scenario: 配置写弹窗授权来源为 default

- **WHEN** 工具写 `permission.json` 触发配置写自保护硬拒（config-write-hard-deny 后为 deny_hard，非弹窗授权）
- **THEN** 审计日志 `event: "hard_deny"`，`authorization: "presumed"`，无 `grant_source`（系统决策非授权事件）

#### Scenario: 真人"拒绝"选择也标 by_person

- **WHEN** 用户对弹窗选"拒绝"
- **THEN** 审计日志 `event: "deny"`，`authorization: "by_person"`（真人拒绝也是真人决策）

#### Scenario: 系统硬拒绝标 presumed

- **WHEN** 决策为 `deny_hard`（如 unread 命中 或 配置写自保护命中）
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
