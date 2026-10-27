# Spec: Bash grant whitespace normalization (P1 e2)

## Capability: grant-memory (delta)

## ADDED Requirements

### Requirement: Bash grant 词法 whitespace 等价

**Level: should**

系统的 bash 命令 grant 键派生（`command_hash`）SHALL 先做**词法 whitespace 规范化**（`replace(/\s+/g," ").trim()`）再 SHA-256，使 `git  status`（双空格）与 `git status` 命中同一 grant。

- **WHEN** 用户已授权 `git status`（持久），随后命令为 `git  status`（双空格）
- **THEN** 命中同一 grant，auto-allow 不再弹窗

#### Scenario: 词法 whitespace 等价命中同一 grant

- **GIVEN** 用户已授权 `git status`（持久）
- **WHEN** 随后命令为 `git  status`（双空格）
- **THEN** 命中同一 grant（hash 输入已做词法 whitespace 规范化），auto-allow 不再弹窗

#### Scenario: 参数不同不命中

- **GIVEN** 用户已授权 `git status`（持久）
- **WHEN** 随后命令为 `git status --short`
- **THEN** 不命中（参数不同 → 不同命令），走 tier=three 弹窗

#### Scenario: 语法级语义漂移不做等价

- **GIVEN** 用户已授权 `git status`（持久）
- **WHEN** 随后命令为 `bash -c "git status"` 或 `cd /tmp && git status`
- **THEN** 不命中（shell-forwarder / cwd 漂移属语义漂移，MUST NOT 判等价），走 tier=three 弹窗

#### Scenario: audit 与 grant 键派生一致

- **WHEN** bash 命令 > 511 字符被截断
- **THEN** audit 记录含 `commandHash = bashCommandHash(原始命令)`，与 `trusted.json` 的 `bashGrants[].commandHash` 派生一致
