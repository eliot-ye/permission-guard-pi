# access-decision

## ADDED Requirements

### Requirement: tool+pattern 规则检查

决策引擎 SHALL 在 path 解析之前检查 tool+pattern 规则。检查顺序：

1. **deny 规则检查**（最高优先级）：若 resolveRule(toolName, toolPattern) 返回 `action: "deny"`，决策为 `deny_hard`，不检查后续任何规则
2. **path 解析**（现有逻辑不变）：检查 `paths` 表中的声明
3. **allow 规则检查**：若 path 解析未命中且 resolveRule 返回 `action: "allow"`，则：
   - **敏感路径硬底线**：若目标路径命中敏感规则表（默认敏感路径 或 配置声明的敏感），即使 allow 规则命中也 MUST 弹 prompt（tier 按敏感默认规则决定）
   - **非敏感路径**：决策为 `auto_allow`，跳过默认兜底
4. **默认兜底**（现有逻辑不变）：未命中任何规则时按区域+敏感默认规则决策

**关键约束**：allow 规则不绕过敏感路径检查——这是安全硬底线。用户配置 `Bash(git *)` 允许后，若 `git` 命令的操作目标路径命中敏感规则（如 `git push` 到远程含敏感路径），仍会弹窗。

**deny 规则是无条件的**：不论路径是否敏感、不论区域、不论操作，deny 命中即硬拒绝。

#### Scenario: allow 规则跳过非敏感路径弹窗

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令为 `git status`，无 paths 声明
- **THEN** 决策为 auto_allow（allow 规则命中，非敏感路径）

#### Scenario: allow 规则不绕过敏感路径

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，bash 命令为 `cat ~/.ssh/id_rsa`，无 paths 声明
- **THEN** 决策为 prompt（allow 规则命中但目标路径敏感，敏感硬底线生效）

#### Scenario: deny 规则无条件拒绝

- **WHEN** 配置声明 `{ "tool": "bash", "pattern": "rm *", "action": "deny" }`，bash 命令为 `rm -rf /`
- **THEN** 决策为 deny_hard（deny 无条件，不论路径是否敏感）

#### Scenario: deny 优先于 allow（同 tool+pattern）

- **WHEN** 全局声明 `{ "tool": "bash", "pattern": "git *", "action": "allow" }`，项目声明 `{ "tool": "bash", "pattern": "git *", "action": "deny" }`
- **THEN** 决策为 deny_hard（deny 优先于 allow，不论优先级来源）

#### Scenario: path 声明优先于 allow 规则

- **WHEN** 配置声明 `{ "paths": { "/etc": "unread" } }` 和 `{ "tool": "bash", "pattern": "cat *", "action": "allow" }`，bash 命令为 `cat /etc/passwd`
- **THEN** 决策为 deny_hard（path 声明 unread 优先于 allow 规则）
