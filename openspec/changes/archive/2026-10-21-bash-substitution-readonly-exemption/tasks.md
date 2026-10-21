# Tasks: bash-substitution-readonly-exemption

**Critical Chain**：Task 1.1 → 1.2 → 1.3 → 1.4 → 2.1 → 2.2 → 3.1（RED 测试先落，GREEN 实现跟随，验证兜底）

**Project Buffer**：tier-medium，critical-chain buffer ≈ 15%；本任务清单已含 3 项验证 / 兜底任务作为 buffer 载体（3.1 回归测试全绿、3.2 全量测试矩阵、3.3 审计日志抽样检查）。

## 1. RED：新增豁免相关测试（先落测试，不通过）

- [x] 1.1 在 `test/bash-extract.test.ts` 追加 4 个正向豁免测试（`substitution_basename_in_for_loop_reliable` / `substitution_nested_basename_dirname_reliable` / `substitution_dirname_reliable` / `substitution_pwd_reliable`）：验证 spec 场景 1 / 2 / 10 / 11。**验证**：`npm test` 全量 532/532 全绿；单个测试 `substitution_basename_in_for_loop_reliable` PASS（原 RED 阶段 FAIL 因 `reason: command_substitution`）。

- [x] 1.2 在 `test/bash-extract.test.ts` 追加 6 个反例测试（`substitution_cat_still_unreliable` / `substitution_realpath_still_unreliable` / `substitution_glob_arg_still_unreliable` / `substitution_depth_over_3_still_unreliable` / `substitution_nested_rm_still_unreliable` / `substitution_with_user_var_still_unreliable`）：验证 spec 场景 3 / 4 / 5 / 6 / 7 / 8。**验证**：全量 `npm test` 中 6 个反例测试全部 PASS，且既有 BTP8/BTP14/BT-B7i 仍 PASS。

- [x] 1.3 在 `test/bash-extract.test.ts` 追加 1 个交互测试（`substitution_echo_then_rm_writes_target`）：验证 spec 场景 9。**验证**：`echo "$(basename $f)" && rm -rf /tmp/scratch` → `reliable: false, reason: unresolved variable: f`（豁免成功——`$(basename $f)` 未触发 `command_substitution`）；用不含变量版本 `echo "$(basename foo.txt)" && rm -rf /tmp/scratch` → `reliable: true` 且 targets 含 `delete /tmp/scratch`。

- [x] 1.4 追加审计回归测试 `substitution_btp_audit_97_still_triggers_prompt`：验证既有 `BTP-audit-97` 用例（`cd /proj && echo "count: $(grep -c 'X' file.md)"`）仍判 unreliable, reason=command_substitution。**验证**：PASS，豁免不破坏既有 audit-97 守卫。

## 2. GREEN：实现豁免判定

- [x] 2.1 在 `src/lib/bash-extract.ts` 新增 `SUBSTITUTION_READONLY_CMDS: Set<string>` 常量（7 个命令：`basename`/`dirname`/`echo`/`printf`/`pwd`/`test`/`[`），并导出。**验证**：模块 import 后可枚举，命名与既有 `READ_ONLY_COMMANDS`/`SILENT_COMMANDS` 风格一致。

- [x] 2.2 在 `src/lib/bash-extract.ts` 新增 `isSubstitutionReadOnlyAt(cmd: string, startPos: number, depth: number): SubstitutionScanResult` 递归 helper 函数（导出），按 D2/D3/D4 决策实现：单遍字符扫描、维护局部 quote/escaped/parenDepth 状态机、递归判定嵌套 substitution（depth > 3 拒绝）、提取顶层命令名做白名单匹配、参数侧排除未加引号 glob/heredoc/backtick/非豁免嵌套。**验证**：单测层面 `substitution_basename_in_for_loop_reliable`/`substitution_nested_basename_dirname_reliable`/`substitution_depth_over_3_still_unreliable`/`substitution_nested_rm_still_unreliable` 均符合预期。

- [x] 2.3 在 `src/lib/bash-extract.ts` 的 `scanUnreliable` 函数两处 `$(` 分支（双引号内 + 引号外）内联豁免调用；豁免成功时 `i = sub.closingParen; continue`，失败时 `return "command_substitution"`（默认行为零变化）。**验证**：`npm test` 全量 532/532 全绿；既有 BT9/BTP8/BTP14/BTP-audit-97/BT-B7i 全部 PASS。

## 3. 验证与收尾

- [x] 3.1 全量 `npm test` 通过。**验证**：`ℹ tests 532` `ℹ pass 532` `ℹ fail 0`。首次运行偶发 AL4 audit flake（临时目录竞态，与本 change 无关；stash 改动后同测试 520/520 全绿，恢复改动后重跑即 532/532 全绿），符合 TODO 池中 [P2] "AF7 测试临时目录清理竞态 flake" 记录的既有环境性 flake 特征。

- [x] 3.2 手动复现用户报告原始场景。**验证**：`extractBashTargets("for f in openspec/changes/archive/*/proposal.md; do echo \"=== $(basename $(dirname $f)) ===\"; head -20 \"$f\"; echo; done", "/Users/eliot/my/@permission-system:pi-extension")` → `{ reliable: true, targets: [] }`，`reliable: true` 且无 `command_substitution` reason——弹窗噪音消除。

- [x] 3.3 抽样 audit log。**验证**：`~/.pi/agent/extensions/@permission-system:pi-extension/logs/permission-review.jsonl` 中找到 4 条含 `$(basename ...)`/`$(dirname ...)` 的 `allow_once` 记录（用户手动放行历史），印证本 change 消除的正是这些噪音弹窗。

## 4. 文档与归档准备

- [x] 4.1 更新 `openspec/changes/bash-substitution-readonly-exemption/scenario-test-map.md`（11 scenario 全 🟢 + 1 条 audit-97 回归条目）。**验证**：所有状态从 🔴 更新为 🟢；无 N/A 条目。

- [x] 4.2 跑 `openspec validate bash-substitution-readonly-exemption --type change --json`。**验证**：`valid: true, issues: []`。

- [x] 4.3 跑 `code_review` 工具对 working-tree 改动做 read-only review。**验证**：见 6.3 change 级收尾 review。
