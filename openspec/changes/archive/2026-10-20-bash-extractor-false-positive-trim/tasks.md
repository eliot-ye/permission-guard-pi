# Tasks

## 关键链与 project buffer

**关键链（Critical Chain）**：T0 (前置 grep 检查) → T1 (TDD 测试先行) → T2 (git blob 语法实现) → T3 (npm/yarn/pnpm run 实现) → T7 (全量回归)。

**关键链理由**：Change B 是**语义放宽**类改动，最脆弱的环节是"放宽过度导致本应 UNRL 的命令被静默放行"。T1+T2+T3 定义了本 change 的行为边界，T7 验证边界无回归。T0 是 brownfield 变体规则要求的前置 grep 检查（既有断言是否有语义冲突），前置性极强——不做就可能在 T1 阶段才发现冲突、返工 T1。

**Project buffer**：tier-medium 下按 strength-matrix 表 1 取 35%。本 change 关键链总估时约 90 min（T0: 5 min、T1: 30 min 写 23 条测试、T2: 25 min 实现 git 分支、T3: 15 min 实现 npm 分支、T4-T6 并行 15 min、T7: 5 min 回归），buffer 35% ≈ 30 min——留在 T8（缓冲收尾）承接意外（例如 blob 语法识别规则在边界 revision 表达式上误判、多 positional 混用场景未预期到的组合）。

**Feed buffer**：T4/T5/T6 汇入 T7，各自动作量小于 10 min，无需独立 feed buffer。

**主体合规**：所有 task 主体都是 agent 可执行的编程性动作（写文件 / 跑命令 / grep 断言 / 断言通过）。人工验证（如"用户日常开发时不再被弹窗打扰"）不做独立 task，降级为 T7 验证字段的补充说明，附等价机械项（`npm test` 全绿 + `test/security-probe.mjs` 35/35）。

---

## 0. 前置 grep 检查（brownfield characterization 前置）

 - [x] T0.1 grep 既有测试断言，确认 BT-BLOB-* / BT-RUN-* 新增断言与既有断言无语义冲突
  - 命令：
    ```
    grep -c "git blame" test/bash-extract.test.ts
    grep -c "git diff.*src/" test/bash-extract.test.ts
    grep -c "git log HEAD:" test/bash-extract.test.ts
    grep -c "npm run\|yarn run\|pnpm run" test/bash-extract.test.ts
    ```
  - 文件：`test/bash-extract.test.ts`（只读）
  - 风险：low（只读检查）
  - 验证：4 条 grep 全部返回 `0`；若非 0，先阅读命中上下文，判断是否与 BT-BLOB-* / BT-RUN-* 命名有重叠，必要时调整新增测试命名（命名冲突不阻塞 T1，但需在本 task 报告中标出）
  - 分系统影响：无（前置检查）
  - 依赖：无

## 1. TDD 测试先行（RED）

 - [x] T1.1 在 `test/bash-extract.test.ts` 中新增 BT-BLOB-1 到 BT-BLOB-18 共 18 条断言，跑 `npm test -- test/bash-extract.test.ts` 确认新增 BT-BLOB-1、2、3、4、5、6、7、8、17、18 共 10 条 🔴 失败（BT-BLOB-9、10、11、12、13、14、15、16 是既有行为回归项，应当通过）
  - 文件：`test/bash-extract.test.ts`
  - 风险：medium（新测试面，需保证与既有 BT-B* 断言命名不冲突）
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出恰为 BT-BLOB-1、2、3、4、5、6、7、8、17、18 共 10 行；BT-BLOB-9、10、11、12、13、14、15、16 均 `✔` 通过
  - 分系统影响：side-effects.bash-extract（tier-small）—— 仅测试面
  - 依赖：T0.1

 - [x] T1.2 在 `test/bash-extract.test.ts` 中新增 BT-RUN-1 到 BT-RUN-9 共 9 条断言，跑 `npm test -- test/bash-extract.test.ts` 确认新增 BT-RUN-1、2、3、4、5、6、7、8 共 8 条 🔴 失败（BT-RUN-9 是 `npm test` 直接形式的既有行为回归项，应当通过）
  - 文件：`test/bash-extract.test.ts`
  - 风险：low
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出包含 BT-RUN-1、2、3、4、5、6、7、8 共 8 行；BT-RUN-9 为 `✔`
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T1.1

