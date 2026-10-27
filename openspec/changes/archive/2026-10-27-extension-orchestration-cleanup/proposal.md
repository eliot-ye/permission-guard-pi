## Why

`openspec/todo.md` P2 待办池记录（2026-10-26 td-explore review 落池）：

> "清理 extension-orchestration 的死代码（`ctxRef` 未读变量 + `clearSessionGrants` / `clearBashGrants` 定义但从不被调）"

td-explore 阶段深挖后修正了 TODO 的扁平"死代码"标签——真实图景是三种不同性质的死代码：

1. **`ctxRef`**（`extensions/index.ts:471,479,487`）：3 行赋值，从未被读 → **纯死变量**，无任何生产/测试用途
2. **`clearBashGrants`**（`src/lib/trust.ts:106,116,255`）：interface 声明 + 实现，生产调用 0 + 测试调用 0 → **纯死代码**
3. **`clearSessionGrants`**（`src/lib/trust.ts:106,213`）：生产调用 0 + 测试调用 2（`test/trust.test.ts:38` GM2、`test/trust.test.ts:258` GM14）→ **测试 seam**

关键事实链（探索期查清，防止未来 audit 复发误标"死代码"）：

- `grant-memory/spec.md:107-111`「会话级记忆在 session_start 清空」契约**已满足**——机制是 `initSession` 整体重建 `TrustStore` 对象（新 `Set`），非通过 clear 调用满足
- spec scenario 已由 `test/sys-integration.test.ts:359` 的 **SYS6** 真测生产路径（两个独立 gate 实例模拟两次 session）
- 因此**不需要**新增集成测试迁移覆盖，也不需要让 `session_start` 显式调用 `clear*`（那只是给一个已空的 Set 再 clear 一次，no-op）

本 change 关闭该 TODO 项：**删除死代码**（`ctxRef` + `clearBashGrants`），**保留测试 seam**（`clearSessionGrants`）并加注释防复发。

## What Changes

### 主体变更

- **删除死变量** `ctxRef`：
  - `extensions/index.ts:471`：删除 `const ctxRef: { ctx?: PictxLike } = {};`
  - `extensions/index.ts:479`：删除 `ctxRef.ctx = ctx;`（`ensureState` 内）
  - `extensions/index.ts:487`：删除 `ctxRef.ctx = ctx;`（`session_start` handler 内）
- **删除死方法** `clearBashGrants`：
  - `src/lib/trust.ts:116`：从 `TrustStore` interface 删除 `clearBashGrants: () => void;`
  - `src/lib/trust.ts:255-258`：删除实现块
- **保留 + 注释** `clearSessionGrants`（测试 seam）：
  - `src/lib/trust.ts` 里 `clearSessionGrants` 方法上方添加注释：`// Test seam — production clears via initSession → new TrustStore (see SYS6 integration test). Kept for unit tests GM2 (path-based) and GM14 (bash-command-based).`

### 不变（明确边界）

- **spec 零修改**：`grant-memory/spec.md`、`access-decision/spec.md` 等所有 spec 文本**完全不动**
- **生产行为零变化**：`session_start` handler 逻辑不变（`initSession` 重建机制已满足 spec 契约）
- **测试逻辑零变化**：`test/trust.test.ts` GM2/GM14 保留不变（继续测 `clearSessionGrants`）；`test/sys-integration.test.ts` SYS6 保留不变
- **TrustStore 其他方法**：`hasSessionGrant` / `addSessionGrant` / `clearSessionGrants` / `hasPersistentGrant` / `addPersistentGrant` / `getAllPersistent` / `hasBashSessionGrant` / `addBashSessionGrant` / `hasBashPersistentGrant` / `addBashPersistentGrant` / `getAllPersistentBash` / `lookupGrantAuthor` / `lookupBashGrantAuthor` / `flush` 全部保留

### 明确不做（探索阶段排除的方向）

