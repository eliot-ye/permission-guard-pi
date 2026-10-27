# Design — extension-orchestration-cleanup

## 设计决策概览

本 change 由三个正交子决策组成，实现顺序可任意（三者无运行时依赖）：

- **D1**：删除 `ctxRef` 死变量（`extensions/index.ts`）
- **D2**：删除 `clearBashGrants` 死方法（`src/lib/trust.ts`）
- **D3**：保留 `clearSessionGrants` 测试 seam + 加注释防复发（`src/lib/trust.ts`）
- **D4**：集成验证（删除安全 + 测试 seam 保持）

**核心约束**：spec 零修改；生产行为零变化；测试零修改。这是纯删除 + 注释型 change，3 个契约通过 grep 与 test 直接验证。

## D1：删除 `ctxRef` 死变量

### 现状

`extensions/index.ts` 中 `registerPermissionGate` 函数内：

```ts
let state: SessionState | undefined;          // L470
const ctxRef: { ctx?: PictxLike } = {};       // L471  ← 死变量
const ensureState = async (ctx: PictxLike): Promise<SessionState> => {
  if (!state) {
    state = await initSession(ctx, opts);
    ctxRef.ctx = ctx;                         // L479  ← 写入但从不读
  }
  return state;
};

pi.on("session_start", async (_e: any, ctx: PictxLike) => {
  try {
    state = await initSession(ctx, opts);
    ctxRef.ctx = ctx;                         // L487  ← 写入但从不读
    ...
```

**事实**：`ctxRef` 定义后只有 3 行 `ctxRef.ctx = ctx` 赋值，**从未被读取**（`grep "ctxRef" extensions/index.ts` 只返回 3 处，2 处赋值 + 1 处声明，无 reader）。

### 删除步骤

删除 3 行：
- L471：`const ctxRef: { ctx?: PictxLike } = {};`
- L479：`ctxRef.ctx = ctx;`
- L487：`ctxRef.ctx = ctx;`

### 验证

- `grep -n "ctxRef" extensions/index.ts` 返回 0 命中
- `npm run typecheck` → 0 error（确认无其他隐式依赖）
- `npm test` → 全部 GREEN

## D2：删除 `clearBashGrants` 死方法

### 现状

`src/lib/trust.ts` 中：

```ts
export interface TrustStore {
  ...
  // Bash-command session-level (in-memory).
  hasBashSessionGrant: (projectHash: string, rawCommand: string) => boolean;
  addBashSessionGrant: (projectHash: string, rawCommand: string, reason: string, permission: Permission) => void;
  clearBashGrants: () => void;                // L106  ← 死声明
  ...
}

// 实现块
clearBashGrants: () => {                      // L255  ← 死实现
  bashSessionGrants.clear();
},
```

**事实**：
- 生产调用：0（`grep -rn "clearBashGrants" src extensions` 返回 0 命中）
- 测试调用：0（`grep -rn "clearBashGrants" test` 返回 0 命中；GM2 和 GM14 走的是 `clearSessionGrants`）

### 删除步骤

删除 2 处：
- L106：`clearBashGrants: () => void;`（interface 声明）
- L255-258：`clearBashGrants: () => { bashSessionGrants.clear(); },`（实现块）

### 说明：为什么 `clearSessionGrants` 保留

- `clearSessionGrants` **生产也不调**（`session_start` 通过 `initSession` 重建 `TrustStore` 对象清空 session grants）
- 但 `clearSessionGrants` 是 **GM2 和 GM14 测试的 seam**——测"清空 session grant 语义"
- 若也删掉 `clearSessionGrants`，GM2/GM14 需要重写成"新建 store → 断言空"（无意义测试）
- 因此 `clearSessionGrants` 保留作测试 seam，加注释防未来 audit 误标（见 D3）

### 验证

- `grep -rn "clearBashGrants" src extensions test openspec/specs` 返回 0 命中（全无引用）
- `npm run typecheck` → 0 error
- `npm test` → 全部 GREEN

## D3：保留 `clearSessionGrants` 测试 seam + 注释防复发

### 现状

`clearSessionGrants` 方法位于 `src/lib/trust.ts:213-215`：

```ts
clearSessionGrants: () => {
  sessionGrants.clear();
  bashSessionGrants.clear();
},
```

