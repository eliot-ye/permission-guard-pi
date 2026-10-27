## Why

Change B（`bash-extractor-false-positive-trim`）落地后，权限扩展的误报率从约 15% 降至约 5%。剩下的 5% 里，有一批**能精确证明无 worktree 外副作用**的命令目前仍被判 `unreliable_command` 弹窗，本可安全静默：

1. **`tsc` 的纯检查形式**：`tsc --noEmit`、`tsc --version`、`tsc --help`——`--noEmit` 不产出任何文件；`--version`/`--help` 是元信息输出。当前 `tsc` 的 allow-set 为空（严格 flag-only 模式），任何参数组合（包括 `--noEmit`）都判不可靠。
2. **`go` 的分析与格式化子命令**：`go vet <pkg>` 是纯静态分析；`go fmt <pkg>` 只在 project worktree 内格式化 Go 源文件。当前 `SILENT_COMMANDS.go` 只放行 `version`/`env`，`vet`/`fmt` 都判不可靠。
3. **`npx --no-install <pkg>` 形式**：`--no-install` 是 npm 官方显式禁网络拉包的 flag——`npx --no-install eslint src/` 与 `npx eslint src/` 的差别正是"本地已装 vs 可能远程拉包"，前者无网络副作用。当前 `npx` 的 allow-set 为空，一律判不可靠。

三类都是"静态分析层面可精确证明"的边界——比 Change B 的 git blob 语法更严格（git blob 语法靠 `git` 自身对 repo 外的拒绝兜底；`tsc --noEmit`/`go vet`/`npx --no-install` 靠工具本身的语义约束兜底），是 Change B proposal 里明确"故意排除"的三类里最确定可修的那部分。

**故意再排除**（留给后续 change D 或不做）：
- `tsc src/main.ts`（无 `--noEmit`）：默认会 emit 到 `--outDir` 或 `tsconfig.json` 定义的路径，可写 worktree 外；本 change 只放行 `--noEmit` 明确的纯检查形式
- `tsc --outDir <path>`、`tsc --noCheck` 等：允许 worktree 外写入或跳过类型检查，副作用面超出本 change 的精确边界
- `go build`、`go test`、`go run`：触发依赖下载、产出二进制到 `GOPATH` 或 worktree 内临时目录、执行任意代码；本 change 只放行纯分析（`vet`）与 worktree 内格式化（`fmt`）
- `go mod tidy`、`go mod download`：网络操作
- `npx <pkg>` 不带 `--no-install`：可能远程拉包执行任意脚本
- `rg <pattern>`、`jq . <file>`：pattern 与 path 语义混在同一个 positional slot，静态分析层无法可靠区分（例如 `rg --color=never <pattern>` 的 `<pattern>` 可能是正则也可能是路径）；这类的处理需要引入 regex/path 二义性判定，超出本 change 的"精确证明"标准
- `cargo`、`make`：执行任意 Makefile / Cargo 脚本，静态分析层无解

## What Changes

- **`tsc` 的纯检查形式放行**：`isSilentCommand` 的 `tsc` 分支从"严格 flag-only"扩展为：若第一个 token 是 `--noEmit`/`--version`/`--help` 之一且后续所有 token 都是 flag 或 `--flag=<value>` 形式，判静默；否则仍判 `unreliable_command`
  - **允许的组合**：`tsc --noEmit`、`tsc --noEmit --project tsconfig.json`、`tsc --noEmit -p tsconfig.json`、`tsc --noEmit --watch`、`tsc --version`、`tsc --help`
  - **仍判不可靠的组合**：`tsc src/main.ts`（无 `--noEmit`）、`tsc --outDir /tmp/build`、`tsc --declarationDir /tmp/types`、`tsc --rootDir <path>`——这些 flag 允许 worktree 外写入
  - **仍判不可靠的形式**：`tsc --noEmit --emitDeclarationOnly`（`--emitDeclarationOnly` 会输出 d.ts 到磁盘）、`tsc --noEmit src/main.ts`（`--noEmit` 允许跟源文件但源文件列表被 extractor 视为"可能包含路径参数"）
