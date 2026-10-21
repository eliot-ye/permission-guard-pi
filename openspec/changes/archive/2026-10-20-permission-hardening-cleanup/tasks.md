# Tasks

## 关键链与 project buffer

**关键链（Critical Chain）**：T1 (audit 权限 + 截断测试) → T2 (audit 权限 + 截断实现) → T6 (全量 npm test 回归)。

**次关键链**：T5.1a → T5.1b/c/d（spec 与 test 同步清理）→ T5.1e（契约漂移校验）→ T6。T5 支线与 T1-T3 并行不阻塞关键链，但必须汇入 T6 前完成。

**关键链理由**：`audit-log` 是本 change 唯一的公共契约变更面（`grant-memory` 是新增 ADDED requirement，不涉及既有契约的兼容性判断），T1+T2 定义了本 change 的边界行为。T3 (trust 权限) 与 T4/T5/T7 是并行的独立改动，不阻塞 T6 的最终验证——但它们都属于关键链之外的 feeding 支流。

**Project buffer**：tier-medium 下按 strength-matrix 表 1 取 35%。本 change 关键链总估时约 2 小时（T1: 30 min 写 6 条测试、T2: 30 min 实现、T6: 5 min 回归、T3/T4/T5/T7 并行 60 min + 30 min 回归兜底），buffer 35% ≈ 45 min——留在此关键链末端作为 T8（缓冲收尾）承接意外（例如属主检查在测试环境失败、截断字符序列化差异）。

**Feed buffer**：T3/T4/T5/T7 各自汇入 T6，无独立 feed buffer（每条支流动作量小于 30 min，无需再拆）。

**主体合规**：所有 task 主体都是 agent 可执行的编程性动作（写文件 / 跑命令 / grep 断言 / 断言通过）。人工验证（如"用户手动 chmod 回 0644 看是否被收敛"）降级为对应 task 的 `验证` 字段补充，且附等价机械项（`node -e "fs.stat(...).mode"` 直接断言）。

---

## 1. 审计日志：TDD 测试先行（RED）

- [ ] T1.1 新增 `test/audit-permissions.test.ts`，实现 6 条 🔴 测试断言（ALP1-ALP6），跑 `npm test -- test/audit-permissions.test.ts` 确认全部失败（预期 RED 状态：现有 `createAuditLogger` 不支持权限收敛与截断）
  - 文件：`test/audit-permissions.test.ts`（新建）
  - 风险：medium（新测试面，需保证与既有 audit 测试独立可跑）
  - 验证：`npm test -- test/audit-permissions.test.ts 2>&1 | tail -20` 输出中 6 条测试均以 `✖` 失败；错误信息包含 `Expected ... mode to be 0o600` / `Expected note to contain 'command truncated'` 等断言失败文本
  - 分系统影响：side-effects.audit（tier-small）—— 仅测试面
  - 依赖：无

- [ ] T1.2 补 3 条 trusted.json 权限断言（GMP1-GMP3）到 `test/trust.test.ts`，跑 `npm test -- test/trust.test.ts` 确认新增 3 条 🔴 失败、既有 GM1-GM10 仍全绿
  - 文件：`test/trust.test.ts`
  - 风险：low（追加，不改既有测试）
  - 验证：`npm test -- test/trust.test.ts 2>&1 | grep -E "^(✔|✖|ℹ)" | wc -l` 输出 ≥ 20 且失败行仅来自 GMP1/GMP2/GMP3 三条
  - 分系统影响：policy-core.trust（tier-medium）—— 仅测试面
  - 依赖：无

## 2. 审计日志：实现权限收敛与截断（GREEN）

- [ ] T2.1 修改 `src/lib/audit.ts`：在 `append` 闭包内、`appendFile` 之前插入 `fs.stat + 属主检查 + fs.chmod(logPath, 0o600)`；`fs.mkdir` 补 `{ mode: 0o700, recursive: true }`；chmod 与 stat 全部包在 try/catch 内，异常时 `failures.push(err)` 但不阻塞 append
  - 文件：`src/lib/audit.ts`
  - 风险：high（跨公共契约的行为变更；触及 fire-and-forget 语义）
  - 验证：`npm test -- test/audit.test.ts 2>&1 | tail -5` 输出 `# pass 8 # fail 0`（既有 8 条 AL 测试仍全绿）
  - 分系统影响：side-effects.audit（tier-small）
  - 依赖：T1.1

