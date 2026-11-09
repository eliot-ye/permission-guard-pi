# approval-flow Specification

## ADDED Requirements

### Requirement: 配置写弹窗副文本分派

当决策为 prompt tier=two 且 `declaration` 为 `"config_write"`（见 access-decision「配置写保护」要求）时，弹窗副文本 MUST 按 lang 分派，说明"权限配置写操作不可持久化（无'总是允许'），如需长期允许请直接编辑 permission.json"。

#### Scenario: 配置写弹窗副文本（lang=zh）

- **WHEN** 决策为 prompt tier=two，`declaration` 为 `"config_write"`（例如写 `<proj>/.pi/permission.json`），当前 lang=zh
- **THEN** 弹窗副文本包含中文"权限配置写操作不可持久化"字样；**包含**"请直接编辑 permission.json"字样

#### Scenario: 配置写弹窗副文本（lang=en）

- **WHEN** 决策为 prompt tier=two，`declaration` 为 `"config_write"`，当前 lang=en
- **THEN** 弹窗副文本包含英文 `Permission config write cannot be persisted` 字样；**包含** `edit permission.json` 字样