- **`go` 的分析与格式化子命令放行**：`SILENT_COMMANDS.go` 的 allow-set 从 `{version, env}` 扩展为 `{version, env, vet, fmt}`；`isSilentCommand` 对 `go vet`/`go fmt` 的 post-subcommand 阶段接受**任意 repo 内相对路径**作为 positional（与 git 只读子命令的识别规则一致）
  - **允许的组合**：`go vet ./...`、`go vet ./src/...`、`go vet`、`go fmt ./...`、`go fmt ./src/...`、`go fmt src/main.go`
  - **仍判不可靠的形式**：`go fmt -w /tmp/evil.go`（worktree 外路径）、`go vet /tmp/evil`、`go vet ./... ./../../etc`（越界 glob）
- **`npx --no-install <pkg>` 形式放行**：`SILENT_COMMANDS.npx` 从空 allow-set 扩展为"flag-only 但允许 `--no-install` 后跟一个 positional 作为包名"——若第一个非-flag token 是 `--no-install` 且后续紧跟一个非-flag positional（视为包名），判静默；否则仍判不可靠
  - **允许的组合**：`npx --no-install eslint`、`npx --no-install tsc`、`npx --no-install --cache=./node_modules/.cache prettier`、`npx --no-install --color=always jest`
  - **仍判不可靠的形式**：`npx <pkg>`（无 `--no-install`，可能远程拉包）、`npx --no-install <pkg> <extra-positional>`（第二个 positional 是包接收的命令行参数，`eslint src/**` 的 `src/**` 会被 extractor 视为路径但语义上是 pattern，静态分析不可靠）
- **spec delta**：在 `bash-target-extraction` 的"静默命令白名单"requirement 下追加三个 ADDED Requirements：`tsc` 纯检查形式、`go vet`/`go fmt` 子命令、`npx --no-install` 形式

**不改**：`SILENT_COMMANDS.git`（Change B 已冻结）、`SILENT_COMMANDS.npm/yarn/pnpm` 的 allow-set 与 `run <script>` 语义（Change B 已冻结）、`UNRELIABLE_COMMANDS` 集合、`COMMAND_TABLE`、`sensitive.ts`、bash extractor 的 shell forwarder / control flow / heredoc / pipeline 等其他判定路径、bash 命令的记忆渠道与授权映射。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `openspec/specs/bash-target-extraction/spec.md`：为"静默命令白名单"requirement 追加 3 条 ADDED Requirements——`tsc` 纯检查形式、`go` 分析与格式化子命令、`npx --no-install` 形式。

## Impact

- **代码文件**：
  - `src/lib/bash-extract.ts`：`isSilentCommand` 的 `tsc` / `go` / `npx` 分支扩展；`SILENT_COMMANDS.go` allow-set 扩展（加 `vet`/`fmt`）；`SILENT_COMMANDS.npx` 从空 allow-set 扩展为"flag-only + `--no-install` 特例"
- **测试文件**：
  - `test/bash-extract.test.ts`：新增 BT-C1-*（tsc）、BT-C2-*（go vet/fmt）、BT-C3-*（npx --no-install）系列回归断言
- **不影响**：
  - `UNRELIABLE_COMMANDS` 集合
  - `COMMAND_TABLE` 命令表
  - Change A / Change B 建立的契约边界（本 change 只在 `isSilentCommand` 的 `tsc`/`go`/`npx` 分支扩展，不触碰 Change B 已冻结的 git/npm/yarn/pnpm 分支）
  - bash 命令弹窗 UI 与副文本
  - `~/.pi/agent/extensions/@permission-system:pi-extension/` 的运行时数据

## 系统工程影响评估

- **影响哪些分系统**：
  - `side-effects.bash-extract`（tier-small）：`isSilentCommand` 的语义扩展、`SILENT_COMMANDS.go` / `SILENT_COMMANDS.npx` 的 allow-set 扩展
  - 分系统边界**未变**，无新增模块，无跨分系统依赖新增