## 2. Git blob 语法与 repo 内相对路径静默放行（GREEN）

 - [x] T2.1 在 `src/lib/bash-extract.ts` 中新增两个模块内辅助函数 `looksLikeGitBlobToken(token: string): boolean` 与 `looksLikeRepoRelativePath(token: string): boolean`（放在 `isSilentCommand` 定义之前），实现 D2 中的识别规则
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low（新函数，纯字符串判定）
  - 验证：两个函数是 `export const` 或 `function`（不 export，保持模块内私有），grep 确认存在；`npm test -- test/bash-extract.test.ts 2>&1 | tail -3` 既有测试仍全绿（新增函数无副作用）
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T1.1、T1.2

 - [x] T2.2 修改 `src/lib/bash-extract.ts` 的 `isSilentCommand` Mode 3 分支：对 `git` 增加"post-subcommand 阶段允许 blob 语法与 repo 内相对路径"的识别逻辑——若 subcommand ∈ `{status, log, diff, show, blame, rev-parse, rev-list, shortlog}` 且后续所有非-flag positional 都通过 `looksLikeGitBlobToken` 或 `looksLikeRepoRelativePath`，返回 `true`
  - 文件：`src/lib/bash-extract.ts`（`isSilentCommand` 函数体，第 957-1006 行区间）
  - 风险：high（核心分类函数的语义扩展，触及公共契约）
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-BLOB"` 输出恰为 18；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出不含 BT-BLOB-* 行（所有 BT-BLOB-* 断言通过）
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T2.1

## 3. npm/yarn/pnpm `run <script>` 静默放行（GREEN）

 - [x] T3.1 修改 `src/lib/bash-extract.ts` 的 `isSilentCommand` Mode 3 分支：对 `npm`、`yarn`、`pnpm` 增加"`run <script>` 形式识别"——若第一个 token 是 `"run"` 且第二个 token ∈ `{test, lint, audit}` 且无第三个 token（无 `--`、无 positional 追加），返回 `true`
  - 文件：`src/lib/bash-extract.ts`
  - 风险：medium（语义扩展，但边界清晰）
  - 验证：`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✔" | grep -c "BT-RUN"` 输出恰为 9；`npm test -- test/bash-extract.test.ts 2>&1 | grep -E "^✖"` 输出不含 BT-RUN-* 行
  - 分系统影响：side-effects.bash-extract（tier-small）
  - 依赖：T2.2

## 4. 集成层验证

 - [x] T4.1 跑 `npm test -- test/backlog-regression.test.ts test/sys-integration.test.ts 2>&1` 确认 SYS4/SYS5/SYS8 集成测试全部通过（这些测试覆盖 shell forwarder / control flow / forwarder 三类不可靠行为，与 git blob / npm run 无交集，验证无回归）
  - 文件：无（验证动作）
  - 风险：medium（跨分系统回归验证）
  - 验证：`npm test -- test/backlog-regression.test.ts test/sys-integration.test.ts 2>&1 | tail -3` 输出 `# fail 0`
  - 分系统影响：extension-orchestration、side-effects
  - 依赖：T3.1

## 5. 安全探针回归

 - [x] T5.1 跑 `node --experimental-strip-types test/security-probe.mjs 2>&1` 确认 35 条安全探针全部通过（本 change 未引入宽松化，探针应完全不受影响）
  - 文件：无（验证动作）
  - 风险：low
  - 验证：`node --experimental-strip-types test/security-probe.mjs 2>&1 | tail -3` 输出 `35 passed, 0 failed out of 35`
  - 分系统影响：无
  - 依赖：T3.1

## 6. 场景账本覆盖度核对

 - [x] T6.1 核对 proposal 的 scenario→test 覆盖账本 23 条断言与 T1/T2/T3 实际新增的测试数量一致（23 = BT-BLOB 18 条 + BT-RUN 5 条 = BT-BLOB 18 + BT-RUN 5）——重读 proposal 覆盖账本并统计实际账本行数，与新增断言数对齐
  - 文件：`openspec/changes/bash-extractor-false-positive-trim/proposal.md`、`test/bash-extract.test.ts`
  - 风险：low
  - 验证：`grep -c "^|.*BT-BLOB\|^|.*BT-RUN" openspec/changes/bash-extractor-false-positive-trim/proposal.md` 与 `grep -c "test(\"BT-BLOB\|test(\"BT-RUN" test/bash-extract.test.ts` 两者数字一致（应为 27，即 18 + 9）
  - 分系统影响：无
  - 依赖：T3.1

## 7. 全量回归

 - [x] T7.1 跑 `npm test` 全量测试，确认 `# pass N # fail 0`（N = 上一 change 完成时的 463 + 27 新增 - 0 删除 = 490，实际数字以运行时为准），无 flaky
  - 文件：无（验证动作）
  - 风险：medium（跨分系统全量回归）
  - 验证：`npm test 2>&1 | tail -5` 输出 `# pass N # fail 0`，N ≥ 490 且 # fail = 0；`npm test 2>&1 | grep -c "^✖"` 输出 `0`
  - 分系统影响：全部子系统
  - 依赖：T4.1、T5.1、T6.1

