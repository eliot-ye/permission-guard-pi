## Why

`openspec/todo.md` P3 待办池记录（用户要求）：「添加启用、关闭设置」。用户确认设计（a1 + 斜杠命令 + UI 状态标记），并要求所有 UI 文本走 i18n（en/zh）。

现状：`settings.json` 已有 `lang` 字段（ui-i18n T5 先例），但**没有整体启用/关闭**。用户无法临时绕过 permission gate（如调试、跑不受限脚本）而不编辑配置或卸载扩展。

本 change 添加整体启用/关闭：
- **settings.json** 加 `enabled?: boolean`（默认 true = fail-safe，缺省 = 现状行为，向后兼容）
- **斜杠命令 `/permission`** 显示/切换状态（`pi.registerCommand`）
- **UI footer 状态标记**（`ctx.ui.setStatus`）——所有文本走 i18n

## What Changes

### 主体变更

- **settings.ts**：`Settings` 接口加 `enabled?: boolean`（缺省视为 `true`）
- **extensions/index.ts**：
  - `tool_call` 入口：`settings.enabled === false` → `return undefined`（gate no-op，pi 原生处理）
  - `pi.registerCommand("permission", { handler })`：`/permission` 显示状态；`/permission on|off` 切换并**持久化**到 settings.json
  - `ctx.ui.setStatus("permission-guard", ...)`：session_start + 命令切换后更新 footer 状态标记（🔒 已启用 / 🔓 已关闭）
- **i18n**：`reason-codes.ts` `UiCode` 加开关相关 code；`i18n.ts` en/zh bundle 补文案；`TOTAL_CODE_COUNT` 更新

### 测试（TDD，RED→GREEN）

- settings.ts：`enabled: false` 解析；缺省视为 true
- gate 入口：disabled → no-op（return undefined）
- 斜杠命令：切换 + 持久化
- i18n：新 code 双语 + code count 更新

### spec delta

- 新 capability `permission-toggle`：settings.json `enabled` 契约 + `/permission` 命令 + UI 状态标记语义

## Capabilities

### New Capabilities

- `permission-toggle`：整体启用/关闭契约（settings.json `enabled` + `/permission` 命令 + UI footer 状态）

### Modified Capabilities

（无）

## Impact

- **settings.ts**：`Settings` 接口加字段（向后兼容，旧 settings.json 无 `enabled` → 默认 true）
- **extensions/index.ts**：`tool_call` 入口检查 + `registerCommand` + `setStatus`
- **i18n**：`UiCode` 加 code + 双语 bundle + 计数
- **测试**：settings/gate/command/i18n 补断言
- **运行时数据**：`settings.json` 写 `enabled`（持久）；trusted.json 不受影响

### Caller impact 分析

- **变更点清单**：
  - ① `Settings` 接口加 `enabled?: boolean`——属 ⑤ 类（类型扩展，向后兼容，旧 settings.json 无此字段 → 默认 true）
  - ② `tool_call` 入口加 `enabled === false` 检查——属 ④ 类（内部实现，新增 no-op 分支）
  - ③ `pi.registerCommand("permission")` 新增——属 ④ 类（内部实现，新命令）
  - ④ `ctx.ui.setStatus` 新增——属 ④ 类（内部实现，UI 状态标记）

- **高危标记**：无高危变更点——全部为加宽/新增，无公共契约收窄；`Settings` 加可选字段不破坏既有消费者（`detectLang` 只读 `lang`）

- **已知 caller**：
  - `loadSettings`：仅 `extensions/index.ts` initSession 调用—— 加字段兼容
  - `Settings.enabled`：新增字段，无既有 caller
  - `tool_call` handler：gate 入口—— 加 no-op 分支，兼容

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：
  - `extension-orchestration`（tier-small）：`extensions/index.ts`（tool_call 入口 + registerCommand + setStatus）
  - `policy-core`（tier-medium）：`settings.ts`（Settings 加 enabled 字段）
  - `permission-toggle`（新 capability）：settings.json enabled 契约 + /permission 命令 + UI 状态
  - i18n：UiCode 加 code + 双语 bundle

- **整体性能预期变化**：**零性能影响**——disabled 时 gate 提前返回（更快）；enabled 时与现状一致（一次布尔检查）

- **这是局部优化还是全局协调**：**局部优化**（extension-orchestration 加开关能力），不涉及跨分系统契约协调

- **如果是局部优化，对全局失调的风险**：**低风险**——disabled 时 gate 完全 no-op 且**无审计**，这是唯一的语义收紧（用户显式关闭即知情）；默认 enabled 保证向后兼容。risk 可控。

- **预期行为模型**（可验证契约）：
  1. **enabled 缺省 true**：settings.json 无 `enabled` → gate 生效（fail-safe）——settings.test.ts 断言
  2. **enabled false → no-op**：`tool_call` 返回 `undefined`（pi 原生处理，不拦截）——gate 测试断言
  3. **/permission off → 持久化 + footer 更新**：settings.json 写 `enabled: false`，`setStatus` 收到 🔓 文本——command 测试断言
  4. **i18n 双语**：新 UiCode 在 en/zh bundle 均有 CJK/英文文案——i18n.test.ts 断言

- **与既有架构/风格的遵循关系**：全部遵循既有约定——`src/lib/*.ts` 纯函数 + `extensions/index.ts` 集成层；settings.json 沿用 `lang` 先例（JSONC 读取、缺省降级）；i18n 走既有 `t(code, lang)` 机制；斜杠命令用 pi 标准 `registerCommand`。**无偏离点**。

## 实际系统工程影响 vs 预期

（td-archive 步骤 3 强制复盘。对照 proposal 的"系统工程影响评估"节。）

- **实际影响的分系统**：`extension-orchestration`（tool_call 入口 + registerCommand + setStatus）+ `policy-core`（settings.ts enabled 字段）+ `permission-toggle`（新 capability）+ i18n（UiCode 新增）——与预期一致
- **实际整体性能变化**：零性能影响——与预期一致（enabled 检查为一次布尔读；disabled 时 gate 提前返回更快）
- **实际是局部优化还是全局协调**：局部优化（extension-orchestration 加开关能力）——与预期一致
- **局部优化的实际全局影响**：disabled 时 gate 无审计（用户显式关闭即知情）；默认 enabled 向后兼容——与预期一致
- **模型验证**：
  1. **enabled 缺省 true** ✅ 已验证——`loadSettings` 测试（缺失 → undefined，消费方视为 true）
  2. **enabled false → no-op** ✅ 已验证——PT1（disabled → undefined）
  3. **/permission off → 持久化** ✅ 已验证——PT3（settings.json 写 enabled:false）+ PT4（enabled:true）
  4. **i18n 双语** ✅ 已验证——i18n.test（count 57 + 双语 CJK/英文）
  - **预期行为模型已验证**（4/4）

- **预期之外的副作用**：无。AL7（并发 audit 序列化）在全量跑时偶发 flaky——已确认是 HEAD 基线既有的已知竞态（`al4_af7_flaky_tests_existing`），非本 change 引入。