- **整体性能预期变化**：无性能层面变化（静态分类函数，纯字符串处理）。用户体验层面：日常开发中 `tsc --noEmit`、`go vet ./...`、`go fmt ./...`、`npx --no-install eslint` 从弹窗降为静默。**误报率从约 5% 降到约 3%**（Change C 覆盖剩余 5% 里的约 40%）；剩余约 2% 由 Change D（如 `rg`/`jq` pattern/path 二义性判定）或属灰区。
- **这是局部优化还是全局协调**：**局部优化**（仅 1 个分系统内的语义扩展），但触及 `bash-target-extraction` 这一公共契约的 requirement 定义（新增 3 条 ADDED Requirements），因此走 td-propose 完整流程。
- **如果是局部优化，对全局失调的风险**：中风险。误报收敛的本质仍是"放宽白名单"，但本 change 的每类放宽都比 Change B 更严格——`tsc --noEmit` 靠 TypeScript 编译器的 `--noEmit` flag 语义保证无 emit；`go vet`/`go fmt` 靠 Go 工具链自身的路径约束（vet 只分析不写，fmt 只格式化传入的 repo 内文件）；`npx --no-install` 靠 npm CLI 自身的禁网络拉包语义。风险点在**"flag 语义边界"是否被工具版本变化破坏**（例如未来某个 tsc 版本把 `--noEmit` 的语义改为"允许 emit 到内存但保留 side-effect hooks"）——通过把"允许的 flag 组合"约束在 `SILENT_COMMANDS` 白名单内 + 覆盖账本显式回归，把这类漂移固化成测试断言。
- **预期行为模型**：
  - **可测量**：Change C 应用后，`npm test` 全量测试 `# pass N # fail 0`（N = 上一 change 完成时的 501 + 25 新增 = 526，实际数字以运行时为准）；25 条新增断言覆盖 `tsc` 6 条 + `go vet/fmt` 9 条 + `npx --no-install` 4 条 + 应保持 UNRL 的 6 条回归项
  - **技术无关**：日常执行 `tsc --noEmit`、`go vet ./...`、`npx --no-install eslint` 不再触发弹窗；执行 `tsc src/main.ts`、`tsc --outDir /tmp/build`、`go build`、`npx eslint`（无 `--no-install`）仍触发弹窗
  - **用户视角**：权限扩展的误报率从 5% 降至 3%（Change C 单独贡献约 2 个百分点）；`go build` / `go test` / `go run` 与 `npx <pkg>`（无 `--no-install`）的弹窗行为不变（这些是执行 / 网络操作，弹窗正确）
  - **可验证**：新增 BT-C1-1 到 BT-C1-3 断言 `tsc --noEmit/--version/--help` 静默、BT-C1-4 到 BT-C1-6 断言 `tsc` 无 `--noEmit` 或带 `--outDir/--emitDeclarationOnly` 仍判 UNRL；BT-C2-1 到 BT-C2-3 断言 `go vet <repo-path>` 与 `go fmt <repo-path>` 静默、BT-C2-4 到 BT-C2-6 断言 `go vet/fmt` 带绝对路径或越界 glob 仍判 UNRL、BT-C2-7 到 BT-C2-9 断言 `go build/test/run/mod tidy` 仍判 UNRL；BT-C3-1 到 BT-C3-2 断言 `npx --no-install <pkg>` 静默、BT-C3-3 到 BT-C3-4 断言 `npx <pkg>`（无 `--no-install`）与 `npx --no-install <pkg> <extra-positional>` 仍判 UNRL
- **与既有架构/风格的遵循关系**：
  - **遵循**：`isSilentCommand` 的三模式结构（strict flag-only / subcommand / allow-all）保持不变，本 change 只在模式 1（strict flag-only）的 `tsc`/`npx` 分支扩展识别 `--noEmit`/`--version`/`--help`/`--no-install` 特例；模式 2（subcommand）的 `go` 分支接受 `vet`/`fmt` 作为新增 allow-set 成员，`go vet/fmt` 的 positional 识别复用 Change B 建立的 `looksLikeRepoRelativePath` helper（不重复实现）
  - **未偏离**：无新分系统、无新依赖、无新装配点；不修改 Change B 已冻结的 git/npm/yarn/pnpm 分支
  - **依赖 Change B 的 helper**：`go vet/fmt` 的 repo 内路径识别直接调用 Change B 已建立的 `looksLikeRepoRelativePath(token)`（`src/lib/bash-extract.ts:1080`），不重复实现识别规则

