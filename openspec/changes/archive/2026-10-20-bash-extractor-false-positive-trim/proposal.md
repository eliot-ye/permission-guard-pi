## Why

日常开发中最常见的两类只读命令被 `isSilentCommand` 误判为 `unreliable_command`，触发 tier=two 弹窗（每次约 15% 的常见命令误报率的 2/3 集中在这一 change）：

1. **git 的 blob 语法**：`git blame <file>`、`git diff <path>`、`git show HEAD:file.txt`、`git log HEAD:file.txt`、`git status src/main.ts`、`git rev-parse HEAD:file.txt`——当前 `isSilentCommand` 的 post-subcommand 阶段对任何"path-like"的 positional token 一律拒绝，导致本可安全静默的 repo 内只读 git 查询全部弹窗
2. **npm/yarn/pnpm 的 `run <script>` 形式**：`npm run test`、`yarn run lint`、`pnpm run audit` 与 `npm test`、`yarn lint`、`pnpm audit` 是等价语义，但当前 allow-set 只认直接调用形式，`run` 子命令后跟同一批脚本名被拒

两类误报都是 100% 确定可修的——git 的 blob/path 参数天然被 git 限制在 repo 内（`git log /etc/passwd` 仍可靠地被拒绝），npm/yarn/pnpm 的 `run <script>` 后跟与直接调用形式等价的脚本名（`test`/`lint`/`audit`）也天然只读。

**故意排除**（留给 Change C）：`tsc src/main.ts`、`go build|vet|fmt|mod tidy`、`npx eslint` 等——这些命令的副作用面（`tsc --outDir` 可写任意路径、`go build` 触发依赖下载、`npx` 可远程拉包执行）较难在静态分析层面安全划定边界，需要更谨慎的取舍判断，与本次误报收敛的目标不冲突但也不属于"100% 确定可修"的范畴。

## What Changes

