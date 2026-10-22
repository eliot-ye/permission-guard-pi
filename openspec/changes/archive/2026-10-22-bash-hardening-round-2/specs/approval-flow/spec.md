## ADDED Requirements

### Requirement: cd cwd 变更命令弹窗副文本

当 bash 命令被判定为不可靠（`extractBashTargets` 返回 `reliable: false`）且 `bash_reason == "cd_chdir"` 时，弹窗副文本 MUST 与既有 `glob_expansion` / `control_flow` / `shell_forwarder` / `forwarding_command` 副文本并列分派，说明"命令包含 `cd` 会改变后续命令的工作目录基准，相对路径无法静态确定"。

**理由**：`cd` 改变 cwd 基准，后续命令中所有相对路径（如 `.`、`a.txt`）的实际落点由运行时 cwd 决定，静态分析无法预测。用户看到此类弹窗时，副文本必须明确指出"这是 cd 引起的、建议用绝对路径或选择会话内允许"。

**位置**：本 requirement 与既有"bash 命令无法静态解析弹窗副文本"系列的 `glob_expansion` / `control_flow` / `shell_forwarder` / `forwarding_command` 副文本 scenario 并列，不改变既有副文本。

#### Scenario: bash 命令 cd cwd 变更类 prompt 副文本

- **WHEN** 用户看到 tier=two 弹窗，`bash_reason == "cd_chdir"`（例如 `cd /etc && rm -rf .`）
- **THEN** 弹窗副文本包含："该命令包含 cd 命令，改变后续命令的工作目录基准，相对路径无法静态确定实际访问的文件路径。建议使用绝对路径或选择「会话内允许」避免重复弹窗"

#### Scenario: cd cwd 变更类 prompt 与其他 bash 副文本互斥

- **WHEN** 用户看到 tier=two 弹窗，`bash_reason` 为 `cd_chdir` / `glob_expansion` / `control_flow` / `shell_forwarder` / `forwarding_command` 之一
- **THEN** 弹窗副文本按 `bash_reason` 精确分派，不使用统一文案，不与既有其他副文本重叠