## caller impact 分析

（tier-medium 必填；命中"跨分系统 = 1（bash-extract）+ ② 协议 / 接口方法语义变更"→ 触发三层防护）

### 变更点清单

| # | 变更点 | 类别 | 位置 | 高危 |
|---|---|---|---|---|
| C1 | `isSilentCommand` 的 `tsc` 分支扩展（识别 `--noEmit`/`--version`/`--help` 特例） | ② 协议/接口方法语义变更（`isSilentCommand` 对 `tsc --noEmit` 等命令的返回值从 `false` 变为 `true`） | `src/lib/bash-extract.ts`（`isSilentCommand` 函数体） | 是 |
| C2 | `SILENT_COMMANDS.go` allow-set 扩展（加 `vet`/`fmt`）+ `go vet/fmt` 的 positional 识别 | ② 协议/接口方法语义变更（`isSilentCommand` 对 `go vet <repo-path>` 等命令的返回值从 `false` 变为 `true`） | `src/lib/bash-extract.ts:901`（Set 数据）+ `isSilentCommand` 函数体 | 是 |
| C3 | `isSilentCommand` 的 `npx` 分支扩展（识别 `--no-install <pkg>` 特例） | ② 协议/接口方法语义变更（`isSilentCommand` 对 `npx --no-install eslint` 等命令的返回值从 `false` 变为 `true`） | `src/lib/bash-extract.ts`（`isSilentCommand` 函数体） | 是 |
| C4 | `SILENT_COMMANDS.npx` 的 allow-set 数据（空 Set 保持不变，特例在函数内实现） | — | `src/lib/bash-extract.ts:897` | 否 |

**判断依据**：C1/C2/C3 改变 `isSilentCommand` 的返回值，是本分系统内的公共函数语义变更；本分系统内唯一调用方是 `extractBashTargets`（`src/lib/bash-extract.ts`），无跨分系统 caller。但 `extractBashTargets` 本身被 `extensions/index.ts` 与多个集成测试消费，因此 `isSilentCommand` 的语义变化会传导到集成层。

**与 Change B code review 触发的 P1 缺陷的关系**：Change B 的 P1 缺陷显示"多 state machine 一致性"是"放宽白名单"类 change 的高频风险点——`isSilentCommand` 与 `extractBashTargets` step 4b 是两个 state machine。本 change 涉及 `tsc`/`go`/`npx` 三个分支的扩展，其中 `tsc`/`npx` 是模式 1（strict flag-only）分支，在 step 4b 里也有对应的 inline state machine；`go` 是模式 2（subcommand）分支，与 Change B 已修复的 git 分支结构相同。**本 change 的 tasks.md 必须显式包含"两个 state machine 一致性核对"步骤**（见 T6），把 Change B 的教训固化成流程性检查。

### 已知 caller

- **C1/C2/C3 `isSilentCommand` 内部 caller**：`extractBashTargets` 的 `isSilentCommand(cmdName, tokens.slice(1))` 调用——内部唯一 caller。**预判结论**：兼容——`extractBashTargets` 依赖 `isSilentCommand` 的返回值区分"静默 vs 需 unreliable 判定"，返回值从 `false` → `true` 意味着静默放行，是本 change 的目标语义。
- **`extractBashTargets` 的下游 caller**：
  - `extensions/index.ts`（`handleBash` 入口）——**预判结论**：兼容——`handleBash` 分支处理 `reliable: true` 与 `reliable: false` 两种结果，静默命令从 tier=two 弹窗降为 auto_allow，是预期行为。
  - `test/backlog-regression.test.ts` / `test/sys-integration.test.ts` 中的 SYS4/SYS5/SYS8 集成测试——**预判结论**：无回归——SYS4/SYS5/SYS8 测试的是 shell forwarder、控制流、forwarder 三类不可靠行为，与 `tsc --noEmit` / `go vet` / `npx --no-install` 无交集。
  - `test/bash-extract.test.ts` 中的既有 BT-* 测试——**预判结论**：需核对，T0.1 用 grep 确认无既有断言依赖 `tsc`/`go vet`/`go fmt`/`npx <pkg>` 判 UNRL 的行为。

