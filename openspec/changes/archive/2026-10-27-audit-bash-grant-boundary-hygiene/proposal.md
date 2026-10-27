## Why

`openspec/todo.md` P3 待办池记录（2026-10-26 td-explore review 落池）的「平台与解析器边界卫生」「audit / audit.log 与 bash grant 的边界卫生」「package.json files 白名单」三项，来自 td-explore（2026-10-26 review）B2-B6 的现场判读。P1（bash raw-command grant 独立设计）经用户拍板暂缓，本 change 先做 P3 机械修复。

本 change 修复 5 处边界卫生问题（B2/B3/B4/B5/B6），全部为**加宽兼容 / 向后兼容**的契约修复，不改变既有安全决策语义：

- **B2** `addBashPersistentGrant` 的 input type 让调用方传 `commandHash: ""` 假值，靠 store 内部覆盖——改为 `Omit<BashGrant, "commandHash" | "createdAt">`，把"哈希由 store 派生"写进类型系统
- **B5** audit log 长命令截断到 511 字符后没有 `commandHash` 兜底——截断时补写 `commandHash: sha256(原始命令)` 到 audit record，让事后审计能精确匹配 trusted.json 里的 grant（bash 键按 `sha256(rawCommand)` 键控）
- **B3** `stripJsonComments` 把单引号当字符串起点——去掉单引号处理（JSONC 严格只支持双引号字符串），并在 `permission-config` spec 加"不支持单引号字符串"约束
- **B4** `isDefaultTmpPath` 只识别 `/tmp` + `/private/tmp`，漏 `/var/tmp`——补一行前缀匹配
- **B6** `package.json` `files` 白名单补 `docs/` + `examples/`，npm 安装后用户能看到 permission model 与配置示例

## What Changes

### 主体变更

- **B2**（`src/lib/trust.ts`）：`BashGrantInput = Omit<BashGrant, "createdAt">` → `Omit<BashGrant, "commandHash" | "createdAt">`；6 处调用方（`extensions/index.ts` + `test/trust.test.ts` ×5）删除 `commandHash` 传参
- **B5**（`src/lib/audit.ts`）：`AuditRecord` 加可选 `commandHash?: string`（向后兼容）；`truncateCommand` 截断时补写 `commandHash: sha256(原始命令)`（未截断不写）
- **B3**（`src/lib/config.ts` + `src/lib/settings.ts`）：`stripJsonComments` 的 `if (ch === '"' || ch === "'")` → 只保留 `"`；注释说明 JSONC 双引号边界
- **B4**（`src/lib/decision.ts`）：`isDefaultTmpPath` 补 `/var/tmp` + `/var/tmp/` 前缀
- **B6**（`package.json`）：`files` 数组补 `"docs/"` + `"examples/"`

### 测试（TDD 新增，RED→GREEN）

- **AL9**（`test/audit.test.ts`）：长 bash 命令截断后 `commandHash` 为原始命令的 64 位 sha256 + 截断标记 + note
- **PC4b**（`test/config.test.ts`）：注释内单引号不吞文件（解析正确）
- **PC4c**（`test/config.test.ts`）：结构性单引号 → 报错而非静默返回 `{}`（`loadConfigFile` 返回 `error`）
- **decision**（`test/decision.test.ts`）：`/var/tmp` + `/var/tmp/x` 写/删 auto-allow

### spec delta（契约层）

- **`openspec/specs/permission-config/spec.md`**：JSONC 语法 requirement 加"单引号不是字符串分隔符（B3 边界条款）"scenario
- **`openspec/specs/grant-memory/spec.md`**：审计日志字段扩展加 B5 `commandHash`（截断时写入）条款

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `permission-config`：JSONC 语法 requirement 加单引号边界 scenario
- `grant-memory`：审计日志字段扩展加 `commandHash`（B5）

## Impact

- **B2**：`src/lib/trust.ts` 类型加宽（调用方少传 `commandHash`，运行时行为不变——store 已派生哈希，GM17 断言不变）；`extensions/index.ts` + `test/trust.test.ts` 6 处调用方适配
- **B5**：`src/lib/audit.ts` `AuditRecord` 加可选字段（旧记录无此字段仍解析）；`test/audit.test.ts` 新增 AL9
- **B3**：`src/lib/config.ts` + `src/lib/settings.ts` 解析器（单引号不再当字符串起点，结构性单引号由 `JSON.parse` 报错）；`permission-config` spec 加边界条款
- **B4**：`src/lib/decision.ts` `isDefaultTmpPath`；`test/decision.test.ts` 补断言
- **B6**：`package.json` 仅 files 白名单；npm 包体积略增

### Caller impact 分析

- **变更点清单**：
  - ① `BashGrantInput` 类型收窄（`Omit<BashGrant, "createdAt">` → `Omit<BashGrant, "commandHash" | "createdAt">`）——属 ② 类（公共类型收窄，加宽兼容：删除的是调用方传的假值参数，运行时行为不变）
  - ② `AuditRecord` 加可选 `commandHash?: string`——属 ⑤ 类（文档/类型扩展，向后兼容）
  - ③ `stripJsonComments` 单引号处理删除——属 ④ 类（内部实现，修复解析器边界）
  - ④ `isDefaultTmpPath` 补 `/var/tmp`——属 ④ 类（内部实现，加宽默认路径集）
  - ⑤ `package.json` `files` 补 `docs/` + `examples/`——属 ④ 类（内部实现，发布清单）

