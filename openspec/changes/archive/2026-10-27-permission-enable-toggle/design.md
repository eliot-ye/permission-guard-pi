## Context

P3 待办：添加启用、关闭设置。用户确认设计（a1 + 斜杠命令 + UI 状态标记），并要求 UI 文本走 i18n。

现有事实：
- `settings.json` 由 `loadSettings(agentExtDir)` 读取（`src/lib/settings.ts`），已有 `lang` 字段先例（ui-i18n T5）
- `tool_call` handler（`extensions/index.ts:497`）是 gate 入口，`return undefined` = 让 pi 原生处理
- `pi.registerCommand(name, { description, handler })` 注册斜杠命令（types.d.ts:1207）
- `ctx.ui.setStatus(key, text)` 设置 footer 状态（types.d.ts:84）
- i18n 用 `t(code, lang)`，`UiCode` 在 reason-codes.ts，bundle 在 i18n.ts，`TOTAL_CODE_COUNT` 需同步

## Goals / Non-Goals

**Goals:**
- settings.json 加 `enabled?: boolean`（缺省 true = fail-safe）
- `/permission` 斜杠命令（显示 + 切换 + 持久化）
- UI footer 状态标记（`setStatus`）
- 所有 UI 文本走 i18n（en/zh）

**Non-Goals:**
- 不改 gate 内部决策逻辑（只加开关入口）
- 不做三态 / 环境变量通道（a2/a3 已排除）
- 不新增分系统，只扩展 extension-orchestration

## Decisions

- **enabled 缺省 true**：fail-safe，旧 settings.json 向后兼容（行为不变）
- **disabled = tool_call no-op**：`return undefined`，pi 原生处理；无审计（用户显式关闭即知情）
- **/permission 持久化**：写入 settings.json（与 lang 同通道），重启后仍生效
- **UI 状态标记**：`setStatus("permission-guard", ...)`，session_start + 命令切换后更新
- **i18n**：新增 UiCode（`permission_status_enabled` / `permission_status_disabled` / `permission_cmd_*`），en/zh 双语

## Risks / Trade-offs

- **disabled 无审计**：唯一语义收紧——用户显式关闭即知情；文档+spec 明确边界
- **settings.json 写失败**：命令切换报错提示（`notify`），不静默
- **多 session 并发**：切换只影响当前进程的 settings 读；跨进程需重启（与 lang 一致）
