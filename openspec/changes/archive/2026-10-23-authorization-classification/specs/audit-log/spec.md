## ADDED Requirements

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