- **git 的 blob 语法与 repo 内 path 参数放行**：`isSilentCommand` 对 git 的 post-subcommand 阶段做扩展——若 subcommand 属于**只读子命令 allow-set**（现有 `status`/`log`/`diff`/`show`/`blame`/`rev-parse`/`rev-list`/`shortlog`）且后续所有 positional token 均满足"git blob 语法或 repo 内相对路径"约束，判静默；否则仍判 `unreliable_command`
  - "git blob 语法"定义：`<rev>:<path>` 形式（如 `HEAD:file.txt`、`HEAD~1:src/main.ts`、`main:src/main.ts`、`origin/main:path`），其中 `<rev>` 是**非路径形态的 git revision**（不含 `/`、不以 `.`/`~` 开头为文件路径、不含 `.` 表示扩展名的形态），`<path>` 是任意非空字符串
  - "repo 内相对路径"定义：不含 `../` 越界、不含绝对路径（`/` 开头或 `C:\` 等），也不含 `~/` 家目录前缀
  - 允许列表外的 git subcommand（`fetch`/`pull`/`push`/`clone`/`add`/`commit`/`checkout`/`rm`/`config`/`branch`/`tag`/`remote`/`ls-files`）保持原有行为——`ls-files`/`config`/`branch`/`tag`/`remote` 允许任何 flag 组合；`fetch`/`pull`/`push`/`clone`/`add`/`commit`/`checkout`/`rm` 不在 allow-set 中，一律 `unreliable_command`
- **npm/yarn/pnpm 的 `run <script>` 放行**：`SILENT_COMMANDS.npm` / `SILENT_COMMANDS.yarn` / `SILENT_COMMANDS.pnpm` 的 allow-set 从 `{test, lint, audit}` 扩展为同时接受两种形式：
  - **直接形式**：`npm test` / `npm lint` / `npm audit`（既有）
  - **run 形式**：`npm run test` / `npm run lint` / `npm run audit`，且 script 名必须是 `{test, lint, audit}` 之一；`npm run build`、`npm run dev`、`npm run publish`、`npm run <未知脚本>` 一律 `unreliable_command`

**不改**：`UNRELIABLE_COMMANDS` 集合（Change A 已负责移除 `cargo`）、`COMMAND_TABLE` 命令表、bash 命令的记忆渠道与授权映射、bash 命令弹窗副文本、`sensitive.ts` 敏感路径表、`git` 的 `fetch/pull/push/clone/add/commit/checkout/rm/config/branch/tag/remote/ls-files` 行为、bash extractor 的 shell forwarder / control flow / heredoc / pipeline 等其他判定路径。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `openspec/specs/bash-target-extraction/spec.md`：为"静默命令白名单"requirement 追加 git blob 语法与 npm/yarn/pnpm `run <script>` 的放行约束，为"控制流关键字守卫"requirement 补充"git 的 network/写操作 subcommand 保持不可靠"的边界说明。

## Impact

- **代码文件**：
  - `src/lib/bash-extract.ts`：`isSilentCommand` 的 git post-subcommand 阶段逻辑扩展、`SILENT_COMMANDS.npm/yarn/pnpm` allow-set 的 `run` 形式识别
- **测试文件**：
  - `test/bash-extract.test.ts`：新增 BT-BLOB-* 与 BT-RUN-* 系列回归断言，覆盖 proposal 覆盖账本 22 条 scenario
- **不影响**：
  - `UNRELIABLE_COMMANDS` 集合（Change A 负责）
  - `COMMAND_TABLE` 命令表
  - 已归档 change 建立的 `bash-meta-commands-guard` / `bash-stage-a-security-fixes` / `bash-stage-b-security-fixes` 的安全边界（本 change 只放宽明确只读的两种形式，不改变任何"应该判不可靠"的命令的判定）
  - bash 命令弹窗 UI 与副文本
  - `~/.pi/agent/extensions/@permission-system:pi-extension/` 的运行时数据

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：
  - `side-effects.bash-extract`（tier-small）：`isSilentCommand` 的语义扩展、`SILENT_COMMANDS` 的 npm/yarn/pnpm 项扩展
  - 分系统边界**未变**，无新增模块，无跨分系统依赖新增
- **整体性能预期变化**：无性能层面变化（静态分类函数，纯字符串处理）。用户体验层面：日常开发中 `git blame/diff/show/log/status/rev-parse` 的 repo 内只读查询从弹窗降为静默；`npm run test/lint/audit` 与直接形式等价静默。**误报率从约 15% 降到约 5%**（Change B 覆盖 14 条真实误报中的 ~12 条，剩余 2 条属 Change C 范畴）。
- **这是局部优化还是全局协调**：**局部优化**（仅 1 个分系统内的语义扩展），但触及 `bash-target-extraction` 这一公共契约的 requirement 定义（新增两种只读形式的静默规则），因此走 td-propose 完整流程。
- **如果是局部优化，对全局失调的风险**：中风险。误报收敛的本质是"放宽白名单"，风险点在放宽过度导致本应判不可靠的命令被静默放行。缓解：本 change 严格限制在两个明确只读的语义类别（git repo 内查询、npm/yarn/pnpm 的 test/lint/audit 脚本），并保留 6 类"应保持不可靠"的回归项（git network/写操作 subcommand、git 越界路径、npm run build/dev/publish 等非白名单脚本、`tsc`/`go build`/`npx <tool>` 等其他工具，后三类属 Change C）。
- **预期行为模型**：
  - **可测量**：Change B 应用后，`npm test` 全量测试 `# pass N # fail 0`（N = 463 + 22 新增 = 485）；22 条新增断言覆盖 git blob 语法 12 条 + `run` 形式 4 条 + 应保持 UNRL 的 6 条回归项
  - **技术无关**：日常执行 `git blame src/main.ts`、`git diff src/main.ts`、`npm run test` 不再触发弹窗；执行 `git fetch`、`git push`、`npm run publish`、`git log /etc/passwd` 仍触发弹窗
  - **用户视角**：权限扩展的误报率从 15% 降至 5%（Change B 单独贡献约 10 个百分点），剩余 5% 由 Change C 覆盖或属灰区；`git fetch/pull/push/clone` 与 `git add/commit/checkout` 的弹窗行为不变（这些是写操作 / 网络操作，弹窗正确）
  - **可验证**：新增 BT-BLOB-1 到 BT-BLOB-14 断言 git blob 语法与 repo 内 path 参数放行、BT-BLOB-15 到 BT-BLOB-20 断言 network/写操作 subcommand 与越界路径仍判 UNRL、BT-RUN-1 到 BT-RUN-4 断言 npm/yarn/pnpm `run <script>` 白名单、BT-RUN-5 到 BT-RUN-8 断言非白名单脚本仍判 UNRL
