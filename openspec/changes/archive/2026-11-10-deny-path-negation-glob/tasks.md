# Tasks: deny-path-negation-glob

TDD（RED-GREEN-REFACTOR）。运行：`node --experimental-strip-types --test test/`；类型检查：`npm run typecheck`。

## 关键链与缓冲（critical-buffer，tier-medium → project buffer 35%）

- **关键链**：`1.1`（isDenyHit 单测）→ `1.2`（config 解析单测）→ `1.3`（decide 判定集成测试）→ `2.1`（isDenyHit 实现）→ `2.2`（config resolveDenyPath 装配）→ `2.3`（decide step 0.5）→ `3.1` → `3.2`（验证）。每条标 `**[关键链]**`。
- **project buffer**：关键链末端留 35%（tier-medium，表 1）。**不压缩**。

## Caller Impact 实测（步骤 4，实测产出）

| 变更点 | caller 实测 | 兼容结论 |
|---|---|---|
| `RawConfig` 加 `deny?: string[]` | `loadConfigFile` 调用方读取字段，optional 不强制 | additive → 兼容 |
| `MergedPolicy` 加 `resolveDenyPath` 方法 | `decide()` 调用 `policy.resolveDenyPath(absPath)`；签名未改 | 新方法 additive → 兼容 |
| `decide()` 加 step 0.5（deny-path 检查） | `decideTarget` 调用 `decide()`；签名不变 | 新 step additive → 兼容 |
| `DecisionReasonCode` 加 `deny_path_hit` | union 拓宽，无 exhaustive switch | additive → 兼容 |
| `isDenyHit`/`globDenyToRegExp`（新符号） | 无既有 caller | 新符号 → 兼容 |
| `sensitive.ts` hard 规则 | 不迁移、不改 | 零变更 → 兼容 |

**结论**：变更点均为 additive（新字段/新方法/新 step/新符号），无既有 caller 破坏。**实测通过**。

## 1. RED — 测试先行

- [x] 1.1 **[关键链]** 写 `test/deny-path.test.ts`：断言 `isDenyHit` 纯函数——
  - 正向命中无否定 → true（`["**/*.pem"]` + `/x/certs/root.pem` → true）；
  - 正向未命中 → false（`["**/*.pem"]` + `/x/app.ts` → false）；
  - 正向命中 + 否定豁免 → false（`["**/*.pem", "!**/public.pem"]` + `/x/certs/public.pem` → false）；
  - 正向命中 + 否定未命中 → true（`["**/*.pem", "!**/public.pem"]` + `/x/certs/root.pem` → true）；
  - 纯否定列表（无正向）→ false（`["!**/x"]` + 任意 path → false）；
  - `*` 单段（不含 `/`）：`["*.env"]` + `/x/.env` → true、`["*.env"]` + `/x/deep/.env` → false；
  - `**` 跨段：`["**/.env"]` + `/a/b/.env` → true；
  - 顺序无关（否定在前/在后等价）：`["!**/public.pem", "**/*.pem"]` 与 `["**/*.pem", "!**/public.pem"]` 结果相同。
  运行 `node --experimental-strip-types --test test/deny-path.test.ts`，预期 **fail**（模块不存在，RED 确认）。
  - 文件：`test/deny-path.test.ts`；风险：medium；分系统影响：policy-core；依赖：无；估时：8m。
- [x] 1.2 **[关键链]** 同文件加 `mergePolicies` 的 `deny` 段解析测试——
  - global + project + local 三档 `deny` 段 additive 合并（拼成合集，非覆盖）；
  - 缺失 `deny` 字段 → `resolveDenyPath` 恒返 false（向后兼容）；
  - `deny` 含 `!` 否定条目 → `resolveDenyPath` 正确豁免。
  运行同上，预期 **fail**（`resolveDenyPath` 不存在，RED 确认）。
  - 文件：`test/deny-path.test.ts`；风险：medium；分系统影响：policy-core；依赖：无；估时：6m。
- [x] 1.3 **[关键链]** 在 `test/sys-integration.test.ts` 追加 deny-path 集成测试（复用 `withSandbox`/`createMockPi`/`fireToolCall`）：
  - 配置 `deny: ["**/*.pem"]`（项目级）+ 写 `<proj>/certs/root.pem` → `deny_hard`；
  - 同配置 + 写 `<proj>/certs/public.pem`（有 `!**/public.pem` 例外）→ **不**因 deny-path 命中（按后续规则判定）；
  - 未配置 `deny` 段 + 普通路径写 → 行为与引入前一致（非 deny_hard）。
  运行 `node --experimental-strip-types --test test/sys-integration.test.ts`，预期 **DP1/DP2/DP3 fail**（deny-path 检查未接线，RED 确认）。
  - 文件：`test/sys-integration.test.ts`；风险：medium；分系统影响：extension-orchestration + policy-core；依赖：无；估时：8m。

## 2. GREEN — 纯函数 + 集成实现

- [x] 2.1 **[关键链]** 实现 `isDenyHit(path, patterns)` + `globDenyToRegExp(pattern)` 在 `src/lib/path-utils.ts`：
  - `globDenyToRegExp`：`*` → `[^/]*`、`**` → `.*`、其余字符正则转义，对齐 ta-agent `glob.ts:12-38` `globToRegExp` 同构；
  - `isDenyHit`：拆正向/否定 → 正向空返 false → 正向未命中返 false → 否定命中返 false → 否则 true，对齐 ta-agent `glob.ts:44-55` `isDenyHit` 同构。
  验证：1.1 测试 **pass**（GREEN）。
  - 文件：`src/lib/path-utils.ts`；风险：medium；分系统影响：policy-core；依赖：1.1；估时：8m。
- [x] 2.2 **[关键链]** `src/lib/config.ts`：`RawConfig` 加 `deny?: string[]`；`MergedPolicy` 加 `resolveDenyPath(absolutePath: string): boolean`；`mergePolicies` 解析三档 `deny` 段并拼接（`[...global, ...project, ...local]`）注入 `resolveDenyPath`（内部调 `isDenyHit`）。验证：1.2 测试 **pass**。
  - 文件：`src/lib/config.ts`；风险：medium；分系统影响：policy-core；依赖：1.2、2.1；估时：10m。
- [x] 2.3 **[关键链]** `src/lib/decision.ts`：`decide()` 在 step 0（tool+pattern deny）之后、step 1（path 解析）之前加 step 0.5——`policy.resolveDenyPath(absPath)` 命中 → `deny_hard`（`declaration: "unconfigured"`，`reasonCode: "deny_path_hit"`）；`src/lib/reason-codes.ts` `DecisionReasonCode` 加 `deny_path_hit`。验证：1.3 集成测试 **pass**（GREEN）。
  - 文件：`src/lib/decision.ts`、`src/lib/reason-codes.ts`；风险：high；分系统影响：policy-core；依赖：2.2；估时：10m。

## 3. REFACTOR / 验证

- [x] 3.1 **[关键链]** `npm run typecheck` → 通过（`tsc --noEmit`）。
  - 文件：—；风险：low；分系统影响：全 change；依赖：2.3；估时：1m。
- [x] 3.2 **[关键链]** `npm test`（全量）→ 无新增回归（deny-path 测试全绿；既有测试无回归）。
  - 文件：—；风险：low；分系统影响：全 change；依赖：3.1；估时：3m。
- [x] 3.3 **[关键链]** `openspec validate deny-path-negation-glob --type change` → 通过。
  - 文件：—；风险：low；分系统影响：全 change；依赖：3.2；估时：1m。