- [ ] T2.2 修改 `src/lib/audit.ts`：在 `append` 闭包内实现 `command` 字段截断（>512 字符时截到 511 + `…`，`note` 追加 `; command truncated`）
  - 文件：`src/lib/audit.ts`
  - 风险：medium（新增字段语义，向后兼容）
  - 验证：`npm test -- test/audit-permissions.test.ts 2>&1 | tail -20` 中 ALP1-ALP6 全部 `✔` 通过；`npm test -- test/audit.test.ts 2>&1 | tail -5` 仍 `# pass 8 # fail 0`
  - 分系统影响：side-effects.audit（tier-small）
  - 依赖：T2.1

## 3. trusted.json：实现权限收敛

- [ ] T3.1 修改 `src/lib/trust.ts`：`createTrustStore` 中 `fs.mkdir(dirname(trustedFilePath), { recursive: true, mode: 0o700 })`；`atomicWrite` 在 `fs.rename` 成功后 `fs.stat + 属主检查 + fs.chmod(target, 0o600)`，异常时不阻塞写入但抛给调用方（沿用现有 `addPersistentGrant` 的 catch → session 降级路径）
  - 文件：`src/lib/trust.ts`
  - 风险：high（跨公共契约；触及原子写入路径）
  - 验证：`npm test -- test/trust.test.ts 2>&1 | tail -5` 输出 `# pass 13 # fail 0`（既有 GM1-GM10 + 新增 GMP1-GMP3 全绿）
  - 分系统影响：policy-core.trust（tier-medium）
  - 依赖：T1.2

## 4. bash-extract：cargo 集合冲突修复

- [ ] T4.1 补 7 条 BT-CARGO-* 回归测试到 `test/bash-extract.test.ts`（BT-CARGO-1 到 BT-CARGO-7，见 proposal 覆盖账本），跑 `npm test -- test/bash-extract.test.ts` 确认 BT-CARGO-1（cargo check）与 BT-CARGO-2（cargo metadata）失败，其余 5 条通过
  - 文件：`test/bash-extract.test.ts`
  - 风险：low
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出恰为 `BT-CARGO-1` 与 `BT-CARGO-2` 两行；BT-CARGO-3 到 BT-CARGO-7 均为 `✔`
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：无

- [ ] T4.2 从 `src/lib/bash-extract.ts` 的 `UNRELIABLE_COMMANDS` 集合中移除 `"cargo"` 字面项（当前位于该 Set 的 `// Formerly-SILENT commands moved to UNRELIABLE` 注释下）；不动 `SILENT_COMMANDS.cargo`
  - 文件：`src/lib/bash-extract.ts`（第 925-939 行区间的 Set 定义）
  - 风险：medium（改变 isAnyUnreliableCommand 对 cargo 前缀的返回值）
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | tail -5` 输出 `# pass N # fail 0`（N = 既有测试数 + 7），BT-CARGO-1 与 BT-CARGO-2 由 `✖` 变 `✔`
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T4.1

## 5. 死代码与配置清理

- [ ] T5.1a 删除 `extensions/index.ts` 中 `bashPermissionForReason` 的三个死 case（`"device_redirect"` / `"bounded_glob"` / `"unresolved_variable"`）与 `bashSubtitleForReason` 的 `"bounded_glob"` case
  - 文件：`extensions/index.ts`（第 166-169 行、205-206 行）
  - 风险：low（纯死分支删除）
  - 验证：`grep -c "device_redirect\|bounded_glob\|unresolved_variable" extensions/index.ts src/` 输出为 `0`
  - 分系统影响：extension-orchestration（tier-small）
  - 依赖：无

- [ ] T5.1b 回写 baseline spec：`openspec/specs/approval-flow/spec.md`——删除 `device_redirect` 与 `bounded_glob` 两条副文本 scenario；修改"两档 vs 三档弹窗"requirement 的 bash_reason 列举，去掉 `device_redirect` / `bounded_glob` 两项
  - 文件：`openspec/specs/approval-flow/spec.md`
  - 风险：medium（公共契约变更）
  - 验证：`grep -c "device_redirect\|bounded_glob" openspec/specs/approval-flow/` 输出为 `0`
  - 分系统影响：approval-flow（tier-medium）
  - 依赖：T5.1a

