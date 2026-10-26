# approval-flow Specification

## Purpose
定义审批弹窗的呈现与交互契约——根据配置状态与项目标识选择"三档"或"两档"弹窗，处理无 UI 模式与用户取消。

## Requirements

### Requirement: 两档 vs 三档弹窗

系统 SHALL 根据决策引擎返回的 `tier` 字段选择弹窗形态：

- **tier=three**：三档选项——"允许一次 / 允许为本会话 / 总是允许"，加"拒绝"。适用场景：
  - 配置声明路径（`read_write` 外区、`read_only` 写、跨源冲突含 unread）
  - 未配置项目内敏感路径（任何 level）
  - 未配置项目外 soft sensitive（任何 action）
  - 未配置项目外 non-sensitive 写
  - **bash 命令无法静态解析**（unreliable bash）——第 3 档将 rawCommand 写入 bash 命令持久化记忆（trusted.json 的 `bashGrants` 段）
- **tier=two**：两档选项——"允许一次 / 允许为本会话"，加"拒绝"。**不出现"总是允许"**。适用场景：
  - 未配置项目外 hard sensitive（外区读 / 写 / delete）
  - 网络外带写入（`/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+`）

**删除**：本 change 移除原 spec 中"tier=two bash 命令类（含 `bash_reason` 字段）"作为 tier=two 变体的定义。bash 命令类 prompt 现统一归 tier=three，与其他"可持久化"弹窗归为一类。副文本分派规则保留（见下条 requirement），仍按 `bash_reason` 精确分派，但触发前提从"tier=two + bash_reason"更新为"tier=three + bash_reason"。

#### Scenario: 配置声明路径弹三档

- **WHEN** 决策为 prompt tier=three（配置为 read_write 的项目外路径首次访问）
- **THEN** 弹窗显示 4 个选项：允许一次 / 允许为本会话 / 总是允许 / 拒绝

#### Scenario: 未配置路径弹两档

- **WHEN** 决策为 prompt tier=two（未配置路径，例如项目外 hard sensitive，如 `~/.ssh/id_rsa`）
- **THEN** 弹窗显示 3 个选项：允许一次 / 允许为本会话 / 拒绝

#### Scenario: bash 命令类 prompt 弹三档

- **WHEN** 决策为 prompt tier=three 且包含 `bash_reason` 字段（例如 `ls /tmp/*.log` 触发 glob_expansion）
- **THEN** 弹窗显示 4 个选项：允许一次 / 允许为本会话 / 总是允许本命令 / 拒绝；第 3 档将 rawCommand 持久化到 trusted.json 的 `bashGrants` 段

#### Scenario: 未配置项目外 hard sensitive 弹两档

- **WHEN** 决策为 prompt tier=two（未配置项目外 hard sensitive，如 `~/.ssh/id_rsa`）
- **THEN** 弹窗显示 3 个选项：允许一次 / 允许为本会话 / 拒绝

#### Scenario: 未配置项目外 soft sensitive 弹三档

- **WHEN** 决策为 prompt tier=three（未配置项目外 soft sensitive，如 `~/.ssh/known_hosts` 或 `~/.config/app/config.json`）
- **THEN** 弹窗显示 4 个选项：允许一次 / 允许为本会话 / 总是允许 / 拒绝

#### Scenario: bash 命令无法静态解析弹三档

- **WHEN** 决策为 prompt tier=three 且包含 `bash_reason` 字段（例如 `cat $SECRETS` 触发 `unresolved variable`、`bash -c "..."` 触发 `shell_forwarder`）
- **THEN** 弹窗显示 4 个选项：允许一次 / 允许为本会话 / 总是允许本命令 / 拒绝；第 3 档将 rawCommand 持久化到 trusted.json 的 `bashGrants` 段

### Requirement: 弹窗内容包含关键信息

弹窗文案 MUST 至少包含：

- 目标路径（或 bash 命令原文）
- 操作类型（读 / 写 / delete）
- 权限级别（若已配置）或"未配置"标记
- 若 tier=three：说明"总是允许将保存到 <trusted.json 绝对路径>"
- 若 tier=three bash 命令类（含 `bash_reason` 字段）：说明"总是允许本命令将保存到 <trusted.json 绝对路径>"

tier=two 的副文本 MUST 按决策来源分派，MUST NOT 使用统一文案：