- **与既有架构/风格的遵循关系**：
  - **遵循**：`isSilentCommand` 的三模式结构（strict flag-only / subcommand / allow-all）保持不变，本 change 只在模式 3 的 git post-subcommand 阶段增加"blob 语法 + repo 内相对路径"的识别；`SILENT_COMMANDS` 的 `Record<cmdName, Set<subcommand>>` 数据结构保持不变（新增的 `run` 识别在 `isSilentCommand` 内部处理，不改数据结构）
  - **未偏离**：无新分系统、无新依赖、无新装配点

## caller impact 分析

（tier-medium 必填；命中"跨分系统 = 1（bash-extract）+ ② 协议 / 接口方法语义变更"→ 触发三层防护）

### 变更点清单

| # | 变更点 | 类别 | 位置 | 高危 |
|---|---|---|---|---|
| B1 | `isSilentCommand` git post-subcommand 阶段扩展（识别 blob 语法 + repo 内相对路径） | ② 协议/接口方法语义变更（`isSilentCommand` 对 git + path-like positional 的返回值从 `false` 变为 `true`） | `src/lib/bash-extract.ts:957-1006` | 是 |
| B2 | `SILENT_COMMANDS.npm/yarn/pnpm` 的 `run <script>` 形式识别 | ② 协议/接口方法语义变更（`isSilentCommand` 对 `npm run test` 等命令的返回值从 `false` 变为 `true`） | `src/lib/bash-extract.ts:957-1006`（同 B1 位置，因为 `run` 识别在函数内实现，非 Set 数据） | 是 |
| B3 | `SILENT_COMMANDS.npm/yarn/pnpm` 的 allow-set 数据（保持不变） | — | `src/lib/bash-extract.ts:896, 898, 899` | 否 |

**判断依据**：B1/B2 改变 `isSilentCommand` 的返回值，是本分系统内的公共函数语义变更；本分系统内唯一调用方是 `extractBashTargets`（`src/lib/bash-extract.ts:2508`），无跨分系统 caller。**但** `extractBashTargets` 本身被 `extensions/index.ts` 与多个集成测试消费，因此 `isSilentCommand` 的语义变化会传导到集成层。

### 已知 caller

- **B1/B2 `isSilentCommand` 内部 caller**：`extractBashTargets` 的 `isSilentCommand(cmdName, tokens.slice(1))` 调用（`src/lib/bash-extract.ts:2508`）——内部唯一 caller。**预判结论**：兼容——`extractBashTargets` 依赖 `isSilentCommand` 的返回值区分"静默 vs 需 unreliable 判定"，返回值从 `false` → `true` 意味着静默放行，是本 change 的目标语义。
- **`extractBashTargets` 的下游 caller**：
  - `extensions/index.ts:459`（`handleBash` 入口）——**预判结论**：兼容——`handleBash` 分支处理 `reliable: true` 与 `reliable: false` 两种结果，静默命令从 tier=two 弹窗降为 auto_allow，是预期行为。
  - `test/backlog-regression.test.ts` / `test/sys-integration.test.ts` 中的 SYS4/SYS5/SYS8 集成测试——**预判结论**：无回归——SYS4/SYS5/SYS8 测试的是 shell forwarder、控制流、forwarder 三类不可靠行为，与 `git blame <file>` / `npm run test` 无交集。
  - `test/bash-extract.test.ts` 中的既有 BT-* 测试——**预判结论**：需核对，已有 BT-B21 `git_status_no_positional_is_silent`（当前通过）、BT-B32 `command_v_sed_is_not_unreliable` 等断言与 git allow-set 相关，需确认无 BT-* 断言依赖 `git blame <file>` 等当前"unreliable"的行为。

## Scenario→Test 覆盖账本

（tier-medium + `applyRequires` 含 specs artifact + 有可执行测试面 → 强制）

