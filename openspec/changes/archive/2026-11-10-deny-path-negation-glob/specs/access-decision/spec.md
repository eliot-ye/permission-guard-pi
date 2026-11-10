# access-decision Specification

## ADDED Requirements

### Requirement: path-based deny 段检查

决策引擎 SHALL 在 path 解析之前检查配置的 `deny` 段（path-based deny 规则，含 `!` 否定豁免）。检查顺序：

1. **tool+pattern deny 规则检查**（既有 step 0，最高优先级）
2. **path-based deny 段检查**（新增 step 0.5）：若 `resolveDenyPath(absPath)` 命中（正向命中且未命中任一 `!` 否定），决策为 `deny_hard`，不检查后续任何规则
3. **path 解析**（既有 step 1，`paths` 表）
4. ...（其余步骤不变）

**deny-path 是无条件的**：不论路径是否敏感、不论区域、不论操作，deny-path 命中即硬拒绝（对齐 tool+pattern deny 的无条件语义）。

**与 tool+pattern deny 的关系**：两者互补并存——tool+pattern deny 按工具/命令精确拦截（保持最高优先级），path-based deny 按路径泛拦；两者都在 path 解析之前，deny 优先于任何 permission 声明。

**与 `sensitive.ts` hard 敏感的边界**：`!` 否定豁免**不作用于** `sensitive.ts` 硬编码 hard 敏感规则——`resolveDenyPath` 只判定用户配置的 `deny` 段；hard 敏感命中走敏感兜底分支（非 deny-path），其保护不可配豁免。

#### Scenario: deny-path 命中判 deny_hard

- **WHEN** 配置声明 `"deny": ["**/*.pem"]`，工具写 `<proj>/certs/root.pem`
- **THEN** 决策为 `deny_hard`，`reasonCode` 为 `deny_path_hit`

#### Scenario: deny-path 否定豁免不判 deny_hard

- **WHEN** 配置声明 `"deny": ["**/*.pem", "!**/public.pem"]`，工具写 `<proj>/certs/public.pem`
- **THEN** deny-path 未命中（`!` 豁免），继续后续规则判定（非 deny_hard）

#### Scenario: deny-path 优先于 path 声明

- **WHEN** 配置声明 `"deny": ["**/*.pem"]` 且 `"paths": { "**/*.pem": "read_write" }`，工具写 `<proj>/certs/root.pem`
- **THEN** 决策为 `deny_hard`（deny-path 在 path 解析之前，优先于 permission 声明）

#### Scenario: tool+pattern deny 优先于 deny-path

- **WHEN** 配置声明 tool+pattern deny 规则 `{ "tool": "bash", "pattern": "rm *", "action": "deny" }` 且 `"deny": ["**/*"]`，bash 命令为 `rm -rf /x`
- **THEN** 决策为 `deny_hard`，`reasonCode` 为 `rule_denied`（tool+pattern deny 在 step 0 最高优先级，先于 deny-path step 0.5）

#### Scenario: 未配置 deny 段不触发 deny-path 检查

- **WHEN** 配置不含 `deny` 字段，工具访问任意路径
- **THEN** `resolveDenyPath` 恒返 false，deny-path 检查不命中，行为与引入前一致

#### Scenario: deny-path 不论操作均硬拒

- **WHEN** 配置声明 `"deny": ["**/*.pem"]`，工具读 `<proj>/certs/root.pem`（read 操作）
- **THEN** 决策为 `deny_hard`（deny-path 无条件，不论操作类型）

#### Scenario: deny-path 不论区域均硬拒

- **WHEN** 配置声明 `"deny": ["**/*.pem"]`，工具写项目内 `<proj>/certs/root.pem` 与项目外 `/other/root.pem`
- **THEN** 两者均决策为 `deny_hard`（deny-path 无条件，不论区域）