- **不改** `session_start` handler 显式调用 `clear*`（no-op：`initSession` 已重建 store，clear 一个空 Set 无效果）
- **不删** `clearSessionGrants`（GM2/GM14 依赖；删掉会降低测试价值——替换成"新建 store → 验证空"是无意义测试）
- **不加**新的 session_start → clear 集成测试（SYS6 已真测生产路径，加等价测试是冗余）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无）

本 change 是**纯删除 + 注释**——不修改任何 capability 的行为契约。`grant-memory/spec.md` 相关 requirement 与 scenario 文本、语义**完全不变**。

## Impact

- **代码**：
  - `extensions/index.ts`：删除 3 行（`ctxRef` 声明 + 2 处赋值）
  - `src/lib/trust.ts`：从 `TrustStore` interface 删除 1 行（`clearBashGrants` 声明），删除实现块（约 4 行）；`clearSessionGrants` 方法上方新增 1 行注释
- **测试**：既有 764 测试全部保持 GREEN（零测试改动）
- **规格**：无 spec 变更（`grant-memory/spec.md` 完全不动）
- **数据 / 运行时**：零运行时变化——纯静态删除，无行为契约影响
- **发布**：patch 版本；用户可见行为**完全不变**
- **依赖**：与 `bash-extract-split` 独立、可并行推进

### Caller impact 分析

- **变更点清单**：
  - ① `TrustStore` interface 删除 `clearBashGrants` 方法——属 ② 类（公共类型收窄）
  - ② `extensions/index.ts` 删除 `ctxRef` 变量声明与赋值——属 ④ 类（内部实现）
  - ③ `src/lib/trust.ts` 删除 `clearBashGrants` 实现——属 ④ 类（内部实现）
  - ④ `clearSessionGrants` 方法上方加注释——属 ⑤ 类（文档）

- **高危标记**：① 属"公共类型收窄"——**但收窄的是纯死方法**（生产 0 caller + 测试 0 caller，除 GM2/GM14 走 `clearSessionGrants`）。**不触发 `constraints/references/human-in-loop.md` 必停基线**，因为：
  - 无生产代码调用 `clearBashGrants`（`grep -rn "clearBashGrants" src extensions` 返回 0 命中）
  - 无测试代码调用 `clearBashGrants`（`grep -rn "clearBashGrants" test` 返回 0 命中）
  - 删除不会破坏任何现有消费者

- **已知 caller**：
  - `clearBashGrants`：0 caller（生产 0 + 测试 0）—— 删除安全
  - `clearSessionGrants`：0 生产 caller + 2 测试 caller（`test/trust.test.ts:38,258`）—— 保留 seam
  - `ctxRef`：0 reader（只有 3 行 writer 赋值）—— 删除安全

本 change 是**纯删除 + 注释**，**全部为零影响或注释型变更**，不含行为契约变化。

## 系统工程影响评估

- **影响哪些分系统**：
  - `extension-orchestration`（tier-small）：`extensions/index.ts` 删除 `ctxRef` 死变量
  - `policy-core`（tier-medium）：`src/lib/trust.ts` 从 `TrustStore` interface 删除 `clearBashGrants`（属 `policy-core` 内的 `trust` 通道）
  - `grant-memory` spec：无影响（spec 契约未变）

- **整体性能预期变化**：**零运行时变化**——纯静态删除；`extensions/index.ts` 减少 3 行不影响执行路径；`TrustStore` interface 少一个方法不影响模块加载或 `initSession` 的 store 构造成本。

- **这是局部优化还是全局协调**：**局部优化**（清理 extension-orchestration + trust.ts 内部实现），但**不涉及全局契约变更**——spec 不变、生产行为不变、测试不变。

- **如果是局部优化，对全局失调的风险**：**无风险**——本次清理是"删除死代码 + 注释防复发"，不引入任何新代码路径或契约变化。反而**降低**全局失调风险：`clearSessionGrants` 加注释后，未来 audit 不会再把测试 seam 误标为"死代码"。

