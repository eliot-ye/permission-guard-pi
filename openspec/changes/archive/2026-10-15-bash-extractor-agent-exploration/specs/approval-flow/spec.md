# approval-flow

## MODIFIED Requirements

### Requirement: 两档 vs 三档弹窗

系统 SHALL 根据决策引擎返回的 `tier` 字段选择弹窗形态：

- **tier=three**（配置声明路径、或跨源冲突）：三档选项——"允许一次 / 会话内允许 / 总是允许"，加"拒绝"
- **tier=two**（未配置路径、敏感兜底、非 bash 类无法解析命令）：两档选项——"允许一次 / 会话内允许"，加"拒绝"。**不出现"总是允许"**
- **tier=two bash 命令类**（bash 命令无法静态解析、包含 `bash_reason` 字段）：三档选项——"允许一次 / 会话内允许 / 总是允许本命令"，加"拒绝"。第 3 档将 rawCommand 写入 bash 命令持久化记忆（trusted.json 的 `bashGrants` 段）。

**修改**：新增 bash 命令类决策来源的判断逻辑。当决策包含 `bash_reason` 字段（由 `scanUnreliable` 返回的 reason，如 `glob_expansion`、`unresolved variable`、`control_flow`、`shell_forwarder`、`forwarding_command`、`device_redirect`、`bounded_glob`），将其视为 bash 命令类 prompt，适用特定副文本规则和额外的"总是允许本命令"选项。

#### Scenario: 配置声明路径弹三档

- **WHEN** 决策为 prompt tier=three（配置为 read_write 的项目外路径首次访问）
- **THEN** 弹窗显示 4 个选项：允许一次 / 会话内允许 / 总是允许 / 拒绝

#### Scenario: 未配置路径弹两档

- **WHEN** 决策为 prompt tier=two（未配置项目外敏感文件，非 bash 命令来源）
- **THEN** 弹窗显示 3 个选项：允许一次 / 会话内允许 / 拒绝

#### Scenario: bash 命令类 prompt 弹三档

- **WHEN** 决策为 prompt tier=two 且包含 `bash_reason` 字段（例如 `ls /tmp/*.log` 触发 glob_expansion）
- **THEN** 弹窗显示 4 个选项：允许一次 / 会话内允许 / 总是允许本命令 / 拒绝；第 3 档将 rawCommand 持久化到 trusted.json 的 `bashGrants` 段

### Requirement: 弹窗内容包含关键信息

弹窗文案 MUST 至少包含：

- 目标路径（或 bash 命令原文）
- 操作类型（读 / 写 / delete）
- 权限级别（若已配置）或"未配置"标记
- 若 tier=three：说明"总是允许将保存到 <trusted.json 绝对路径>"
- 若 tier=two bash 命令类：说明"总是允许本命令将保存到 <trusted.json 绝对路径>"

tier=two 的副文本 MUST 按决策来源分派，MUST NOT 使用统一文案：

- 外层敏感路径（decision.declaration == "sensitive_default" 且 region == "project_outer"）：提示"敏感系统路径不能持久化，如需长期允许请编辑 permission.json"
- **bash 命令类 prompt（包含 `bash_reason`）**：副文本根据 `bash_reason` 值动态生成（见下方细分 scenario），统一遵循：指出**为何无法通过静态解析**、**用户可如何避免重复弹窗**（选择"会话内允许"或"总是允许本命令"选项，或编写 permission.json glob）
- **其他 tier=two 来源**：回退通用文案"命令无法静态解析，请审阅整条命令；无法通过配置持久化"

两条副文本 MUST 与 tier=three 的持久化提示互斥——非 bash 类 tier=two 不出现"总是允许将保存到 <trusted.json>"字样；bash 类 tier=two 的"总是允许本命令"选项的持久化说明只涉及 rawCommand，不涉及路径 glob。

#### Scenario: 三档弹窗显示保存位置

- **WHEN** 用户看到 tier=three 弹窗（配置声明路径）
- **THEN** 弹窗文案包含字符串 `~/.pi/agent/extensions/@permission-system:pi-extension/trusted.json`

#### Scenario: 两档弹窗显示提示

- **WHEN** 用户看到非 bash 类 tier=two 弹窗
- **THEN** 弹窗副文本 MUST 按决策来源分派——不包含统一"未配置"字样；具体副文本见下方两个分派 scenario