生产不调用（`session_start` 通过 `initSession` 重建 `TrustStore` 对象清空），但被 GM2 (`test/trust.test.ts:38`) 和 GM14 (`test/trust.test.ts:258`) 用作测试 seam。

### 修改

在方法上方添加注释：

```ts
// Test seam — production clears via initSession → new TrustStore (see SYS6
// integration test, test/sys-integration.test.ts:359). Kept for unit tests
// GM2 (path-based, test/trust.test.ts:38) and GM14 (bash-command-based,
// test/trust.test.ts:258). Do not delete: production path is covered by SYS6.
clearSessionGrants: () => {
  sessionGrants.clear();
  bashSessionGrants.clear();
},
```

### 验证

- `grep -n "Test seam" src/lib/trust.ts` 返回 1 命中
- GM2/GM14 保持 GREEN（`clearSessionGrants` 仍被测试调用）
- `test/sys-integration.test.ts` SYS6 保持 GREEN（真测生产路径）

### 事实链（防未来 audit 复发）

`grant-memory/spec.md:107-111`「会话级记忆在 session_start 清空」契约的**真实满足路径**：

1. `session_start` handler 触发（`extensions/index.ts:484`）
2. `state = await initSession(ctx, opts)`（L486）
3. `initSession` 内部 `const trust = await createTrustStore(trustedPath);`（L134）
4. `createTrustStore` 创建新的 `sessionGrants = new Set<string>()` 与 `bashSessionGrants = new Set<string>()`（`src/lib/trust.ts:211-214`）
5. 返回新 `TrustStore` 对象给 `state`，旧的（若有）被 GC
6. → spec 契约"session_start 清空会话级记忆 Map"**通过对象替换满足**

spec scenario 由 **SYS6** 集成测试真测：
- `test/sys-integration.test.ts:359-425`：两个独立 `registerPermissionGate` 实例（模拟两次 session）
- s1 里用户选 `allow_session`，第二次同 tool_call auto-allow（session grant 生效）
- s2 里同 tool_call 重新弹窗（session grant 已清空）
- → 验证 spec scenario「前一会话做过会话内允许，新 session 触发 → 会话级 Map 空」

**因此**：
- `clearSessionGrants` 是"测试 seam 而非生产路径"——生产路径已通过 SYS6 覆盖
- 删掉 `clearSessionGrants` 会降低测试价值（GM2/GM14 变成无意义测试）
- 保留 + 加注释是正确决策

## D4：集成验证

在 D1 + D2 + D3 完成后运行：

1. `grep -n "ctxRef" extensions/index.ts` → 0 命中
2. `grep -rn "clearBashGrants" src extensions test openspec/specs` → 0 命中
3. `grep -n "Test seam" src/lib/trust.ts` → 1 命中
4. `npm run typecheck` → 0 error
5. `npm test` → 全部 GREEN（764 测试零修改）
6. `git diff openspec/specs/` → 空 diff（spec 未变）

## 边界约束

- 不修改任何 spec 文本
- 不新增任何生产调用
- 不删除 `clearSessionGrants`（测试 seam 保留）
- 不添加新的 session_start → clear 集成测试（SYS6 已覆盖）
- `TrustStore` interface 与实现同步删除（保持"interface 声明 ↔ 实现"配对约定）

## 与既有架构/风格的遵循关系

- 删除死变量 + 死方法，不引入新代码路径
- 注释风格遵循 `src/lib/trust.ts` 内既有 JSDoc / 行注释风格
- `TrustStore` interface 与实现同步维护（删除接口方法时同步删除实现）

## 偏离既有架构

**无**——本次是既有模式的清理（删死代码 + 注释说明测试 seam），不引入新架构风格。

## 已知风险与缓冲

- **风险 R1**：`clearSessionGrants` 注释可能被未来 audit 忽略（audit 只看代码不看注释）→ 缓解：注释明确提到 "Do not delete: production path is covered by SYS6"，且未来 audit 可通过 grep SYS6 与 trust.test.ts GM2/GM14 交叉验证
- **缓冲策略**：F2 触发式缓冲槽位 2 个（tier-medium 15% × 6 = 0.9，向上取整到 2；本 change 任务数少，buffer 相对较大）