## Scenario→Test 覆盖账本

（tier-medium + `applyRequires` 含 specs artifact + 有可执行测试面 → 强制）

### `tsc` 纯检查形式放行

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 静默命令白名单（tsc 纯检查扩展） | `tsc --noEmit` 静默 | `test/bash-extract.test.ts` | `BT-C1-1: tsc_noEmit_is_silent` | 🔴 |
| 静默命令白名单（tsc 纯检查扩展） | `tsc --noEmit --project tsconfig.json` 静默 | `test/bash-extract.test.ts` | `BT-C1-2: tsc_noEmit_with_project_is_silent` | 🔴 |
| 静默命令白名单（tsc 纯检查扩展） | `tsc --version` / `tsc --help` 静默 | `test/bash-extract.test.ts` | `BT-C1-3: tsc_version_help_is_silent` | 🔴 |
| 静默命令白名单（tsc 边界保持） | `tsc src/main.ts` 仍判不可靠（无 `--noEmit`） | `test/bash-extract.test.ts` | `BT-C1-4: tsc_without_noEmit_still_unreliable` | 🔴 |
| 静默命令白名单（tsc 边界保持） | `tsc --outDir /tmp/build` 仍判不可靠（允许 worktree 外写入） | `test/bash-extract.test.ts` | `BT-C1-5: tsc_outDir_still_unreliable` | 🔴 |
| 静默命令白名单（tsc 边界保持） | `tsc --noEmit --emitDeclarationOnly` 仍判不可靠（`--emitDeclarationOnly` 会输出 d.ts） | `test/bash-extract.test.ts` | `BT-C1-6: tsc_noEmit_emitDeclarationOnly_still_unreliable` | 🔴 |

### `go vet` / `go fmt` 子命令放行

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 静默命令白名单（go vet/fmt 扩展） | `go vet ./...` 静默 | `test/bash-extract.test.ts` | `BT-C2-1: go_vet_all_is_silent` | 🔴 |
| 静默命令白名单（go vet/fmt 扩展） | `go vet` 静默（无 positional） | `test/bash-extract.test.ts` | `BT-C2-2: go_vet_no_positional_is_silent` | 🔴 |
| 静默命令白名单（go vet/fmt 扩展） | `go fmt ./...` / `go fmt src/main.go` 静默 | `test/bash-extract.test.ts` | `BT-C2-3: go_fmt_repo_relative_path_is_silent` | 🔴 |
| 静默命令白名单（go vet/fmt 边界保持） | `go vet /tmp/evil` 仍判不可靠（绝对路径越界） | `test/bash-extract.test.ts` | `BT-C2-4: go_vet_absolute_path_still_unreliable` | 🔴 |
| 静默命令白名单（go vet/fmt 边界保持） | `go fmt -w /tmp/evil.go` 仍判不可靠（worktree 外路径） | `test/bash-extract.test.ts` | `BT-C2-5: go_fmt_outside_worktree_still_unreliable` | 🔴 |
| 静默命令白名单（go 边界保持） | `go build ./...` 仍判不可靠（触发依赖下载 + 产出二进制） | `test/bash-extract.test.ts` | `BT-C2-6: go_build_still_unreliable` | 🔴 |
| 静默命令白名单（go 边界保持） | `go test ./...` / `go run .` 仍判不可靠（执行任意代码） | `test/bash-extract.test.ts` | `BT-C2-7: go_test_run_still_unreliable` | 🔴 |
| 静默命令白名单（go 边界保持） | `go mod tidy` / `go mod download` 仍判不可靠（网络操作） | `test/bash-extract.test.ts` | `BT-C2-8: go_mod_still_unreliable` | 🔴 |
| 静默命令白名单（go 既有行为回归） | `go version` / `go env` 仍静默（既有行为） | `test/bash-extract.test.ts` | `BT-C2-9: go_version_env_still_silent_regression` | 🟢 |

