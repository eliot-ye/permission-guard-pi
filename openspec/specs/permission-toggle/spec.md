# permission-toggle Specification

## Purpose
TBD - created by archiving change permission-enable-toggle. Update Purpose after archive.

## Requirements

### Requirement: settings.json enabled 字段

系统 SHALL 在 `settings.json` 中支持可选 `enabled` 字段（`true` / `false`），控制整个 permission gate 是否生效。

- `enabled: true`（或字段缺省）→ gate 生效（默认行为，fail-safe）
- `enabled: false` → gate 关闭，`tool_call` 对 `read/write/edit/bash` 返回 `undefined`（pi 原生处理，不拦截、不审计）
- 缺省视为 `true`（旧 settings.json 无此字段 → 向后兼容，行为不变）

#### Scenario: enabled 缺省时 gate 生效

- **WHEN** settings.json 不含 `enabled` 字段
- **THEN** gate 对受支持工具生效（与未引入本字段前行为一致）

#### Scenario: enabled false 时 gate 关闭

- **WHEN** settings.json 声明 `enabled: false`
- **THEN** `tool_call` 对 `read/write/edit/bash` 返回 `undefined`（no-op），不弹窗、不拦截、不写审计

#### Scenario: enabled true 时 gate 生效

- **WHEN** settings.json 声明 `enabled: true`
- **THEN** gate 正常拦截/放行（与缺省一致）

### Requirement: /permission 斜杠命令

系统 SHALL 注册 `/permission` 斜杠命令（`pi.registerCommand`），用于查看与切换启用状态。

- `/permission` → 显示当前状态（enabled/disabled）+ 用法
- `/permission on` → 启用并**持久化** `enabled: true` 到 settings.json，更新 UI 状态
- `/permission off` → 关闭并**持久化** `enabled: false` 到 settings.json，更新 UI 状态

#### Scenario: /permission 显示当前状态

- **WHEN** 用户运行 `/permission`（无参数）
- **THEN** 输出当前状态（enabled 或 disabled），含用法提示

#### Scenario: /permission on 持久化启用

- **WHEN** 用户运行 `/permission on`
- **THEN** settings.json 写 `enabled: true`，UI 状态更新为已启用

#### Scenario: /permission off 持久化关闭

- **WHEN** 用户运行 `/permission off`
- **THEN** settings.json 写 `enabled: false`，UI 状态更新为已关闭

### Requirement: UI footer 状态标记

系统 SHALL 通过 `ctx.ui.setStatus(key, text)` 在 footer/状态栏显示当前启用状态，文本经 i18n 本地化（en/zh）。

- enabled → `permission_status_enabled` 文案（🔒 权限已启用）
- disabled → `permission_status_disabled` 文案（🔓 权限已关闭）

#### Scenario: session_start 时设置状态标记

- **WHEN** session 启动且 gate enabled
- **THEN** footer 显示 `permission_status_enabled` 本地化文本

#### Scenario: /permission off 后更新状态标记

- **WHEN** 用户运行 `/permission off`
- **THEN** footer 更新为 `permission_status_disabled` 本地化文本

### Requirement: UI 文本 i18n 本地化

所有本功能涉及的 UI 文本（命令输出、状态标记、通知）SHALL 通过 `t(code, lang)` 机制本地化，en/zh 双语齐全。

#### Scenario: 新 UiCode 双语齐全

- **WHEN** 查询任意本功能新增的 UiCode
- **THEN** en bundle 为英文、zh bundle 含 CJK 字符，均在 `t()` 可查表
