## 关键链与缓冲

- **关键链（critical chain）**：1.1（RED 测试）→ 2.1（GREEN 实现）→ 3.1（系统级验证）。串行依赖：TDD 要求测试先于实现、实现先于验证。
- **关键链估时**：1.1 ≈ 15min、2.1 ≈ 5min、3.1 ≈ 10min，合计 ≈ 30min。
- **project buffer**：30min × 35%（tier-medium，strength-matrix 表 1）≈ 10min，留在 3.1 集成测试（既有 sys-integration 套件回归）上。
- **任务主体约束**：每条 task 主体均为编程性动作（写测试 / 改代码 / 跑 CLI / 跑探针），非编程性动作降级为该 task 的验证字段。

## 1. 回归测试（RED）

- [x] 1.1 在 `test/sys-integration.test.ts` 追加 SYS 场景：项目内符号链接 `link_to_outer` → sandbox 内非敏感外区目录（避开 `/tmp` 兜底与 `~/.ssh` 敏感），bash 命令 `truncate -s 0 <projectRoot>/link_to_outer/file.txt`（write，外区非敏感 → tier=three prompt）。第一次 `uiChoice="Always allow (save to trusted.json)"` 存持久 grant（键 = resolvedPath realpath）；第二次同命令断言 `result === undefined` 且 `promptCount === 0`（auto_allow 免弹）。验证：实现前先跑该测试确认**失败**（第二次 `promptCount === 1`，复现 V3），证明测试有效。
  - 验证：`node --experimental-strip-types --test test/sys-integration.test.ts` 中该场景在 2.1 实现前 FAIL（promptCount=1）、实现后 PASS。

## 2. 实现修复（GREEN）

- [x] 2.1 修 `extensions/index.ts` 的 `decideTarget` grant 查询段（L770-787）：`if (hasGrant(state, action, absPath))` 改为 `if (hasGrant(state, action, absPath) || hasGrant(state, action, canonicalPath))`（`canonicalPath` 在 L751 已算出）。grant 命中分支内的 `lookupGrantAuthor` 调用同步改为查命中键：`const hitPath = hasGrant(state, action, absPath) ? absPath : canonicalPath; const author = state.trust.lookupGrantAuthor(state.projectHash, action, hitPath) ?? "by_person";`。验证：跑 1.1 测试通过 + 既有 sys-integration 套件全绿。
  - 验证：`node --experimental-strip-types --test test/sys-integration.test.ts` 全绿（含新 SYS 场景 PASS + SYS7 等既有场景不回归）。

## 3. 系统级验证

- [x] 3.1 typecheck + 全套测试。验证：`npm run typecheck`（tsc --noEmit）0 error；`npm test`（`node --test "test/*.test.ts" "extensions/*.test.ts"`）0 失败。覆盖 policy-core / side-effects / extension-orchestration 跨分系统回归。
- [x] 3.2 复跑探针 `test/probe-v3-bash-symlink-grant.mjs` 确认修复在探针层面生效。验证：探针输出"[第二次] result: undefined, promptCount: 0"且结论行"V3 证伪：第二次 auto_allow"（即 grant 命中免弹）。