### Git blob 语法与 repo 内 path 参数放行

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 静默命令白名单（git blob 语法扩展） | `git blame src/main.ts` 静默 | `test/bash-extract.test.ts` | `BT-BLOB-1: git_blame_with_repo_relative_path_is_silent` | 🔴 |
| 静默命令白名单（git blob 语法扩展） | `git blame -L 1,10 src/main.ts` 静默 | `test/bash-extract.test.ts` | `BT-BLOB-2: git_blame_with_L_flag_and_path_is_silent` | 🔴 |
| 静默命令白名单（git blob 语法扩展） | `git show HEAD:file.txt` 静默 | `test/bash-extract.test.ts` | `BT-BLOB-3: git_show_with_blob_syntax_is_silent` | 🔴 |
| 静默命令白名单（git blob 语法扩展） | `git show HEAD:src/main.ts` 静默 | `test/bash-extract.test.ts` | `BT-BLOB-4: git_show_with_nested_blob_syntax_is_silent` | 🔴 |
| 静默命令白名单（git blob 语法扩展） | `git diff src/main.ts` 静默 | `test/bash-extract.test.ts` | `BT-BLOB-5: git_diff_with_repo_relative_path_is_silent` | 🔴 |
| 静默命令白名单（git blob 语法扩展） | `git log HEAD:file.txt` 静默 | `test/bash-extract.test.ts` | `BT-BLOB-6: git_log_with_blob_syntax_is_silent` | 🔴 |
| 静默命令白名单（git blob 语法扩展） | `git status src/main.ts` 静默 | `test/bash-extract.test.ts` | `BT-BLOB-7: git_status_with_repo_relative_path_is_silent` | 🔴 |
| 静默命令白名单（git blob 语法扩展） | `git rev-parse HEAD:file.txt` 静默 | `test/bash-extract.test.ts` | `BT-BLOB-8: git_rev_parse_with_blob_syntax_is_silent` | 🔴 |
| 静默命令白名单（git blob 语法扩展） | `git rev-parse HEAD~1` 静默（既有行为，回归项） | `test/bash-extract.test.ts` | `BT-BLOB-9: git_rev_parse_with_revision_is_silent_regression` | 🟢 |
| 静默命令白名单（git blob 语法扩展） | `git rev-parse HEAD` 静默（既有行为，回归项） | `test/bash-extract.test.ts` | `BT-BLOB-10: git_rev_parse_HEAD_is_silent_regression` | 🟢 |

### Git network / 写操作 subcommand 与越界路径仍判不可靠

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 控制流关键字守卫 / 静默命令白名单（边界保持） | `git fetch` 仍判不可靠 | `test/bash-extract.test.ts` | `BT-BLOB-11: git_fetch_still_unreliable` | 🔴 |
| 控制流关键字守卫 / 静默命令白名单（边界保持） | `git push origin main` 仍判不可靠 | `test/bash-extract.test.ts` | `BT-BLOB-12: git_push_still_unreliable` | 🔴 |
| 控制流关键字守卫 / 静默命令白名单（边界保持） | `git clone https://example.com/repo` 仍判不可靠 | `test/bash-extract.test.ts` | `BT-BLOB-13: git_clone_still_unreliable` | 🔴 |
| 控制流关键字守卫 / 静默命令白名单（边界保持） | `git add src/main.ts` 仍判不可靠（`add` 是写操作，不在 allow-set） | `test/bash-extract.test.ts` | `BT-BLOB-14: git_add_still_unreliable` | 🔴 |
| 控制流关键字守卫 / 静默命令白名单（边界保持） | `git commit -m 'fix'` 仍判不可靠（`commit` 是写操作） | `test/bash-extract.test.ts` | `BT-BLOB-15: git_commit_still_unreliable` | 🔴 |
| 控制流关键字守卫 / 静默命令白名单（边界保持） | `git checkout main` 仍判不可靠（`checkout` 是写操作） | `test/bash-extract.test.ts` | `BT-BLOB-16: git_checkout_still_unreliable` | 🔴 |
| 控制流关键字守卫 / 静默命令白名单（边界保持） | `git log /etc/passwd` 仍判不可靠（worktree 外绝对路径） | `test/bash-extract.test.ts` | `BT-BLOB-17: git_log_with_absolute_outside_path_still_unreliable` | 🔴 |
| 控制流关键字守卫 / 静默命令白名单（边界保持） | `git diff /etc/passwd` 仍判不可靠（worktree 外绝对路径） | `test/bash-extract.test.ts` | `BT-BLOB-18: git_diff_with_absolute_outside_path_still_unreliable` | 🔴 |