- 外层 hard sensitive 路径（decision.declaration == "sensitive_default" 且 decision.tier == "two"）：提示"敏感系统路径不能持久化，如需长期允许请编辑 permission.json"
- 网络外带写入（decision 触发条件含 dev-socket 路径）：提示"网络外带路径不能持久化，每次写入都需确认"

tier=three bash 命令类 prompt（含 `bash_reason` 字段）的副文本 MUST 按 `bash_reason` 值动态生成（见下方细分 scenario），统一遵循：指出**为何无法通过静态解析**、**用户可如何避免重复弹窗**（选择"会话内允许"或"总是允许本命令"选项，或编写 permission.json glob）。

两条副文本 MUST 与 tier=three 的持久化提示互斥——非 bash 类 tier=two 不出现"总是允许将保存到 <trusted.json>"字样；bash 类 tier=three 的"总是允许本命令"选项的持久化说明只涉及 rawCommand，不涉及路径 glob。

#### Scenario: 三档弹窗显示保存位置

- **WHEN** 用户看到 tier=three 弹窗（配置声明路径）
- **THEN** 弹窗文案包含字符串 `~/.pi/agent/extensions/permission-guard-pi/trusted.json`

#### Scenario: 两档弹窗显示提示

- **WHEN** 用户看到 tier=two 弹窗（非 bash 类）
- **THEN** 弹窗副文本 MUST 按决策来源分派——不包含统一"未配置"字样；具体副文本见下方两个分派 scenario

#### Scenario: 外层敏感路径弹窗副文本

- **WHEN** 用户看到 tier=two 弹窗，决策来源为"项目外 hard sensitive 路径 + 未配置"
- **THEN** 弹窗文案包含"敏感系统路径不能持久化"字样；**不包含**"未配置路径"字样；**不包含**"总是允许将保存到"字样

#### Scenario: bash 命令无法静态解析弹窗副文本

- **WHEN** 用户看到 tier=three 弹窗，决策来源为"bash 命令不可靠"但缺少 `bash_reason` 字段（回归保护，理论上不应发生）
- **THEN** 弹窗文案回退到旧统一副文本"命令无法静态解析"字样；**不包含**"permission.json"字样；**不包含**"总是允许将保存到"字样（因为无 rawCommand 持久化通道）

#### Scenario: 外层 hard sensitive 路径弹窗副文本

- **WHEN** 用户看到 tier=two 弹窗，decision.declaration == "sensitive_default" 且 decision.tier == "two"
- **THEN** 弹窗文案包含"敏感系统路径不能持久化"字样

#### Scenario: bash 命令无法静态解析弹窗副文本（tier=three）

- **WHEN** 用户看到 tier=three 弹窗，bash 命令包含 bash_reason
- **THEN** 副文本按 bash_reason 分派（见下方细分 scenario），不再使用统一副文本

#### Scenario: bash 命令 glob 类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "glob_expansion"`（例如 `ls /tmp/*.log`）
- **THEN** 弹窗副文本包含："该命令含未加引号的 glob 通配符，无法静态枚举目标文件。如需避免重复弹窗，请在 permission.json 中声明该路径 glob，或选择「会话内允许」"

#### Scenario: bash 命令控制流类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "control_flow"`（例如 `while read x; do cat $x; done`）
- **THEN** 弹窗副文本包含："该命令包含控制流关键字（while/for/if 等），实际访问文件取决于运行时变量，无法静态确定。建议使用 grep/find 等工具替代 shell 循环；选择「会话内允许」可避免重复弹窗"

#### Scenario: bash 命令 shell 转发器类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "shell_forwarder"`（例如 `bash -c "rm -rf /"`）
- **THEN** 弹窗副文本包含："该命令通过 shell 转发器执行，字符串内的文件系统访问不可见于静态分析。建议直接执行命令而非嵌套 shell；选择「会话内允许」可避免重复弹窗"

#### Scenario: bash 命令转发器类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "forwarding_command"`（例如 `find /etc | xargs rm`）
- **THEN** 弹窗副文本包含："该命令使用转发器（xargs/parallel 等），下游参数来自上游 stdout，无法静态枚举。建议避免在管道后使用转发器；选择「会话内允许」可避免重复弹窗"

#### Scenario: bash 命令不可靠旧统一副文本已废弃

- **WHEN** 用户看到 tier=three 弹窗，决策来源为"bash 命令不可靠"（包含 `bash_reason` 字段）
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

