## ADDED Requirements

### Requirement: auto_allow 决策携带授权来源标注

系统 MUST 在每个 `kind === "auto_allow"` 的决策对象上标注 `authorization` 与 `grant_source` 两个字段，供上层（extension 层、审计日志）追溯授权来源；`kind === "deny_hard"` 与 `kind === "prompt"` 的决策对象 MUST NOT 携带这两个字段。

- `authorization` 取值范围：
  - `"presumed"`：系统判定授权，非真人主动操作
  - `"by_person"`：真人主动授权（当前仅从 grant memory 命中派生——`decide()` 是纯函数，无法直接产生 `"by_person"`）
- `grant_source` 取值范围：
  - `"config_declaration"`：配置声明命中（`read_only` 读 或 项目内 `read_write` 读/写）
  - `"allow_rule"`：tool+pattern allow 规则命中且目标非敏感
  - `"grant_memory"`：path-based grant memory 命中
  - `"bash_grant_memory"`：bash 命令 grant memory 命中
  - `"default"`：无配置、无规则、无记忆命中，按区域+敏感默认规则判定（含项目内非敏感、项目外非敏感读、`/tmp/**` 兜底）

**语义约束**：
- 决策引擎（`decide()`）内部产生的 `authorization` MUST 恒为 `"presumed"`——真人授权信号只从 extension 层的弹窗选择派生，不属于决策引擎的输入
- `grant_memory` 与 `bash_grant_memory` 命中的 `authorization` MUST 由命中的 Grant 记录自身的 `author` 字段决定（详见 grant-memory spec 的"Grant 记录 author 字段" requirement）；当前所有持久化 grant 均由真人弹窗写入，因此实际取值恒为 `"by_person"`，类型能力保留未来扩展

#### Scenario: 配置声明命中 read_only 读 auto_allow

- **WHEN** 配置声明某路径为 `read_only`，工具对该路径读
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "config_declaration"`

#### Scenario: 项目内 read_write 读写 auto_allow

- **WHEN** 配置声明某项目内路径为 `read_write`，工具读写
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "config_declaration"`

#### Scenario: allow 规则命中非敏感路径

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令 `git status`（非敏感目标）
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "allow_rule"`

#### Scenario: 项目内非敏感默认 auto_allow

- **WHEN** 无配置，工具在项目内读写非敏感普通文件
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "default"`

#### Scenario: /tmp 兜底 auto_allow

- **WHEN** 无配置，工具写 `/tmp/x.txt`
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "presumed"`，`grant_source === "default"`

#### Scenario: deny_hard 不带授权字段

- **WHEN** 决策为 `deny_hard`（unread 命中 或 deny 规则命中）
- **THEN** 决策对象不包含 `authorization` 字段与 `grant_source` 字段

#### Scenario: prompt 不带授权字段

- **WHEN** 决策为 `prompt`（任意 tier 弹窗触发）
- **THEN** 决策对象不包含 `authorization` 字段与 `grant_source` 字段

#### Scenario: grant memory 命中带 by_person 授权

- **WHEN** path-based grant memory 命中（用户之前对同一路径选过"总是允许"或"会话内允许"）
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "by_person"`（继承 Grant.author），`grant_source === "grant_memory"`

#### Scenario: bash grant memory 命中

- **WHEN** bash 命令 grant memory 命中（用户对同 rawCommand 之前做过 bash 授权）
- **THEN** 决策 `kind === "auto_allow"`，`authorization === "by_person"`，`grant_source === "bash_grant_memory"`
