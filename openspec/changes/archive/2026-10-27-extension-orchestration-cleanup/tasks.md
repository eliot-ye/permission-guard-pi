# Tasks — extension-orchestration-cleanup

## 关键链

```
D1 (删 ctxRef) ──┐
D2 (删 clearBashGrants) ──► D4 (集成验证)
D3 (clearSessionGrants 注释) ──┘
```

**关键链路径**：D1 + D2 + D3 三者并行（无依赖），D4 在三者完成后运行。

**关键链子任务计数**：
- D1: D1-1, D1-2 = **2**
- D2: D2-1, D2-2 = **2**
- D3: D3-1 = **1**
- D4: D4-1, D4-2 = **2**

**总关键链子任务数**：2 + 2 + 1 + 2 = **7**

**Project buffer**：tier-medium 参考 15% → 7 × 0.15 ≈ 1.05，向上取整为 **2 个触发式槽位**（F2-1 / F2-2）。触发式：仅在任一任务出现超预期阻塞时启用。

## 任务列表

### D1: 删除 `ctxRef` 死变量

**RED（写测试）**：不适用（既有测试覆盖 `registerPermissionGate` 全路径，`ctxRef` 从未被测试引用）。

- [x] **D1-1**：编辑 `extensions/index.ts`——删除 3 行：
  - L471：`const ctxRef: { ctx?: PictxLike } = {};`
  - L479：`ctxRef.ctx = ctx;`（`ensureState` 内）
  - L487：`ctxRef.ctx = ctx;`（`session_start` handler 内）
- 验证：`grep -n "ctxRef" extensions/index.ts` 返回 0 命中 ✅。

- [x] **D1-2**：`npm run typecheck` → 0 error（确认无其他隐式依赖 `ctxRef`）。
- 验证：typecheck 0 error（排除 2 个 i18n 已知错误）✅。

### D2: 删除 `clearBashGrants` 死方法

**RED（写测试）**：不适用（0 生产 caller + 0 测试 caller，删除不破坏任何现有代码）。

- [x] **D2-1**：编辑 `src/lib/trust.ts`——删除 2 处：
  - `TrustStore` interface 中的 `clearBashGrants: () => void;`（约 L116）
  - `createTrustStore` 返回对象中的 `clearBashGrants: () => { bashSessionGrants.clear(); },` 实现块（约 L255-258）
- 验证：`grep -rn "clearBashGrants" src extensions test openspec/specs` 返回 0 命中 ✅。

- [x] **D2-2**：`npm run typecheck` → 0 error（确认 interface 与实现同步）。
- 验证：typecheck 0 error（排除 2 个 i18n 已知错误）✅。

### D3: 保留 `clearSessionGrants` + 注释防复发

**RED（写测试）**：不适用（GM2/GM14 已存在，无需新测试）。

- [x] **D3-1**：编辑 `src/lib/trust.ts`——在 `clearSessionGrants` 实现块（约 L213）上方添加注释：
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
- 验证：`grep -n "Test seam" src/lib/trust.ts` 返回 1 命中 ✅。

### D4: 集成验证

**顺序约束**：D4 在 D1 + D2 + D3 完成后运行。

- [x] **D4-1**：运行 `npm run typecheck` → 0 error + `npm test` → 全部 GREEN（689 测试，零修改）。
- 验证：typecheck 0 error（排除 2 个 i18n 已知错误）✅；`npm test` 688/689（唯一失败 AL7 已知并发审计 flake，非本 change 引入）✅。

- [x] **D4-2**：验证 spec 零变更 + 三契约验证：
  - `git diff openspec/specs/` → 空 diff ✅
  - `grep -n "ctxRef" extensions/index.ts` → 0 命中 ✅
  - `grep -rn "clearBashGrants" src extensions test openspec/specs` → 0 命中 ✅
  - `grep -n "Test seam" src/lib/trust.ts` → 1 命中 ✅
- 验证：四项契约全部通过 ✅。

### F2: Project buffer（2 个触发式槽位）

**触发条件**：仅在 D1/D2/D3/D4 中任一任务出现超预期阻塞时启用。

- [x] **F2-1**：缓冲任务槽位 1 —— 未触发（D1 删除 ctxRef 一次通过，无隐式依赖）。
- [x] **F2-2**：缓冲任务槽位 2 —— 未触发（D2/D3 删除 + 注释一次通过，无契约破坏）。

## 任务主体约束验证

- 所有任务主体是**编程性动作**：编辑文件（D1-1, D2-1, D3-1）、运行 CLI（D1-2, D2-2, D4-1, D4-2）
- 无其他非编程性动作作为独立任务主体

## 总任务数与缓冲比例

- 关键链子任务：D1 (2) + D2 (2) + D3 (1) + D4 (2) = **7**
- 非关键链子任务：无
- Project buffer 槽位：**2**（触发式）
- **总任务数**：7 + 2 = **9**
- **Buffer 比例**：2 / 7 ≈ **28.6%**（本 change 任务数少，buffer 相对较大；tier-medium 15% 参考值基础上取整向上）

## 已知问题（架构 review P1/P2 项处理记录）

- **无 P1/P2 项**：本 change 是零影响清理（纯删除 + 注释），无架构 review 应发现的公共契约、类型加宽、装配点问题。若 review 提出，逐条记录并修。