- [ ] T5.1c 回写 baseline spec：`openspec/specs/grant-memory/spec.md`——删除"Bash 命令记忆渠道"requirement 授权类型映射中的 `device_redirect` / `bounded_glob` 条目；删除对应 benign scenario
  - 文件：`openspec/specs/grant-memory/spec.md`
  - 风险：medium（公共契约变更）
  - 验证：`grep -c "device_redirect\|bounded_glob" openspec/specs/grant-memory/` 输出为 `0`
  - 分系统影响：policy-core（tier-medium）
  - 依赖：T5.1a

- [ ] T5.1d 更新 `test/trust.test.ts` 的测试数据：GM13 / GM15 / GM16 / GM17 / GM18 的 `addBashSessionGrant` / `addBashPersistentGrant` 参数值从 `device_redirect` 替换为 `glob_expansion`；同步替换 GM17 内的 `assert.equal(g.reason, "device_redirect")` 断言为 `assert.equal(g.reason, "glob_expansion")`
  - 文件：`test/trust.test.ts`
  - 风险：low（仅测试数据替换，断言逻辑不变）
  - 验证：`grep -c "device_redirect" test/trust.test.ts` 输出为 `0`；`npm test -- test/trust.test.ts 2>&1 | tail -5` 输出 `# fail 0`
  - 分系统影响：policy-core.trust（tier-medium）—— 测试面
  - 依赖：T5.1a、T5.1c

- [ ] T5.1e 全局契约漂移校验：确认 baseline spec 与代码不再存在死契约残留
  - 文件：无（验证动作）
  - 风险：low
  - 验证：`grep -c "device_redirect\|bounded_glob\|unresolved_variable" src/ extensions/ test/ openspec/specs/` 输出为 `0`；`npm test 2>&1 | tail -5` 输出 `# fail 0`
  - 分系统影响：无
  - 依赖：T5.1a、T5.1b、T5.1c、T5.1d

- [ ] T5.2 删除 `test/decision.test.ts` 中 `AD19: unreliable bash extraction (integration-covered placeholder)` 空转测试（第 428-430 行）
  - 文件：`test/decision.test.ts`
  - 风险：low（删除恒真断言）
  - 验证：`grep -c "integration-covered placeholder" test/decision.test.ts` 输出 `0`；`npm test -- test/decision.test.ts 2>&1 | tail -5` 输出 `# fail 0`（既有其他 AD 测试不受影响）
  - 分系统影响：测试基础设施
  - 依赖：无

- [ ] T5.3 修改 `package.json` 的 `scripts.test` 字段：`node --experimental-strip-types --test test/**/*.test.ts extensions/**/*.test.ts` → `node --experimental-strip-types --test "test/*.test.ts"`
  - 文件：`package.json`
  - 风险：low
  - 验证：`grep '"test":' package.json` 输出行不含 `extensions/**/*.test.ts` 且不含 `test/**/*.test.ts`；`npm test 2>&1 | tail -5` 输出 `# pass N # fail 0`（N = 既有测试总数 - 1，因为删了 1 条占位）
  - 分系统影响：测试基础设施
  - 依赖：T5.2（顺序上先删占位再跑全量）

## 6. 全量回归

- [ ] T6.1 跑 `npm test` 全量测试，确认 `# pass N # fail 0`（N = 448 - 1 占位 + 16 新增 = 463），无 flaky；同时跑 `node --experimental-strip-types test/security-probe.mjs` 确认 35/35 通过（该探针不受本 change 影响，仅验证 extractor 未被 T4.2 意外破坏）
  - 文件：无（验证动作）
  - 风险：medium（跨分系统回归）
  - 验证：`npm test 2>&1 | tail -5` 输出 `# pass 463 # fail 0`；`node --experimental-strip-types test/security-probe.mjs 2>&1 | tail -3` 输出 `35 passed, 0 failed out of 35`
  - 分系统影响：全部子系统
  - 依赖：T2.2、T3.1、T4.2、T5.3

## 7. 契约与规格完整性

