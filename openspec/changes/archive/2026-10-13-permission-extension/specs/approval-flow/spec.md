## Purpose

定义审批弹窗的呈现与交互契约——根据配置状态与项目标识选择"三档"或"两档"弹窗，处理无 UI 模式与用户取消。

## ADDED Requirements

### Requirement: 两档 vs 三档弹窗

系统 SHALL 根据决策引擎返回的 `tier` 字段选择弹窗形态：

- **tier=three**（配置声明路径、或跨源冲突）：三档选项——"允许一次 / 会话内允许 / 总是允许"，加"拒绝"
- **tier=two**（未配置路径、敏感兜底、无法解析的 bash 命令）：两档选项——"允许一次 / 会话内允许"，加"拒绝"。**不出现"总是允许"**

#### Scenario: 配置声明路径弹三档

- **WHEN** 决策为 prompt tier=three（配置为 read_write 的项目外路径首次访问）
- **THEN** 弹窗显示 4 个选项：允许一次 / 会话内允许 / 总是允许 / 拒绝

#### Scenario: 未配置路径弹两档

- **WHEN** 决策为 prompt tier=two（未配置项目外敏感文件）
- **THEN** 弹窗显示 3 个选项：允许一次 / 会话内允许 / 拒绝

### Requirement: 弹窗内容包含关键信息

弹窗文案 MUST 至少包含：

- 目标路径（或 bash 命令原文）
- 操作类型（读 / 写 / delete）
- 权限级别（若已配置）或"未配置"标记
- 若 tier=three：说明"总是允许将保存到 <trusted.json 绝对路径>"
- 若 tier=two：说明"该路径未配置，无法持久授权；如需持久授权请在 permission.json 中声明"

#### Scenario: 三档弹窗显示保存位置

- **WHEN** 用户看到 tier=three 弹窗
- **THEN** 弹窗文案包含字符串 `~/.pi/agent/extensions/@permission-system:pi-extension/trusted.json`

#### Scenario: 两档弹窗显示提示

- **WHEN** 用户看到 tier=two 弹窗
- **THEN** 弹窗文案提示"未配置路径，无'总是允许'"

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

用户选择"允许一次"时，系统 MUST 仅放行本次工具调用，且 MUST NOT 写入任何记忆通道（下一次同一路径仍需弹窗）。

#### Scenario: 允许一次后再次访问重新弹

- **WHEN** 用户对配置为 read_write 的项目外路径选择"允许一次"
- **THEN** 本次调用放行；下一次同路径访问重新弹三档弹窗

### Requirement: 用户"会话内允许"写入会话级记忆

用户选择"会话内允许"时，系统 MUST 放行本次调用并写入会话级记忆；同一 session 内同（projectHash, action, absPath）后续访问 MUST 自动放行；重启 pi 后 MUST 清空会话级记忆。

#### Scenario: 会话内允许在会话内免弹

- **WHEN** 用户对未配置项目外敏感文件选择"会话内允许"，同会话内再次访问同一文件
- **THEN** auto_allow

### Requirement: 用户"总是允许"写入持久化记忆

选择"总是允许"后，本次放行且写入持久化 trusted.json；跨 session 生效；弹窗 UI MUST 显示持久化文件路径提示。

#### Scenario: 总是允许跨会话生效

- **WHEN** 用户对配置声明的项目外路径选择"总是允许"，重启 pi 后访问
- **THEN** auto_allow（持久化记忆命中）

### Requirement: 用户拒绝立即阻断

无论弹窗档位，选择"拒绝"或按 Esc 均 MUST 立即返回 `{ block: true }`，不进入任何记忆通道，记入审计日志 `event=deny`。

#### Scenario: 拒绝后审计记录

- **WHEN** 用户在弹窗中选择"拒绝"
- **THEN** 审计日志新增一条 `event=deny` 记录，包含项目标识、路径、权限级别
