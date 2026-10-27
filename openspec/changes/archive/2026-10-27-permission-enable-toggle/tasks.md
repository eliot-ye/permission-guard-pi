## 关键链

**关键链路径**：1（settings enabled）→ 2（i18n）→ 3（gate 入口）→ 4（斜杠命令）→ 5（UI 状态）→ 7（集成验证）。6（测试）贯穿 1-5。

- 关键链子任务：1.1-1.2 (2) + 2.1-2.3 (3) + 3.1-3.2 (2) + 4.1-4.2 (2) + 5.1-5.2 (2) + 7.1-7.2 (2) = **13**
- 非关键链子任务：6.1-6.3 (3，测试，并行于实现)
- Project buffer 槽位：**1**（tier-medium 参考 15%，本 change 低风险、加宽兼容，取 1 个触发式槽位）
- **总任务数**：13 + 3 + 1 = **17**
- **Buffer 比例**：1 / 13 ≈ **7.7%**（低于 tier-medium 15%，因全部为加宽/新增、低风险）

## 1. Settings enabled 字段

- [x] 1.1 `src/lib/settings.ts`：`Settings` 接口加 `enabled?: boolean`，注释说明缺省视为 true（fail-safe）
- [x] 1.2 `test/lang-detect.test.ts`（或新 settings.test.ts）：`enabled: false` 解析 + 缺省视为 true

## 2. i18n 新增 UI codes

- [x] 2.1 `src/lib/reason-codes.ts`：`UiCode` 加 `permission_status_enabled` / `permission_status_disabled` / `permission_cmd_usage` / `permission_cmd_toggled_on` / `permission_cmd_toggled_off` / `permission_cmd_write_failed`
- [x] 2.2 `src/lib/i18n.ts`：en/zh bundle 补上述 code 文案；`TOTAL_CODE_COUNT` 更新
- [x] 2.3 `test/i18n.test.ts`：`UI_CODES` 同步 + 断言新 code 双语齐全

## 3. gate 入口检查 enabled

- [x] 3.1 `extensions/index.ts`：`tool_call` 入口加 `settings.enabled === false → return undefined`（no-op）
- [x] 3.2 gate 测试：disabled → no-op（return undefined）

## 4. 斜杠命令 /permission

- [x] 4.1 `extensions/index.ts`：`pi.registerCommand("permission", { handler })`——/permission 显示状态；/permission on|off 切换并持久化
- [x] 4.2 命令测试：切换 + 持久化到 settings.json

## 5. UI footer 状态标记

- [x] 5.1 `extensions/index.ts`：`ctx.ui.setStatus("permission-guard", ...)` session_start 设置
- [x] 5.2 命令切换后更新 footer 状态

## 6. 测试（贯穿 1-5，TDD RED→GREEN）

- [x] 6.1 settings enabled 解析测试（RED→GREEN）
- [x] 6.2 gate disabled no-op 测试（RED→GREEN）
- [x] 6.3 i18n 新 code 双语测试（RED→GREEN）

## 7. 集成验证

- [x] 7.1 `npm run typecheck` → 仅剩 2 个 HEAD 既有 error，无新增
- [x] 7.2 `npm test` → 全部 GREEN
- [x] 7.3 `openspec validate --specs` → 通过
