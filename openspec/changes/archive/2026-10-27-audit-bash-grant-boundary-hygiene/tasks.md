## 关键链

**关键链路径**：1（B2）→ 2（B5）→ 3（B3）→ 4（B4）→ 6（集成验证）。B6 与 1-4 独立（仅 package.json），并行。

- 关键链子任务：1.1-1.3 (3) + 2.1-2.4 (4) + 3.1-3.4 (4) + 4.1-4.3 (3) + 6.1-6.4 (4) = **18**
- 非关键链子任务：5.1-5.2 (2，独立并行)
- Project buffer 槽位：**1**（tier-medium 参考值 15%，本 change 均为加宽/向后兼容修复、无高风险决策，取 1 个触发式槽位）
- **总任务数**：18 + 2 + 1 = **21**
- **Buffer 比例**：1 / 18 ≈ **5.6%**（低于 tier-medium 15%，因本 change 全部为低风险加宽/向后兼容修复，buffer 需求低）

## 1. B2: BashGrantInput 类型收窄

- [x] 1.1 `src/lib/trust.ts`：`BashGrantInput = Omit<BashGrant, "createdAt">` → `Omit<BashGrant, "commandHash" | "createdAt">`，更新类型注释说明"commandHash 由 store 派生"
- [x] 1.2 适配 6 处调用方删 `commandHash` 传参：`extensions/index.ts:1080` + `test/trust.test.ts:266,292,316,323,508`
- [x] 1.3 `npm run typecheck` → 仅剩 2 个既有 error（`index.test.ts` + `approval-flow.test.ts`，HEAD 上已存在），无新增

## 2. B5: audit 截断补 commandHash

- [x] 2.1 `src/lib/audit.ts`：`AuditRecord` 加可选 `commandHash?: string` + `import { createHash } from "node:crypto"`
- [x] 2.2 `truncateCommand` 截断时补写 `commandHash = sha256(原始命令)`（未截断不写）
- [x] 2.3 `test/audit.test.ts` 新增 AL9：长命令截断 → commandHash 为原始命令 64 位 sha256 + 截断标记 + note
- [x] 2.4 `node --experimental-strip-types --test test/audit.test.ts` → 10 个测试全 GREEN

## 3. B3: stripJsonComments 单引号处理删除

- [x] 3.1 `test/config.test.ts` 新增 PC4b（注释内单引号不吞文件）+ PC4c（结构性单引号 → `loadConfigFile` 返回 `error`）—— RED 确认
- [x] 3.2 `src/lib/config.ts` + `src/lib/settings.ts`：`if (ch === '"' || ch === "'")` → 只保留 `"`，加注释说明 JSONC 双引号边界
- [x] 3.3 `openspec/specs/permission-config/spec.md`：JSONC 语法 requirement 加"单引号不是字符串分隔符（B3 边界条款）"scenario
- [x] 3.4 `node --experimental-strip-types --test test/config.test.ts` → 38 个测试全 GREEN

## 4. B4: isDefaultTmpPath 补 /var/tmp

- [x] 4.1 `test/decision.test.ts`：default_tmp_paths 断言补 `/var/tmp`、`/var/tmp/x`、`/var/tmp/deep/nested.txt` —— RED 确认
- [x] 4.2 `src/lib/decision.ts`：`isDefaultTmpPath` 补 `/var/tmp` + `/var/tmp/` 前缀 + 注释
- [x] 4.3 `node --experimental-strip-types --test test/decision.test.ts` → 59 个测试全 GREEN

## 5. B6: package.json files 白名单

- [x] 5.1 `package.json`：`files` 补 `"docs/"` + `"examples/"`
- [x] 5.2 `npm pack --dry-run` 校验 docs/ + examples/ 进入包（不发布，仅 dry-run）

## 6. 集成验证

- [x] 6.1 `npm run typecheck` → 仅剩 2 个既有 error，无新增
- [x] 6.2 `npm test` → 692 个测试全 GREEN（689 基线 + 3 新增：AL9/PC4b/PC4c）
- [x] 6.3 `openspec validate --specs` → 6 passed / 0 failed
- [x] 6.4 `openspec/specs/grant-memory/spec.md` 加 B5 `commandHash` 条款（与 delta 一致）