- [ ] T7.1 跑 `openspec validate permission-hardening-cleanup --type change --json` 确认无 structural 问题；跑 `openspec status --change permission-hardening-cleanup --json` 确认所有 applyRequires artifact 状态为 `done`
  - 文件：无（验证动作）
  - 风险：low
  - 验证：`openspec validate permission-hardening-cleanup --type change --json` 输出中 `issues` 数组为空或 `errors: []`；`openspec status --change permission-hardening-cleanup --json` 输出中每个 artifact `status === "done"`
  - 分系统影响：无
  - 依赖：T1-T5 全部完成（proposal 定型后 specs/design/tasks 已创建，本 task 只做 validate 校验）

## 8. 缓冲收尾（project buffer 35%）

- [ ] T8.1 缓冲任务：若 T1-T6 中任一 task 出现非预期失败（如 chmod 在测试 tmpdir 上行为差异、Unicode `…` 序列化问题、属主检查在 CI 环境失败），此 task 承接修复；预计耗时 45 min 上限
  - 文件：视情况而定（预期为空操作）
  - 风险：low
  - 验证：本 task 完成时 T6.1 的验证字段全部通过；若 T1-T6 已一次通过，则本 task 主体为空但打勾（记录"buffer 未被消耗"）
  - 分系统影响：视情况而定
  - 依赖：T1-T7 全部完成

## 10. 6.3 Review 反馈修复（追加任务）

Code review (deep+verify) 发现 6 个 issues 后追加的修复任务。

- [x] T10.1 P1-1/P1-2：恢复 `cargo` 到 `UNRELIABLE_COMMANDS` + 删除 `SILENT_COMMANDS.cargo` + 更新 BT-CARGO-1/2 期望为 `unreliable_command` + 更新 BT-B16-f 断言 + 新增 BT-CARGO-8..11 覆盖复合命令与 `--manifest-path` 越界读
  - 文件：`src/lib/bash-extract.ts`、`test/bash-extract.test.ts`
  - 风险：medium（回归既有行为）
  - 验证：`npm test -- test/bash-extract.test.ts` 中 BT-CARGO-1 到 BT-CARGO-11 全部通过
  - 分系统影响：side-effects.bash-extract
  - 依赖：无

- [x] T10.2 P2-3：`bashPermissionForReason` / `bashSubtitleForReason` 改前缀匹配 `unresolved variable:`
  - 文件：`extensions/index.ts`
  - 风险：medium（修复 spec 承诺与实际行为不一致）
  - 验证：`npm test -- extensions/index.test.ts` 全绿
  - 分系统影响：extension-orchestration、approval-flow
  - 依赖：无

- [x] T10.3 P2-4：`createTrustStore` 显式 `chmod(dirname, 0o700)`
  - 文件：`src/lib/trust.ts`
  - 风险：medium（真实安全缺口修复）
  - 验证：`npm test -- test/trust.test.ts` GMP2 通过；实测脚本显示 pre-existing 0o755 目录被 chmod 到 0o700
  - 分系统影响：policy-core.trust
  - 依赖：无

- [x] T10.4 P2-5：`audit.ts` 用 `fs.open(logPath, "a", 0o600)` 让首次写入即 0o600
  - 文件：`src/lib/audit.ts`
  - 风险：medium（真实安全缺口修复）
  - 验证：`npm test -- test/audit-permissions.test.ts` 全绿；实测脚本显示首行以 0o600 落盘
  - 分系统影响：side-effects.audit
  - 依赖：无

- [x] T10.5 P3-6：删除 `test/trust.test.ts` 未使用的 `writeFile` import
  - 文件：`test/trust.test.ts`
  - 风险：low
  - 验证：`npm test -- test/trust.test.ts` 全绿
  - 分系统影响：测试基础设施
  - 依赖：无

- [x] T10.6 全量回归：`npm test` 467 pass / 0 fail；`node --experimental-strip-types test/security-probe.mjs` 35/35 pass
  - 文件：无（验证动作）
  - 风险：medium（跨分系统回归）
  - 验证：`npm test 2>&1 | tail -5` 输出 `# pass 467 # fail 0`；`security-probe` 输出 `35 passed, 0 failed out of 35`
  - 分系统影响：全部子系统
  - 依赖：T10.1 到 T10.5
