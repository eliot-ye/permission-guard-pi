# access-decision Specification

## ADDED Requirements

### Requirement: 运行时状态自保护（trusted.json / settings.json 写保护）

系统 MUST 对权限门的运行时状态文件——授权记忆文件 `trusted.json` 与设置文件 `settings.json`——的写 / delete 一律决策为 `deny_hard`：

- 不弹窗、不可被授权记忆绕过、不可被配置声明覆盖（即使声明 `"<受保护文件路径>": "read_write"` 也 MUST 仍为 deny_hard）；
- 读这些文件 MUST 不受影响（按常规规则判定，非 deny_hard）；
- 自保护判定 MUST 在配置声明解析与授权记忆查询**之前**执行（保证不可豁免）。

#### Scenario: 写 trusted.json 硬拒

- **WHEN** 工具写 `~/.pi/agent/extensions/permission-guard-pi/trusted.json`
- **THEN** 决策为 deny_hard，reason 指明自保护（含 `self-protected`，与既有 reason 英文风格一致）

#### Scenario: 写 settings.json 硬拒

- **WHEN** 工具写 `~/.pi/agent/extensions/permission-guard-pi/settings.json`（例如设置 `enabled: false`）
- **THEN** 决策为 deny_hard

#### Scenario: delete 受保护文件硬拒

- **WHEN** 工具 delete `trusted.json` 或 `settings.json`
- **THEN** 决策为 deny_hard

#### Scenario: 配置声明不能重新放行

- **WHEN** 配置声明 `"<trusted.json 绝对路径>": "read_write"`，工具仍写该文件
- **THEN** 决策为 deny_hard（配置声明不豁免自保护）

#### Scenario: 授权记忆不能绕过自保护

- **WHEN** 用户曾对 `trusted.json` 选择"总是允许"，工具再写该文件
- **THEN** 决策为 deny_hard（grant 记忆在自保护判定前不检查）

#### Scenario: 读受保护文件不受影响

- **WHEN** 工具读 `trusted.json` 或 `settings.json`
- **THEN** 决策按常规规则判定（非 deny_hard；项目外非敏感读 → auto_allow，命中敏感规则 → prompt）

#### Scenario: bash 写目标命中受保护文件

- **WHEN** bash 命令含写目标为受保护运行时状态文件（例如 `echo '{"grants":[]}' > <trusted.json 路径>`）
- **THEN** 决策为 deny_hard（bash 写目标扫描命中自保护）

#### Scenario: 不可靠 bash 命中受保护文件（无 grant）仍硬拒

- **WHEN** bash 命令不可靠（如含 forwarder 或控制流，写目标未被可靠提取）且无 bash grant，命令字符串含受保护运行时状态文件路径 token（如 `sh -c 'echo x > <trusted.json 路径>'`）
- **THEN** 决策为 deny_hard（不可靠分支 tier=three prompt 之前做 L1 保护扫描，grant 缺失不豁免）

### Requirement: 配置写保护（permission.json 写保护）

系统 MUST 对权限配置文件 `permission.json`（global `~/.pi/agent/permission.json`、project `<proj>/.pi/permission.json`、project-local `<proj>/.pi/local/permission.json`）的写 / delete，在无 session grant 时一律决策为 `prompt tier=two`：

- 不静默 auto_allow（即使该项目内非敏感路径默认静默，MUST 仍 prompt）；
- `declaration` 为 `"config_write"`；
- 不可被配置声明静默化（即使声明 `"<permission.json 路径>": "read_write"`，MUST 仍 prompt）；
- **无**"总是允许"（tier=two 不可持久化），session grant 可放行本会话；
- 读这些文件 MUST 不受影响（按常规规则判定）。

#### Scenario: 写项目 permission.json 弹两档

- **WHEN** 工具写 `<proj>/.pi/permission.json`（项目内、非敏感、无 session grant）
- **THEN** 决策为 prompt tier=two，`declaration` 为 `"config_write"`，弹窗不出现"总是允许"

#### Scenario: 写 project-local permission.json 弹两档

- **WHEN** 工具写 `<proj>/.pi/local/permission.json`（无 session grant）
- **THEN** 决策为 prompt tier=two，`declaration` 为 `"config_write"`

#### Scenario: 写全局 permission.json 弹两档

- **WHEN** 工具写 `~/.pi/agent/permission.json`（无 session grant）
- **THEN** 决策为 prompt tier=two，`declaration` 为 `"config_write"`

#### Scenario: 配置声明不能静默化

- **WHEN** 配置声明 `"<permission.json 路径>": "read_write"`，工具仍写该文件（无 session grant）
- **THEN** 决策为 prompt tier=two（配置声明不使配置写静默）

#### Scenario: 读 permission.json 不受影响

- **WHEN** 工具读 `<proj>/.pi/permission.json`
- **THEN** 决策按常规规则判定（项目内非敏感读 → auto_allow；命中敏感规则 → prompt）

#### Scenario: bash 写目标命中 permission.json

- **WHEN** bash 命令含写目标为 `permission.json`（例如 `echo '{"**":"read_write"}' > <permission.json 路径>`，无 session grant）
- **THEN** 决策为 prompt tier=two（bash 写目标扫描命中配置写保护）

#### Scenario: 不可靠 bash 命中 permission.json（无 grant）仍弹两档

- **WHEN** bash 命令不可靠（如含 forwarder 或控制流，写目标未被可靠提取）且无 bash grant，命令字符串含 `permission.json` 路径 token（如 `sh -c 'echo x > <permission.json 路径>'`）
- **THEN** 决策为 prompt tier=two，`declaration` 为 `"config_write"`（不可靠分支 tier=three prompt 之前做 L2 保护扫描）