- **预期行为模型**（3 个可验证契约）：

  1. **`ctxRef` 完全消失**——`grep -n "ctxRef" extensions/index.ts` 返回 0 命中。
  2. **`clearBashGrants` 完全消失**——`grep -rn "clearBashGrants" src extensions test openspec/specs` 返回 0 命中（生产 + 测试 + spec 全无引用）。
  3. **`clearSessionGrants` 保留 + 注释防复发**——`grep -n "Test seam" src/lib/trust.ts` 命中 1 处；`test/trust.test.ts` GM2/GM14 保持 GREEN（`clearSessionGrants` 仍被测试调用）。

- **与既有架构/风格的遵循关系**：本次改动遵循既有代码约定——
  - `ctxRef` 是"闭包内赋值但从不读"的模式，删除不改变其他函数签名或闭包结构
  - `TrustStore` interface 与实现同步删除（保持"interface 声明 ↔ 实现"配对约定）
  - 注释风格遵循 `src/lib/trust.ts` 内既有 JSDoc / 行注释风格

  **偏离既有架构**：**无**——本次是既有模式的清理（删死代码），不引入新架构风格。

- **不适用降级**：不适用（本 change 是零影响清理，3 个契约均可通过 grep 与 test 直接验证）。

## 实际 vs 预期（archive 复盘）

**复盘日期**：2026-10-27
**对照源**：本 proposal "系统工程影响评估"节 + `openspec/specs/grant-memory/spec.md` baseline。

### 5 字段对照（tier-medium 深度）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：`extension-orchestration`（extensions/index.ts 删 ctxRef）；`policy-core`（trust.ts 删 clearBashGrants） | 实际影响：`extension-orchestration`（删 ctxRef 3 行）；`policy-core`（trust.ts 删 clearBashGrants 声明+实现 + clearSessionGrants 加注释）。**一致**。 |
| 整体性能预期变化：零运行时变化（纯静态删除） | 实际：符合预期——零 IO/零异步/零行为变化；TrustStore 少一个方法不影响 store 构造成本。 |
| 这是局部优化还是全局协调：**局部优化**（清理实现，无全局契约变更） | 实际：确认局部优化。spec 零变更、生产行为零变化、测试零修改（除 4 契约验证）。**无**局部优化→全局失调风险——反而降低失调风险（clearSessionGrants 注释防未来 audit 误标）。 |
| 如果是局部优化，对全局失调的风险：无风险 | 无风险。**事后回检**（主基调第 1 条）：本 change 是否引入"局部最优全局失调"风险？——**无**。删除的是 0-caller 死代码，未触及任何活跃契约。 |
| 预期行为模型（3 契约） | 见下方逐契约验证。 |

### 模型验证（3 契约逐一）

| 契约 | 验证方式 | 结果 |
|---|---|---|
| 契约 1：ctxRef 完全消失 | `grep -n "ctxRef" extensions/index.ts` → 0 命中 | **通过**。 |
| 契约 2：clearBashGrants 完全消失 | `grep -rn "clearBashGrants" src extensions test openspec/specs` → 0 命中 | **通过**。 |
| 契约 3：clearSessionGrants 保留 + 注释 | `grep -n "Test seam" src/lib/trust.ts` → 1 命中；trust.test.ts GM2/GM14 保持 GREEN | **通过**。32/32 trust 测试 GREEN（含 GM2/GM14）。 |

**模型验证结论**：3 契约全部验证通过，预期行为模型成立。

### 预期之外的副作用

1. **无**：本 change 是零影响清理（纯删除 + 注释），未发现预期之外的副作用。
2. **测试覆盖**：全量 689 测试 GREEN（含 trust 32 / sys-integration 16 / grant-memory 3）；AL7 并发审计 flake 1/3 触发（既有，非本 change 引入）。
3. **SYS6 覆盖确认**：`test/sys-integration.test.ts:359` SYS6 真测生产路径（session_start 清空），与 design.md D3 事实链一致——clearSessionGrants 确为测试 seam。

### 未使用的 F2 缓冲槽位

2 个 F2 触发式缓冲槽位**均未触发**（D1 删 ctxRef 一次通过 + D2/D3 删除注释一次通过）。预留但未消耗。