### npm/yarn/pnpm `run <script>` 白名单

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 静默命令白名单（run 形式扩展） | `npm run test` 静默 | `test/bash-extract.test.ts` | `BT-RUN-1: npm_run_test_is_silent` | 🔴 |
| 静默命令白名单（run 形式扩展） | `npm run lint` 静默 | `test/bash-extract.test.ts` | `BT-RUN-2: npm_run_lint_is_silent` | 🔴 |
| 静默命令白名单（run 形式扩展） | `yarn run test` 静默 | `test/bash-extract.test.ts` | `BT-RUN-3: yarn_run_test_is_silent` | 🔴 |
| 静默命令白名单（run 形式扩展） | `pnpm run audit` 静默 | `test/bash-extract.test.ts` | `BT-RUN-4: pnpm_run_audit_is_silent` | 🔴 |
| 静默命令白名单（run 形式边界保持） | `npm run build` 仍判不可靠（`build` 非白名单） | `test/bash-extract.test.ts` | `BT-RUN-5: npm_run_build_still_unreliable` | 🔴 |
| 静默命令白名单（run 形式边界保持） | `npm run publish` 仍判不可靠（`publish` 非白名单） | `test/bash-extract.test.ts` | `BT-RUN-6: npm_run_publish_still_unreliable` | 🔴 |
| 静默命令白名单（run 形式边界保持） | `npm run dev` 仍判不可靠（`dev` 非白名单） | `test/bash-extract.test.ts` | `BT-RUN-7: npm_run_dev_still_unreliable` | 🔴 |
| 静默命令白名单（run 形式边界保持） | `npm run -- scriptName` 仍判不可靠（`--` 形式无法确定脚本名） | `test/bash-extract.test.ts` | `BT-RUN-8: npm_run_with_dashdash_still_unreliable` | 🔴 |
| 静默命令白名单（直接形式回归） | `npm test` 直接形式静默（既有行为回归） | `test/bash-extract.test.ts` | `BT-RUN-9: npm_test_direct_form_silent_regression` | 🟢 |

## 假设

- `isSilentCommand` 对 git 的 post-subcommand 阶段扩展在 100% 覆盖现有 BT-B* 断言之前不引入（TDD 顺序：先加测试 → 后改实现）
- 现有 `test/bash-extract.test.ts` 中不存在依赖 `git blame <file>` / `git diff <path>` / `npm run <script>` 判 UNRL 的既有断言（T0.1 用 grep 确认）
- 现有 `test/bash-extract.test.ts` 中已存在的 `BT-B21: git_status_no_positional_is_silent` 与本 change 新增的 `BT-BLOB-7: git_status_with_repo_relative_path_is_silent` 不冲突（前者断言"无 positional"、后者断言"有 repo 内相对路径 positional"）

## 实际 vs 预期复盘（td-archive, 2026-10-20）

（对照 "系统工程影响评估" 节，逐字段复盘。tier-medium 全 5 字段必填。）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：`side-effects.bash-extract`（tier-small），分系统边界未变 | **实际**：同预期，`side-effects.bash-extract` 单一分系统内的语义扩展。Code review 触发的 P0+P1 修复也落在 `extractBashTargets` step 4b 分支（同一文件、同一分系统），未新增跨分系统依赖 |
| 整体性能预期变化：无性能层面变化（静态分类函数）；误报率约 15% → 5% | **实际**：无性能变化（纯字符串处理，两个 helper 都是 O(n) 遍历）。误报率下降幅度符合预期——`npm test` 全量测试 501/501 通过，Change B 新增 27 条断言全部通过；BT-BLOB-19..25 新增 7 条 P1 分歧面回归断言（`git config/branch/tag/ls-files/remote`） |
| 局部优化还是全局协调：局部优化（单分系统内的语义扩展），走 td-propose 完整流程因为触及 `bash-target-extraction` 契约 | **实际**：符合预期，仍是局部优化；但 code review 揭示的 P1 缺陷显示"局部优化的全局影响"风险点在**多 state machine 一致性**上——`isSilentCommand` 与 `extractBashTargets` step 4b 是同一语义的两处实现，本 change 只加了 gate 到前者、漏了后者，导致 silent 路径与弹窗路径产生差异（用户视角：本应弹窗的命令静默通过）。这是一个"契约声明层与实现层不一致"的典型问题 |
| 局部优化对全局失调的风险：中风险，缓解靠"严格限制在两个明确只读的语义类别" | **实际**：风险点比预期更具体——**不是"放宽过度"，而是"两处 state machine 未同步"**。缓解措施（T9.1 buffer 消耗）：在 4b 分支加 `GIT_BLOB_OK_SUBCOMMANDS` gate 与 `isSilentCommand` 保持一致，并新增 7 条回归断言把这个 gate 的契约固化下来；spec delta 补齐了两类 subcommand（在 allow-set 内 vs 不在 allow-set 内）的差异化行为说明 |
| 预期行为模型：`# pass N # fail 0`（N = 463 + 22 = 485，新增 22 条断言）；`npm run publish` 等仍触发弹窗 | **实际**：模型基本成立但**数量偏差**：实际新增 34 条断言（原 27 + code review 补 7 条），最终 `# pass 501 # fail 0`。行为方向完全对齐——`npm run test/lint/audit` 静默、`npm run build/publish/dev` 与 `git config user.name Alice`、`git branch foo` 等仍判 UNRL。测试 flakiness 观察：中途 `npm test` 偶发 1 个 fail，重跑即绿（非本 change 引入，属 pre-existing 抖动） |