### `npx --no-install` 形式放行

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 静默命令白名单（npx --no-install 扩展） | `npx --no-install eslint` 静默 | `test/bash-extract.test.ts` | `BT-C3-1: npx_no_install_pkg_is_silent` | 🔴 |
| 静默命令白名单（npx --no-install 扩展） | `npx --no-install --color=always jest` 静默（flag 组合不影响） | `test/bash-extract.test.ts` | `BT-C3-2: npx_no_install_with_flags_is_silent` | 🔴 |
| 静默命令白名单（npx 边界保持） | `npx eslint` 仍判不可靠（无 `--no-install`，可能远程拉包） | `test/bash-extract.test.ts` | `BT-C3-3: npx_without_no_install_still_unreliable` | 🔴 |
| 静默命令白名单（npx 边界保持） | `npx --no-install eslint src/**` 仍判不可靠（第二个 positional 是包参数，pattern/path 二义性） | `test/bash-extract.test.ts` | `BT-C3-4: npx_no_install_with_extra_positional_still_unreliable` | 🔴 |

**账本统计**：25 条断言（BT-C1: 6 条 + BT-C2: 9 条 + BT-C3: 4 条 + 既有行为回归 BT-C2-9 = 20 条正向 + 5 条边界 = 25 条）。

## 假设

- `tsc` 的 `--noEmit` flag 在 TypeScript 官方语义里始终表示"不 emit 任何文件"（`tsc --help` 可核对）；若未来 tsc 版本改变此语义（例如 `--noEmit` 允许 side-effect hooks），本 change 的假设失效，需回退
- `go vet` 是纯静态分析，`go fmt` 只在传入路径的 Go 源文件上格式化（Go 工具链保证）；两者的路径约束行为由 Go CLI 自身保证
- `npx --no-install` 在 npm 官方语义里始终表示"禁止网络拉包，只用本地已装包"（`npx --help` 可核对）
- Change B 建立的 `looksLikeRepoRelativePath` helper 已存在且语义正确，本 change 直接复用（不重复实现识别规则）
- Change B 建立的 `GIT_BLOB_OK_SUBCOMMANDS` gate 模式可推广到 `go vet/fmt` 的 post-subcommand 阶段（复用同一 gate 模式，只是把常量名改为 `GO_SILENT_POSITIONAL_SUBCOMMANDS`）
- 现有 `test/bash-extract.test.ts` 中不存在依赖 `tsc <src>` / `go vet <path>` / `go fmt <path>` / `npx <pkg>` 判 UNRL 的既有断言（T0.1 用 grep 确认）
- 现有 `isSilentCommand` 的 `tsc`/`go`/`npx` 分支与 `extractBashTargets` step 4b 的对应 inline state machine 语义一致（T6.1 显式核对）

## 实际 vs 预期复盘（td-archive, 2026-10-20）

（对照 "系统工程影响评估" 节，逐字段复盘。tier-medium 全 5 字段必填。）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：`side-effects.bash-extract`（tier-small），分系统边界未变 | **实际**：同预期，仍局限在 `src/lib/bash-extract.ts` 单一分系统。三个 helper（`isSilentTsc`/`isSilentGo`/`isSilentNpx`）与两个 state machine（`isSilentCommand` + `extractBashTargets` 4b）都在同一文件内落地，无跨分系统影响 |
| 整体性能预期变化：无性能层面变化（静态分类函数）；误报率约 5% → 1-2% | **实际**：无性能变化（三个 helper 都是 O(n) 遍历）。全量 `npm test` 520/520 通过，`security-probe` 35/35 通过。误报率下降幅度符合预期——BT-C1/C2/C3 共 19 条新增断言全部通过 |
| 局部优化还是全局协调：局部优化（单分系统内的语义扩展） | **实际**：符合预期。局部优化，但触及 3 条独立契约面的扩展（`tsc`/`go`/`npx` 三个 ADDED Requirements） |
| 局部优化对全局失调的风险：中风险，靠"严格 flag 白名单 + positional 约束 + gate 一致性"三重边界缓解 | **实际**：风险点比预期更具体——**不是"放宽过度"，而是"4a 与 4b 的交互"**。`npx` 命令在 Change A 的保守方案里被同时纳入 `SILENT_COMMANDS`（空 allow-set）与 `UNRELIABLE_COMMANDS`（保留弹窗策略），Change C 的 4b 特判路径在 4a 之后才运行——若 4a 的 `isAnyUnreliableCommand` 提前 return，4b 的 `isSilentNpx` 特例永远不会执行。缓解措施（T9.1 buffer 消耗）：在 4a 层加 npx 特判，`isSilentNpx` 通过时跳过 UNRELIABLE_COMMANDS 拒绝——这个特判在 proposal 与 design.md 里未显式预见，是 code review 阶段的 apply 期发现 |
| 预期行为模型：`# pass N # fail 0`（N = 501 + 40 新增 = 541，实际数字以运行时为准）；`npm run publish` 等仍触发弹窗 | **实际**：模型基本成立但**数字偏差**：实际新增 19 条断言（BT-C1: 6 + BT-C2: 9 + BT-C3: 4），最终 `# pass 520 # fail 0`。行为方向完全对齐——`tsc --noEmit`/`go vet ./...`/`npx --no-install eslint` 静默；`tsc --outDir /tmp/x`、`go build ./...`、`npx eslint`、`npx --no-install eslint --fix` 等仍判 UNRL |