**修改**：本 change 后，bash 命令类的"会话内允许"从"tier=two 场景"更新为"tier=three 场景"（bash unreliable 分支的 tier 从"two"改为"three"）。会话级记忆键 `(projectHash, sha256(rawCommand))` 不变。

#### Scenario: 会话内允许在会话内免弹

- **WHEN** 用户对未配置项目外敏感文件选择"会话内允许"，同会话内再次访问同一文件
- **THEN** auto_allow

#### Scenario: bash 命令会话内允许在会话内免弹

- **WHEN** 用户对 tier=three bash 命令（unreliable bash）选择"会话内允许"，同会话内再次执行同一 `rawCommand`
- **THEN** auto_allow，audit 日志 `event: "allow_session"`（bash 命令类通过 audit 记录的 `command` 字段可识别）

### Requirement: 用户"总是允许"写入持久化记忆

选择"总是允许"后，本次放行且写入持久化 trusted.json；跨 session 生效；弹窗 UI MUST 显示持久化文件路径提示。

**修改**：bash 命令类的"总是允许"从原"tier=two bash 命令类特殊分支"更新为"tier=three 通用分支"（bash 命令类与 path-based 弹窗同 tier=three，都通过 tier=three 弹窗提供持久化选项）。

#### Scenario: 总是允许跨会话生效

- **WHEN** 用户对配置声明的项目外路径选择"总是允许"，重启 pi 后访问
- **THEN** auto_allow（持久化记忆命中）

#### Scenario: bash 命令总是允许本命令跨会话生效

- **WHEN** 用户对 tier=three bash 命令（unreliable bash）选择"总是允许本命令"，重启 pi 后再次执行同一 `rawCommand`
- **THEN** auto_allow（持久化 bash 记忆命中），audit 日志 `event: "allow_persistent"`

### Requirement: 用户拒绝立即阻断

无论弹窗档位，选择"拒绝"或按 Esc 均 MUST 立即返回 `{ block: true }`，不进入任何记忆通道，记入审计日志 `event=deny`。

#### Scenario: 拒绝后审计记录

- **WHEN** 用户在弹窗中选择"拒绝"
- **THEN** 审计日志新增一条 `event=deny` 记录，包含项目标识、路径、权限级别

#### Scenario: bash 命令拒绝后审计记录

- **WHEN** 用户在 tier=three bash 命令弹窗中选择"拒绝"
- **THEN** 审计日志新增一条 `event=deny` 记录，`path` 为空，`command` 为 rawCommand，`declaration: "unconfigured"`

### Requirement: cd cwd 变更命令弹窗副文本

当 bash 命令被判定为不可靠（`extractBashTargets` 返回 `reliable: false`）且 `bash_reason == "cd_chdir"` 时，弹窗副文本 MUST 与既有 `glob_expansion` / `control_flow` / `shell_forwarder` / `forwarding_command` 副文本并列分派，说明"命令包含 `cd` 会改变后续命令的工作目录基准，相对路径无法静态确定"。

**理由**：`cd` 改变 cwd 基准，后续命令中所有相对路径（如 `.`、`a.txt`）的实际落点由运行时 cwd 决定，静态分析无法预测。用户看到此类弹窗时，副文本必须明确指出"这是 cd 引起的、建议用绝对路径或选择会话内允许"。

**位置**：本 requirement 与既有"bash 命令无法静态解析弹窗副文本"系列的 `glob_expansion` / `control_flow` / `shell_forwarder` / `forwarding_command` 副文本 scenario 并列，不改变既有副文本。

**tier 前提更新**：bash 命令无法静态解析的弹窗档位从 tier=two 更新为 tier=three（本 change 全局修改），副文本分派规则本身不变。

#### Scenario: bash 命令 cd cwd 变更类 prompt 副文本

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason == "cd_chdir"`（例如 `cd /etc && rm -rf .`）
- **THEN** 弹窗副文本包含："该命令包含 cd 命令，改变后续命令的工作目录基准，相对路径无法静态确定实际访问的文件路径。建议使用绝对路径或选择「会话内允许」避免重复弹窗"

#### Scenario: cd cwd 变更类 prompt 与其他 bash 副文本互斥

- **WHEN** 用户看到 tier=three 弹窗，`bash_reason` 为 `cd_chdir` / `glob_expansion` / `control_flow` / `shell_forwarder` / `forwarding_command` 之一
- **THEN** 弹窗副文本按 `bash_reason` 精确分派，不使用统一文案，不与既有其他副文本重叠
