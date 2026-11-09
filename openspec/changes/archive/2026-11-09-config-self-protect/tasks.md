# Tasks: config-self-protect

TDD（RED-GREEN-REFACTOR）。运行：`node --experimental-strip-types --test test/`；类型检查：`npm run typecheck`。

## 关键链与缓冲（critical-buffer，tier-medium → project buffer 35%）

- **关键链**（最长路径，考虑资源约束）：`1.3`（集成测试先行）→ `3.1` → `3.2` → `3.3` → `3.4`（装配）→ `4.1` → `4.2` → `4.3`（验证）。每条任务标 `**[关键链]**`。
- **feeding 链**（支流，汇入关键链 3.1 处）：`1.1` → `1.2` → `2.1`（纯谓词，为 3.1-3.4 提供 `isProtectedRuntimeState`/`isConfigWritePath`）。标 `**[feeding]**`。
- **project buffer**：关键链末端留 35%（tier-medium，表 1），吸收不确定性；**不压缩**。
- **feeding buffer**：支流汇入点（3.1 前）留 35%，同比例。

## Caller Impact 实测（步骤 4，实测产出）

| 变更点 | caller 实测 | 兼容结论 |
|---|---|---|
| `decideTarget` 新增 pre-check（:944-1027） | 调用点 `extensions/index.ts:860`（文件工具）、`:775`（可靠 bash per-target）；测试引用 `extensions/index.test.ts:1199,1741` | 签名未改，pre-check 加函数内部 → 兼容 |
| `loadAllConfigs` 返回加 `configPaths` | 唯一 caller `extensions/index.ts:142` destructure `{policy,warnings}` | 加字段 additive → 兼容 |
| `configLocations` | 仅 `extensions/index.ts:113`（loadAllConfigs 内）+ `:26` import；无外部 caller | 内部符号 → 兼容 |
| `Declaration` 加 `"config_write"` | 无 exhaustive switch（仅 `===` 等值检查 `:196`,`:1101`） | additive union 拓宽 → 兼容 |
| `isProtectedRuntimeState` / `isConfigWritePath`（新符号） | 无既有调用者 | 新符号 → 兼容 |
| `UiCode` 加 `subtitle_config_write_not_persistable` | i18n bundle 加键 | additive → 兼容 |

**结论**：无 proposal 未标注的 caller、无兼容冲突；变更点均为纯新增 / additive。**实测通过**。

## 1. RED — 测试先行

- [x] 1.1 **[feeding]** 写 `test/config-protect.test.ts`：断言 `isProtectedRuntimeState(absPath, trustedPath, settingsPath)`——命中 trusted.json / settings.json（规范化等值）→ true；普通路径 → false；`..` / `~` → true。运行 `node --experimental-strip-types --test test/config-protect.test.ts`，预期 **fail**（模块不存在）。✅ 实测：`ERR_MODULE_NOT_FOUND src/lib/config-protect.ts`（RED 确认）。⚠️ 注（review 复核）：纯谓词对**大小写变体**按设计为**精确匹配**（toKeyPath 仅折叠 Windows 盘符；大小写不敏感 FS 由 decideTarget 的 realpath canonicalPath 双输入处理既有文件 + scan 大小写折叠处理不可靠 bash），故纯谓词单测不含"大小写变体 → true"；该场景由集成层（SYS-CP11）覆盖。
  - 文件：`test/config-protect.test.ts`；风险：medium；分系统影响：policy-core；依赖：无；估时：3m。
- [x] 1.2 **[feeding]** 同一文件断言 `isConfigWritePath(action, absPath, paths)`——action=write/delete 且命中任一 permission.json 路径 → true；action=read → false；普通路径 write → false。运行同上，预期 **fail**。✅ 实测：同上（模块缺失，RED 确认）。
  - 文件：`test/config-protect.test.ts`；风险：medium；分系统影响：policy-core；依赖：无；估时：3m。
- [x] 1.3 **[关键链]** 在 `test/sys-integration.test.ts` 追加 config-protect 集成测试（复用 `withSandbox` / `createMockPi` / `fireToolCall`，真实 `registerPermissionGate`）：
  - 写 `join(trustedDir,"trusted.json")` → 结果 `block: true`（deny_hard，无 prompt）；
  - 写 `join(trustedDir,"settings.json")` → `block: true`；
  - 写 `join(projectRoot,".pi/permission.json")` → prompt tier=two（捕获 prompt，断言不含"总是允许"）；
  - 配置声明 `"<project permission.json>": "read_write"` 后仍写该文件 → 仍 prompt（不静默化）；
  - 读 `join(projectRoot,".pi/permission.json")` → 不 block（常规规则，auto_allow）。
  运行 `node --experimental-strip-types --test test/sys-integration.test.ts`，预期 **fail**（pre-check 未接线）。✅ 实测：SYS-CP1/2/3 **fail**（判别性：写受保护文件未拦截、配置写静默 auto_allow），SYS-CP4/5 **pass**（契约断言，pre-check 后仍成立）。
  - 文件：`test/sys-integration.test.ts`；风险：medium；分系统影响：extension-orchestration + policy-core；依赖：无；估时：5m。

## 2. GREEN — 纯函数实现

- [x] 2.1 **[feeding]** 实现 `src/lib/config-protect.ts`：`isProtectedRuntimeState`（规范化等值比较，用 `toAbsolutePath` + `toKeyPath`）+ `isConfigWritePath`（action ∈ {write,delete} 且规范化等值）。验证：1.1 / 1.2 测试 **pass**。✅ 实测：13/13 pass（GREEN）。
  - 文件：`src/lib/config-protect.ts`；风险：medium；分系统影响：policy-core；依赖：1.1、1.2；估时：8m。

