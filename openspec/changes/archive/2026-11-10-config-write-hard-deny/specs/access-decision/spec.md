# access-decision Specification

## MODIFIED Requirements

### Requirement: 配置写保护（permission.json 写保护）

系统 MUST 对权限配置文件 `permission.json`（global `~/.pi/agent/permission.json`、project `<proj>/.pi/permission.json`、project-local `<proj>/.pi/local/permission.json`）的写 / delete 一律决策为 `deny_hard`：

- 不弹窗、不静默 auto_allow（即使该项目内非敏感路径默认静默，MUST 仍 deny_hard）；
- `declaration` 为 `"config_write"`（deny 溯源标记，区别于普通 `unconfigured` deny）；
- 不可被配置声明覆盖（即使声明 `"<permission.json 路径>": "read_write"`，MUST 仍 deny_hard）；
- 不可被授权记忆绕过（session grant 与 persistent grant 均 MUST NOT 放行——对齐 L1 运行时状态「不可被 grant 豁免」不变量，防止一次人批即改配置自我提权）；
- 自保护判定 MUST 在授权记忆查询**之前**执行（保证不可豁免）；
- 读这些文件 MUST 不受影响（按常规规则判定）。

#### Scenario: 写项目 permission.json 弹两档

- **WHEN** 工具写 `<proj>/.pi/permission.json`（项目内、非敏感、无 session grant）
- **THEN** 决策为 deny_hard，`declaration` 为 `"config_write"`，不弹窗（原判 prompt tier=two，本 change 升级为硬 deny）

#### Scenario: 写 project-local permission.json 弹两档

- **WHEN** 工具写 `<proj>/.pi/local/permission.json`（无 session grant）
- **THEN** 决策为 deny_hard，`declaration` 为 `"config_write"`

#### Scenario: 写全局 permission.json 弹两档

- **WHEN** 工具写 `~/.pi/agent/permission.json`（无 session grant）
- **THEN** 决策为 deny_hard，`declaration` 为 `"config_write"`

#### Scenario: delete permission.json 硬拒

- **WHEN** 工具 delete 任一 `permission.json`
- **THEN** 决策为 deny_hard，`declaration` 为 `"config_write"`

#### Scenario: 配置声明不能静默化

- **WHEN** 配置声明 `"<permission.json 路径>": "read_write"`，工具仍写该文件（无 session grant）
- **THEN** 决策为 deny_hard（配置声明不豁免配置写自保护）

#### Scenario: session grant 不能绕过配置写保护

- **WHEN** 用户曾在会话内对 `permission.json` 获得放行（session grant 存在），工具再写该文件
- **THEN** 决策为 deny_hard（session grant 在配置写自保护判定前不检查——一次人批不可改配置）

#### Scenario: persistent grant 不能绕过配置写保护

- **WHEN** `permission.json` 存在持久化 grant，工具写该文件
- **THEN** 决策为 deny_hard（配置写自保护在 grant 检查前执行，不可豁免）

#### Scenario: 读 permission.json 不受影响

- **WHEN** 工具读 `<proj>/.pi/permission.json`
- **THEN** 决策按常规规则判定（项目内非敏感读 → auto_allow；命中敏感规则 → prompt）

#### Scenario: bash 写目标命中 permission.json

- **WHEN** bash 命令可靠且含写目标为 `permission.json`（例如 `echo '{"**":"read_write"}' > <permission.json 路径>`）
- **THEN** 决策为 deny_hard（bash 写目标经 `decideTarget` 命中配置写保护）

#### Scenario: 不可靠 bash 命中 permission.json（无 grant）仍弹两档

- **WHEN** bash 命令不可靠（如含 forwarder 或控制流，写目标未被可靠提取）且无 bash grant，命令字符串含 `permission.json` 路径 token（如 `sh -c 'echo x > <permission.json 路径>'`）
- **THEN** 决策为 deny_hard，`declaration` 为 `"config_write"`（不可靠分支 tier=three prompt 之前做 L2 保护扫描）

#### Scenario: 不可靠 bash 有 grant 命中 permission.json 仍硬拒

- **WHEN** bash 命令不可靠且存在 bash grant，命令字符串含 `permission.json` 路径 token
- **THEN** 决策为 deny_hard（bash grant 不豁免配置写自保护，与 L1 运行时状态同级不可绕过）