#### Scenario: 外层敏感路径弹窗副文本

- **WHEN** 用户看到 tier=two 弹窗，决策来源为"项目外敏感路径 + 未配置"
- **THEN** 弹窗文案包含"敏感系统路径不能持久化"字样；**不包含**"未配置路径"字样；**不包含**"总是允许将保存到"字样

#### Scenario: bash 命令无法静态解析弹窗副文本

- **WHEN** 用户看到 tier=two 弹窗，决策来源为"bash 命令不可靠"但缺少 `bash_reason` 字段（回归保护，理论上不应发生）
- **THEN** 弹窗文案回退到旧统一副文本"命令无法静态解析"字样；**不包含**"permission.json"字样；**不包含**"总是允许将保存到"字样

#### Scenario: bash 命令 glob 类 prompt 副文本

- **WHEN** 用户看到 tier=two 弹窗，`bash_reason == "glob_expansion"`（例如 `ls /tmp/*.log`）
- **THEN** 弹窗副文本包含："该命令含未加引号的 glob 通配符，无法静态枚举目标文件。如需避免重复弹窗，请在 permission.json 中声明该路径 glob，或选择「会话内允许」"

#### Scenario: bash 命令设备重定向类 prompt 副文本

- **WHEN** 用户看到 tier=two 弹窗，`bash_reason == "device_redirect"`（例如 `cat file 2>/dev/null`）
- **THEN** 弹窗副文本包含："该命令重定向到 /dev/ 设备文件，属于无副作用丢弃输出。选择「会话内允许」可避免重复弹窗"

#### Scenario: bash 命令控制流类 prompt 副文本

- **WHEN** 用户看到 tier=two 弹窗，`bash_reason == "control_flow"`（例如 `while read x; do cat $x; done`）
- **THEN** 弹窗副文本包含："该命令包含控制流关键字（while/for/if 等），实际访问文件取决于运行时变量，无法静态确定。建议使用 grep/find 等工具替代 shell 循环；选择「会话内允许」可避免重复弹窗"

#### Scenario: bash 命令 shell 转发器类 prompt 副文本

- **WHEN** 用户看到 tier=two 弹窗，`bash_reason == "shell_forwarder"`（例如 `bash -c "rm -rf /"`）
- **THEN** 弹窗副文本包含："该命令通过 shell 转发器执行，字符串内的文件系统访问不可见于静态分析。建议直接执行命令而非嵌套 shell；选择「会话内允许」可避免重复弹窗"

#### Scenario: bash 命令转发器类 prompt 副文本

- **WHEN** 用户看到 tier=two 弹窗，`bash_reason == "forwarding_command"`（例如 `find /etc | xargs rm`）
- **THEN** 弹窗副文本包含："该命令使用转发器（xargs/parallel 等），下游参数来自上游 stdout，无法静态枚举。建议避免在管道后使用转发器；选择「会话内允许」可避免重复弹窗"

#### Scenario: bash 命令有界 glob 类 prompt 副文本

- **WHEN** 用户看到 tier=two 弹窗，`bash_reason == "bounded_glob"`（例如 `ls openspec/changes/archive/*/`，前缀在项目内且命令为 read-only）——**本 change 预期此类命令不再触发 tier=two**，此 scenario 为回归保护
- **THEN** 如仍触发 tier=two，副文本包含："该命令 glob 前缀在项目内且为只读命令，系统已可自动识别。如仍弹窗，可能是提取器版本不匹配；请更新扩展"

#### Scenario: bash 命令不可靠旧统一副文本已废弃

- **WHEN** 用户看到 tier=two 弹窗，决策来源为"bash 命令不可靠"（包含 `bash_reason` 字段）
- **THEN** **不再**使用统一副文本"命令无法静态解析，请审阅整条命令；无法通过配置持久化"；改用上述细分副文本

### Requirement: 硬拒绝不弹窗

若决策为 `deny_hard`，系统 MUST NOT 弹窗，直接向用户展示红色警告通知（`ctx.ui.notify(..., "warning")`），并阻止工具调用。

弹窗文案 MUST 包含：完整目标路径、拒绝原因（配置源）、"如需放行请编辑配置文件"。