## 3. GREEN — 集成装配

- [x] 3.1 **[关键链]** `extensions/index.ts`：`loadAllConfigs` 返回已解析 `{global, project, local}` 配置路径（与 `opts.configPaths` 同形状）；SessionState 加 `configPaths` 字段；`initSession` 存入。`decideTarget` 在 grant 检查（:993）**之前**加 L1 检查：对 `resolvedAbs` **与** `canonicalPath` 各调 `isProtectedRuntimeState(..., join(trust.path), join(opts.trustedDir,"settings.json"))`（OR），任一命中且 action≠read → 返回 `deny_hard`（reason 含"运行时状态"）。✅ 实测：SYS-CP1/2 **pass**（写 trusted.json / settings.json → deny_hard 无 prompt）；`npm run typecheck` 通过。注：settingsPath 以 `join(dirname(trust.path),"settings.json")` 派生（trustedDir=dirname(trust.path)），无需新增 state 字段。
  - 文件：`extensions/index.ts`；风险：high；分系统影响：extension-orchestration + policy-core；依赖：1.3、2.1；估时：15m。
- [x] 3.2 **[关键链]** `decideTarget` 在 grant 检查之后、`decide()`（:1017）**之前**加 L2 检查：对 `resolvedAbs` 与 `canonicalPath` 各调 `isConfigWritePath(action, ..., [configPaths.global, configPaths.project, configPaths.local])`（OR），命中 → 返回 `prompt tier=two, declaration:"config_write"`（`configured:false`，reason 含"权限配置"）。✅ 实测：SYS-CP3/4 **pass**（配置写 → prompt tier=two 无 always-allow；配置声明不静默化）；typecheck 通过。注：`declaration:"config_write"` 类型化需同步加宽 `Declaration` 联合（decision.ts）+ `AuditRecord.declaration`（audit.ts，audit-log 契约），已一并完成。
  - 文件：`extensions/index.ts`、`src/lib/decision.ts`、`src/lib/audit.ts`；风险：high；分系统影响：extension-orchestration + policy-core + side-effects(contract)；依赖：3.1；估时：10m。
- [x] 3.3 **[关键链]** 类型/码：`src/lib/decision.ts` `Declaration` 联合加 `"config_write"`；`src/lib/reason-codes.ts` `UiCode` 加 `subtitle_config_write_not_persistable`；`src/lib/i18n.ts` zh/en bundle 加对应字符串（zh："权限配置写操作不可持久化。如需长期允许，请直接编辑 permission.json。"；en："Permission config write cannot be persisted. To allow permanently, edit permission.json."）；`extensions/index.ts` tier=two 副文本分派（:1076-1081）加 `declaration === "config_write"` 分支。✅ 实测：SYS-CP3 断言 prompt 文本含 config_write 副文本 **pass**；i18n 测试 pass。注：Declaration/audit 契约已在 3.2 完成。
  - 文件：`src/lib/decision.ts`、`src/lib/reason-codes.ts`、`src/lib/i18n.ts`、`extensions/index.ts`、`src/lib/audit.ts`；风险：low；分系统影响：policy-core + extension-orchestration + side-effects(contract)；依赖：3.2；估时：5m。
- [x] 3.4 **[关键链]** bash 保护扫描：新增 `scanBashProtectedPaths(command, state)` 辅助（`tokenizeBashCommand` 裸路径 token 跑 L1/L2 谓词，返回 `deny_hard` | `config_write-prompt` | null）；在 `handleBash` 三个分支复用——可靠 bash（经 `decideTarget` per-target 天然覆盖）、不可靠+有 grant（C5 扫描分支 :640-665 旁追加）、不可靠+无 grant（:697 分支 tier=three prompt **之前**）。L1 命中→deny_hard（覆盖 grant）；L2 命中→prompt config_write（不因 grant 自动放行）。验证：1.3 集成测试 **pass**。✅ 实测：SYS-CP6/7/8/9 **pass**（可靠 L1；不可靠+无grant L2/L1；不可靠+grant L2 不因 grant 自动放行）。注：scan 剥离 token 尾随 `)`/`;`（subshell `(echo > path)` 的 tokenizer 产物），fail-closed 覆盖 subshell 写目标。
  - 文件：`extensions/index.ts`；风险：high；分系统影响：extension-orchestration；依赖：3.3；估时：12m。

## 4. REFACTOR / 验证

- [x] 4.1 **[关键链]** `npm run typecheck` → 通过（`tsc --noEmit`）。✅ 实测：通过（无 TS 错误）。
  - 文件：—；风险：low；分系统影响：全 change；依赖：3.4；估时：1m。
- [x] 4.2 **[关键链]** `npm test`（全量 `node --test "test/*.test.ts" "extensions/*.test.ts"`）→ 全绿（含既有测试无回归）。✅ 实测：993 测试 / 990 pass / 3 fail（AL7 flaky、SYS7、SYS-GRANT 均为**既存基线失败**，git stash 基线验证非本 change 引入；无新增回归；SYS-CP1-9 全绿）。⚠️ 注：基线本身非全绿（2 既存一致失败 + 1 flaky），本 change 满足"无回归"而非"全绿"。
  - 文件：—；风险：low；分系统影响：全 change；依赖：4.1；估时：3m。
- [x] 4.3 **[关键链]** `openspec validate --change config-self-protect` → 通过。✅ 实测：`openspec validate config-self-protect --type change` → "Change 'config-self-protect' is valid"。
  - 文件：—；风险：low；分系统影响：全 change；依赖：4.2；估时：1m。