- **高危标记**：① 属"公共类型收窄"——**但收窄的是类型约束（禁止调用方传假 `commandHash`），非运行行为**；6 处调用方全部在本仓库内（`extensions/index.ts` + `test/trust.test.ts`），适配后 `npm run typecheck` 0 error。**不触发 human-in-loop 必停**，因为：
  - 无外部消费者（npm 包内 `addBashPersistentGrant` 仅 1 处生产 caller）
  - 删除的是调用方传入的 `commandHash: ""` 假值，store 内部已派生正确哈希（GM17 断言不变）

- **已知 caller**：
  - `addBashPersistentGrant`：1 生产 caller（`extensions/index.ts:1078`）+ 5 测试 caller（`test/trust.test.ts:266,292,316,323,508`）—— 全部适配（删 `commandHash` 传参），兼容
  - `truncateCommand`（audit 内部）：仅 `createAuditLogger` 内调用—— 加 `commandHash` 字段，向后兼容
  - `isDefaultTmpPath`：仅 `decide()` 内调用—— 加 `/var/tmp` 前缀，兼容

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：
  - `policy-core`（tier-medium）：`trust.ts`（B2 类型）、`config.ts`（B3 解析器）、`decision.ts`（B4 tmp 路径）、`audit.ts`（B5 记录字段）
  - `permission-config` spec：B3 单引号边界条款
  - `grant-memory` spec：B5 `commandHash` 字段
  - `package.json`：B6 发布清单（无 spec 影响）

- **整体性能预期变化**：**零性能影响**——B2/B5 为类型/字段扩展（无运行时开销，sha256 仅在命令 >511 字符时计算一次）；B3/B4 为解析器/路径判定逻辑微调（常数级）；B6 仅 npm 包体积略增（docs/ + examples/）。

- **这是局部优化还是全局协调**：**局部优化**（5 处独立边界卫生修复），不涉及跨分系统契约协调——每处都在单一文件内修复，无分系统间行为耦合。

- **如果是局部优化，对全局失调的风险**：**低风险**——B3 是唯一的语义收紧（结构性单引号从"静默返回 {}"改为"报错"），但该行为本就是 JSONC 无效输入，报错是正确契约；其余 4 处为加宽/向后兼容，不改变任何既有合法输入的决策结果。

- **预期行为模型**（可验证契约）：
  1. **B2**：`addBashPersistentGrant` 调用方不传 `commandHash`，store 仍派生正确哈希——`test/trust.test.ts` GM17（`commandHash` 为 64 位 hex）+ `npm run typecheck` 0 error。
  2. **B5**：长命令（>511 字符）截断后 audit 记录含 `commandHash = sha256(原始命令)`——`test/audit.test.ts` AL9。
  3. **B3**：注释内单引号正常解析（PC4b）；结构性单引号 → `loadConfigFile` 返回 `error`（PC4c）。
  4. **B4**：`/var/tmp` + `/var/tmp/x` 写/删 auto-allow——`test/decision.test.ts` default_tmp_paths 断言。
  5. **B6**：`package.json` `files` 含 `docs/` + `examples/`——`npm pack --dry-run` 校验。

- **与既有架构/风格的遵循关系**：全部遵循既有约定——`src/lib/*.ts` 纯函数（无 UI/IO 依赖，除 audit 的 fs）；JSONC 解析器保持"只支持双引号"的 JSON 标准；`isDefaultTmpPath` 沿用既有前缀匹配模式；无新分系统切分、无引入新模式。**无偏离点**。

## 实际系统工程影响 vs 预期

（td-archive 步骤 3 强制复盘。对照 proposal 的"系统工程影响评估"节。）

- **实际影响的分系统**：`policy-core`（trust.ts B2 / config.ts B3 / decision.ts B4 / audit.ts B5）+ `package.json`（B6）——与预期一致
- **实际整体性能变化**：零性能影响——与预期一致（B2/B5 类型/字段扩展无运行时开销；B3/B4 常数级；B6 包体积略增）
- **实际是局部优化还是全局协调**：局部优化（5 处独立边界卫生修复）——与预期一致
- **局部优化的实际全局影响**：B3 是唯一语义收紧（结构性单引号从"静默返回 {}"改为"报错"），属正确契约；其余 4 处加宽/向后兼容，不改变既有合法输入的决策结果——与预期一致
- **模型验证**：
  1. **B2** ✅ 已验证——`npm run typecheck` 0 新增 error；GM17（commandHash 为 64 位 hex）保持 GREEN
  2. **B5** ✅ 已验证——`test/audit.test.ts` AL9：截断记录含 `commandHash = sha256(原始命令)`
  3. **B3** ✅ 已验证——PC4b（注释内单引号正常解析）+ PC4c（结构性单引号 → `error`）
  4. **B4** ✅ 已验证——default_tmp_paths 断言含 `/var/tmp` + `/var/tmp/x`
  5. **B6** ✅ 已验证——`package.json` `files` 含 `docs/` + `examples/`
  - **预期行为模型已验证**（5/5）

- **预期之外的副作用**：无。唯一 flaky 是 sys-integration 已知计时竞态（AF7/al4，先前 audit 已记录），非本 change 引入。