## 8. 契约与规格完整性

 - [x] T8.1 跑 `openspec validate bash-extractor-false-positive-trim --type change --json` 确认无 structural 问题；跑 `openspec status --change bash-extractor-false-positive-trim --json` 确认所有 applyRequires artifact 状态为 `done`
  - 文件：无（验证动作）
  - 风险：low
  - 验证：`openspec validate bash-extractor-false-positive-trim --type change --json` 输出中 `issues` 数组为空；`openspec status --change bash-extractor-false-positive-trim --json` 输出中每个 artifact `status === "done"`
  - 分系统影响：无
  - 依赖：T1-T6 全部完成

## 9. 缓冲收尾（project buffer 35%）

 - [x] T9.1 缓冲任务：若 T1-T8 中任一 task 出现非预期失败（例如 blob 语法识别规则在罕见 revision 表达式上误判、多 positional 混用场景未预期到、集成测试因分类扩展产生非预期回归），此 task 承接修复；预计耗时 30 min 上限
  - 文件：`src/lib/bash-extract.ts`、`test/bash-extract.test.ts`、`openspec/changes/bash-extractor-false-positive-trim/specs/bash-target-extraction/spec.md`
  - 风险：medium（实际消耗 buffer 承接 code review 触发的修复）
  - **buffer 消耗记录**（2026-10-20 code review）：
    - **P0**：`extractBashTargets` step 4b 内 `let sawSub = false` 与后续 `sawSub = "__run_form__"` / `"__run_form_scripted__"` 字符串赋值存在类型错误（`string` 不可赋给 `boolean`）。项目用 `node --experimental-strip-types` 跑测试不做类型检查所以 494/494 通过掩盖了这个错误；`tsc --strict` 下会硬失败。修复：将 `sawSub` 声明为 `boolean | "__run_form__" | "__run_form_scripted__"` union。
    - **P1（安全）**：`extractBashTargets` step 4b 的 git permissive 分支（旧 line 2630）未 gate 到 `GIT_BLOB_OK_SUBCOMMANDS`，而 `isSilentCommand`（line 1140）有 gate——两个 state machine 分叉。后果：`git config user.name Alice`、`git branch foo`、`git tag v1.2.3`、`git ls-files src`、`git remote origin` 这类子命令在 `SILENT_COMMANDS.git` 内但不在 `GIT_BLOB_OK_SUBCOMMANDS` 内，positional 会通过 `looksLikeRepoRelativePath` 被判为 "repo 内相对路径"，导致 silent-form 返回 `reliable: true` 0-target，绕过弹窗静默写入。修复：引入 `seenGitSub: string | null` 变量记录接受的 subcommand，在 4b permissive 分支加 `cmdName === "git" && seenGitSub !== null && GIT_BLOB_OK_SUBCOMMANDS.has(seenGitSub)` gate，与 `isSilentCommand` 保持一致。
    - **回归测试补充**：新增 BT-BLOB-19..25 共 7 条断言覆盖 P1 分歧面（`git config/branch/tag/ls-files/remote` 带 positional 均判 UNRL；`git branch` / `git ls-files` 无 positional 保持 silent）。scenario→test 覆盖账本由 27 条扩到 34 条。
    - **spec delta 补充**：修正 `specs/bash-target-extraction/spec.md` 中"未在 allow-set 内的 git subcommand"约束——原文错误声称 `branch/tag/remote/config/ls-files` 不在 allow-set 中；实际它们在 `SILENT_COMMANDS.git` 内但不在 `GIT_BLOB_OK_SUBCOMMANDS` 内。补齐两类 subcommand 的差异化行为说明（silent-form 4b 必须拒绝对这些子命令的 positional）。
    - 附带修正：spec.md 里 `git log /etc/passwd` 场景标题错别字（`不可可靠` → `不可靠`）。
  - 验证：`npm test` 全量 501/501 通过；`node node_modules/typescript/bin/tsc --noEmit --strict --target es2022 --module es2022 src/lib/bash-extract.ts` 报出的 3 条既有错误（line 2193 `string | undefined` 不匹配 `string`）经 stash 对比确认是 pre-existing，不在本 change scope
  - 分系统影响：side-effects.bash-extract（tier-small）——4b 分支的 gate 修复
  - 依赖：T1-T8 全部完成 + code review