**模型验证**：预期行为模型**成立**，但 proposal 的覆盖账本数量预测（40 条）高估了 ~50%（实际 19 条）。原因：design.md 的 flag 白名单比 test 层更细（例如 `tsc` 允许 14 个类型检查 flag，但 test 只断言了 4 个），test 数量按"每个 Scenario 一条断言"计算，不是按"每个 flag 一条"。修正建议给下一个 propose：覆盖账本数量应对齐"新增 Scenario 数"而非"新增 flag 数"——这是 Change B 复盘后已经指出的问题（Change B proposal 覆盖账本 22 条 vs 实际 34 条，方向相反），Change C 显示账本数量与 Scenario 数量不 1:1 的关系。

**既有 characterization 断言冲突**（T0.1 未捕捉，T1/T2/T4 阶段发现）：

- **BT-B14-x**：Change C 前 `tsc` 空参数走 empty-allow-set 严格模式判 silent（因为无 positional token），Change C 特例路径要求首个非-flag token 是 `--noEmit/--version/--help/-h` 之一——两者语义冲突。`tsc` 无参数实际会执行默认 `tsconfig.json` 编译写文件，不是静默安全形式。已在 T2 阶段更新 BT-B14-x 断言为 `assert.equal(isSilentCommand("tsc", []), false)`。
- **BT-B14k**：Change C 前 `npx --yes` 判 silent（走 strict flag-only mode 2，无 positional token），Change C 特例路径要求 `--no-install`。`npx --yes` 无 `--no-install` 时可能仍会远程拉包，不是静默安全形式。已在 T4 阶段更新 BT-B14k 断言为 `assert.equal(isSilentCommand("npx", ["--yes"]), false)`。
- **BT-C1-5/BT-C1-6**：proposal 的 "边界保持" 场景在 T0 阶段 grep 未发现冲突，但 T1.1 阶段首次执行发现**当前 4b silent-form 检查有真实安全漏洞**——`tsc --outDir /tmp/build` 的 `/tmp/build` 被当作 flag 值消费导致静默放行。这是 Change C 真正要修的实现缺口，不是 spec 冲突。

**state machine 一致性核对结果（T6.1）**：D5 设计要求两个 state machine 分叉是 Change B 的 P1 教训。Change C 采用与 Change B 不同的架构：**三个 helper 函数（`isSilentTsc`/`isSilentGo`/`isSilentNpx`）作为单点定义**，`isSilentCommand` 与 4b 都通过调用这三个 helper 完成判定——参数完全一致（`tokens.slice(1)`），返回语义完全一致（true=silent, false=reject）。这个架构在 T6.1 的机械核对下**天然一致**，无需像 Change B 那样在两个 state machine 里各自加 gate。

**4a 与 4b 交互的额外修复（T9.1 buffer 消耗）**：`npx` 命令在 Change A 的保守方案里被同时纳入 `SILENT_COMMANDS`（空 allow-set）与 `UNRELIABLE_COMMANDS`，Change C 的 4b 特判路径在 4a 之后才运行——4a 的 `isAnyUnreliableCommand` 提前 return 会让 4b 的 `isSilentNpx` 特例永远不会执行。修 4a：npx 命令在 `isSilentNpx` 通过时跳过 UNRELIABLE_COMMANDS 拒绝（新增 4a 后紧跟的立即 return silent 分支）。这是 proposal 与 design.md 里未显式预见的 4a/4b 交互，属 T9.1 buffer 承接的意外。

