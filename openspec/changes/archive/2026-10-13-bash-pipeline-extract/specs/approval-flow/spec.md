# approval-flow

## MODIFIED Requirements

### Requirement: 弹窗内容包含关键信息

弹窗文案 MUST 至少包含：

- 目标路径（或 bash 命令原文）
- 操作类型（读 / 写 / delete）
- 权限级别（若已配置）或"未配置"标记
- 若 tier=three：说明"总是允许将保存到 <trusted.json 绝对路径>"

tier=two 的副文本 MUST 按决策来源分派，MUST NOT 使用统一文案：

- 外层敏感路径（decision.declaration == "sensitive_default" 且 region == "project_outer"）：提示"敏感系统路径不能持久化，如需长期允许请编辑 permission.json"
- bash 命令无法静态解析（decision.declaration == "unconfigured" 且 bash 场景）：提示"命令无法静态解析，请审阅整条命令；无法通过配置持久化"

两条副文本 MUST 与 tier=three 的持久化提示互斥——tier=two 不出现"总是允许将保存到 <trusted.json>"字样。

#### Scenario: 三档弹窗显示保存位置

- **WHEN** 用户看到 tier=three 弹窗（配置声明路径）
- **THEN** 弹窗文案包含字符串 `~/.pi/agent/extensions/@permission-system:pi-extension/trusted.json`

#### Scenario: 两档弹窗显示提示

- **WHEN** 用户看到 tier=two 弹窗
- **THEN** 弹窗副文本 MUST 按决策来源分派——不包含统一"未配置"字样；具体副文本见下方两个分派 scenario

#### Scenario: 外层敏感路径弹窗副文本

- **WHEN** 用户看到 tier=two 弹窗，决策来源为"项目外敏感路径 + 未配置"
- **THEN** 弹窗文案包含"敏感系统路径不能持久化"字样；**不包含**"未配置路径"字样；**不包含**"总是允许将保存到"字样

#### Scenario: bash 命令无法静态解析弹窗副文本

- **WHEN** 用户看到 tier=two 弹窗，决策来源为"bash 命令不可靠"（例如 `find /etc | xargs rm`）
- **THEN** 弹窗文案包含"命令无法静态解析"字样；**不包含**"permission.json"字样（该来源无法通过配置修复）；**不包含**"总是允许将保存到"字样