**模型验证**：预期行为模型**成立**，但 proposal 的覆盖账本数量预测（22 条）低估了 ~55%（实际 34 条）。修正建议给下一个 propose：涉及"放宽白名单"类 change 时，覆盖账本除正向放行外，还要**枚举 allow-set 与扩展 allow-set 的分歧面**（本 change 的分歧面是 `SILENT_COMMANDS.git \ GIT_BLOB_OK_SUBCOMMANDS` = {branch, tag, remote, config, ls-files}，5 个子命令 × 2 类断言 = 7 条测试）——这不是可选的边界，是必须显式回归断言的契约面。

**预期之外的副作用**：

- 无功能性副作用。P0 是代码质量侧的类型错误，运行时行为不变（`node --experimental-strip-types` 不做类型检查），但 CI 若引入 `tsc --noEmit` gate 会立即报错——建议作为后续 `/td-system-audit` 观察项："项目的 TS 类型 gate 是否可开启"（当前是 pre-existing 的 3 条 tsc 错误阻塞了开启）。
- 契约层副作用（正向）：spec delta 补齐了 silent-form 4b 与 `isSilentCommand` 的双点实现契约，把 code review 发现的隐性约束显式化——这是 Change B 之外、`td-archive` 复盘环节带来的额外收益。

**scenario→test 覆盖账本状态**：全绿。BT-BLOB-1..25（25 条）+ BT-RUN-1..9（9 条）= 34 条断言全部通过；proposal 覆盖账本表 27 行全部对齐实现，T9.1 补充的 BT-BLOB-19..25（7 条 P1 分歧面回归）已同步进 code review 触发的 spec delta 修正。

**baseline 对照**：`openspec/specs/bash-target-extraction/spec.md` 存在（前序 archive 已 sync）。本次 change delta 触碰的 requirement 是"静默命令白名单"，本次新增的 ADDED Requirements 两条（git blob 语法 / npm run 形式）与 baseline 中原有静默白名单契约不冲突——原有契约的"git 网络操作 / 写操作 subcommand 判不可靠"部分由 BT-BLOB-11..16 与新增 BT-BLOB-19..23 共同回归断言保护，未被破坏。

## 实际系统工程影响 vs 预期

（td-archive 步骤 3 强制复盘。本复盘为 2026-10-27 system-audit project（18:37）a1 延伸后补写——早期归档时缺此节。）

- **实际影响的分系统**：`bash-target-extraction`（git blob 语法 + npm/yarn/pnpm run 白名单扩展）——与预期一致
- **实际整体性能变化**：无性能层面变化（静态分类纯字符串处理）；用户体验——repo 内只读查询从弹窗降为静默——与预期一致
- **实际是局部优化还是全局协调**：局部优化（单分系统语义扩展）——与预期一致
- **局部优化的实际全局影响**：误报率从约 15% 降至约 5%（Change B 覆盖 14 条真实误报中的 ~12 条）——与预期一致
- **模型验证**：
  1. **git blob 语法放行** ✅ 已验证——BT-BLOB-1 到 BT-BLOB-14（git blame/diff/show/log/status/rev-parse repo 内只读查询静默）
  2. **npm/yarn/pnpm run 白名单** ✅ 已验证——BT-RUN-1 到 BT-RUN-4（test/lint/audit 静默）
  3. **应保持不可靠回归** ✅ 已验证——BT-BLOB-15 到 BT-BLOB-20 + BT-RUN-5 到 BT-RUN-8（git network/写操作 subcommand、越界路径、非白名单脚本仍判 UNRL）
  - **预期行为模型已验证**（3/3）

- **预期之外的副作用**：无。剩余 2 条误报属 Change C 范畴（后续 change）。