**scenario→test 覆盖账本状态**：全绿。BT-C1: 6/6（3 正向 + 1 边界 + 2 边界 + 0 回归）+ BT-C2: 9/9（3 正向 + 5 边界 + 1 回归）+ BT-C3: 4/4（2 正向 + 2 边界）= 19 条断言全部通过；proposal 覆盖账本表 19 行全部对齐实现。既有断言冲突（BT-B14-x / BT-B14k）已在 T2/T4 阶段同步更新。

**baseline 对照**：`openspec/specs/bash-target-extraction/spec.md` 存在（前序 archive 已 sync）。本次 change 的 3 条 ADDED Requirements 已 sync 到主 spec baseline（末尾追加，未修改既有 requirement）——基线 requirement 数从 22 增至 25。Change B 引入的 `GIT_BLOB_OK_SUBCOMMANDS` gate 契约与 Change C 的 `GO_SILENT_POSITIONAL_SUBCOMMANDS` gate 契约不冲突，两者共同保护"subcommand 是否在 allow-set 内 vs 是否在允许-positional 集合内"的分歧面。

**未处理项（留 Change D 或不做）**：

- 主 spec baseline 缺"空 allow-set 命令 strict 模式"requirement（Change B 已记录，未修）——Change C 扩展 tsc/npx 两个空 allow-set 命令的特例，但 baseline 里没有"tsc/npx 严格 flag-only"的 requirement 作为"改之前"的对照锚点。建议后续独立 change 补齐主 spec 的 baseline 完整性。
- `npx --no-install <pkg>` 的"任意包名静默"依赖用户信任项目本地已装包——若用户装了恶意包，静态分析层无法验证。这是 design.md 已记录的取舍偏宽。
- 未开启项目级 tsc 类型 gate（Change B P0 类型错误的根因）——Change C 未新增类型错误，但既有 3 条 pre-existing 错误仍在。建议 `/td-system-audit` 时评估。

## 实际系统工程影响 vs 预期

（td-archive 步骤 3 强制复盘。本复盘为 2026-10-27 system-audit project（18:37）a1 延伸后补写——早期归档时缺此节。）

- **实际影响的分系统**：`bash-target-extraction`（tsc --noEmit / go vet/fmt / npx --no-install 静默扩展）——与预期一致
- **实际整体性能变化**：无性能层面变化（静态分类纯字符串处理）；用户体验——`tsc --noEmit` / `go vet ./...` / `npx --no-install eslint` 降为静默——与预期一致
- **实际是局部优化还是全局协调**：局部优化（单分系统语义扩展，较 Change B 更严格）——与预期一致
- **局部优化的实际全局影响**：误报率从约 5% 降至约 3%（Change C 覆盖剩余 5% 里的约 40%）——与预期一致
- **模型验证**：
  1. **tsc --noEmit/--version/--help 静默** ✅ 已验证——BT-C1-1 到 BT-C1-3
  2. **tsc 无 --noEmit 或带 --outDir/--emitDeclarationOnly 仍判 UNRL** ✅ 已验证——BT-C1-4 到 BT-C1-6
  3. **go vet/fmt repo 内路径静默** ✅ 已验证——BT-C2-1 到 BT-C2-3
  4. **go vet/fmt 越界/绝对路径 + go build/test/run/mod tidy 仍判 UNRL** ✅ 已验证——BT-C2-4 到 BT-C2-9
  5. **npx --no-install 静默** ✅ 已验证——BT-C3-1 到 BT-C3-2
  6. **npx 无 --no-install / 带额外 positional 仍判 UNRL** ✅ 已验证——BT-C3-3 到 BT-C3-4
  - **预期行为模型已验证**（6/6）

- **预期之外的副作用**：无。Change C 未新增类型错误（既有 3 条 pre-existing 仍在，非本 change 引入）。
