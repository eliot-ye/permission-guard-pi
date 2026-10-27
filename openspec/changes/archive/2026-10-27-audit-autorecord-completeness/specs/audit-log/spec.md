# Spec: Audit auto-allow record completeness (D1/D2)

## Capability: audit-log (delta)

## ADDED Requirements

### Requirement: auto_allow 决策记录完整性

**Level: should**

系统的 auto_allow 决策（除"项目内未配置非敏感常规读写"外）SHALL 追加审计记录，`event = "auto_allow"`，并透传决策对象的 `authorization` 与 `grant_source` 字段（audit-log spec "auto_allow 从决策对象透传"）。

- **WHEN** 决策为 auto_allow（config 声明 / allow 规则 / grant 命中 / 项目外 read / tmp default）
- **THEN** 审计日志新增一条 `event = "auto_allow"` 记录，含决策对象的 `authorization` / `grant_source`

#### Scenario: config 声明的 auto_allow 写入审计

- **WHEN** 工具读取 config 声明为 `read_only` 的路径
- **THEN** 审计日志新增 `event = "auto_allow"`，`grant_source = "config_declaration"`

#### Scenario: 项目内未配置非敏感常规不写审计

- **WHEN** 工具读写项目内未配置非敏感普通文件（`in_project_default_allowed`）
- **THEN** 无审计记录（spec 例外保留）

### Requirement: bash hard_deny 携带授权来源标注

**Level: must**

可靠 bash 命令的 `hard_deny` 决策 SHALL 在审计记录中携带 `authorization = "presumed"`（与文件工具 hard_deny 对齐），`grant_source` 省略（hard_deny 非授权事件）。

- **WHEN** 可靠 bash 命令的 target 命中 `unread` 或 deny 规则 → hard_deny
- **THEN** 审计记录含 `event = "hard_deny"`、`authorization = "presumed"`，无 `grant_source`

#### Scenario: 可靠 bash unread target hard_deny 标 presumed

- **GIVEN** 可靠 bash 命令 `cat /etc/passwd`，且 `/etc/passwd` 配置为 `unread`
- **WHEN** 该命令触发 hard_deny
- **THEN** 审计记录含 `event = "hard_deny"`、`authorization = "presumed"`，无 `grant_source`