#### Scenario: 硬拒绝只通知不弹审批

- **WHEN** 决策为 deny_hard（路径声明为 unread）
- **THEN** 触发 `ctx.ui.notify` 红色警告，返回 `{ block: true }`，不阻塞等待用户输入

### Requirement: 无 UI 模式失败关闭

若决策需要弹窗但当前会话无 UI（`ctx.hasUI === false`，非交互模式、JSON/RPC 模式下）：

- tier=three / tier=two 一律决策为"拒绝"
- 决策结果 MUST 记入审计日志
- 工具调用被 block

#### Scenario: RPC 模式下弹窗降级为拒绝

- **WHEN** pi 以 `--mode rpc` 启动，工具触发需要 tier=three 弹窗的场景
- **THEN** 返回 `{ block: true, reason: "no UI available, denied by default" }`，审计记录 deny

### Requirement: 用户"允许一次"仅放行单次调用

用户选择"允许一次"时，系统 MUST 仅放行本次工具调用，且 MUST NOT 写入任何记忆通道（下一次同一路径或同一条 bash 命令仍需弹窗）。

#### Scenario: 允许一次后再次访问重新弹

- **WHEN** 用户对配置为 read_write 的项目外路径选择"允许一次"
- **THEN** 本次调用放行；下一次同路径访问重新弹三档弹窗

#### Scenario: bash 命令允许一次后再次访问重新弹

- **WHEN** 用户对 tier=two bash 命令选择"允许一次"
- **THEN** 本次调用放行；下一次同 `rawCommand` 访问重新弹 tier=two 弹窗

### Requirement: 用户"会话内允许"写入会话级记忆

用户选择"会话内允许"时，系统 MUST 放行本次调用并写入会话级记忆；同一 session 内同（projectHash, action, absPath）或同（projectHash, rawCommand）后续访问 MUST 自动放行；重启 pi 后 MUST 清空会话级记忆。

**修改**：新增对 bash 命令类授权的"会话内允许"处理——写入 Bash 命令会话级记忆（`addBashSessionGrant`），键为 `(projectHash, sha256(rawCommand))`。

#### Scenario: 会话内允许在会话内免弹

- **WHEN** 用户对未配置项目外敏感文件选择"会话内允许"，同会话内再次访问同一文件
- **THEN** auto_allow

#### Scenario: bash 命令会话内允许在会话内免弹

- **WHEN** 用户对 tier=two bash 命令选择"会话内允许"，同会话内再次执行同一 `rawCommand`
- **THEN** auto_allow，audit 日志 `event: "allow_session"`（bash 命令类通过 audit 记录的 `command` 字段可识别）

### Requirement: 用户"总是允许"写入持久化记忆

选择"总是允许"后，本次放行且写入持久化 trusted.json；跨 session 生效；弹窗 UI MUST 显示持久化文件路径提示。

**修改**：新增对 bash 命令类授权的"总是允许"处理——写入持久化 Bash 命令 memory（`addBashPersistentGrant`），并存入 trusted.json 的 `bashGrants` 段。

#### Scenario: 总是允许跨会话生效

- **WHEN** 用户对配置声明的项目外路径选择"总是允许"，重启 pi 后访问
- **THEN** auto_allow（持久化记忆命中）

#### Scenario: bash 命令总是允许本命令跨会话生效

- **WHEN** 用户对 tier=two bash 命令选择"总是允许本命令"，重启 pi 后再次执行同一 `rawCommand`
- **THEN** auto_allow（持久化 bash 记忆命中），audit 日志 `event: "allow_persistent"`

### Requirement: 用户拒绝立即阻断

无论弹窗档位，选择"拒绝"或按 Esc 均 MUST 立即返回 `{ block: true }`，不进入任何记忆通道，记入审计日志 `event=deny`。

#### Scenario: 拒绝后审计记录

- **WHEN** 用户在弹窗中选择"拒绝"
- **THEN** 审计日志新增一条 `event=deny` 记录，包含项目标识、路径、权限级别

#### Scenario: bash 命令拒绝后审计记录

- **WHEN** 用户在 tier=two bash 命令弹窗中选择"拒绝"
- **THEN** 审计日志新增一条 `event=deny` 记录，`path` 为空，`command` 为 rawCommand，`declaration: "unconfigured"`
