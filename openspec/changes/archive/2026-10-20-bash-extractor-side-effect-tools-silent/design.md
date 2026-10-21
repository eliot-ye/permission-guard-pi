## Context

`isSilentCommand` 是 `bash-extract.ts` 内部分类命令是否 0-target 静默的核心判定函数（`src/lib/bash-extract.ts`），采用三模式结构（Change B 之后保持）：

- **Mode 1**：命令不在 `SILENT_COMMANDS` → 返回 `false`
- **Mode 2**：空 allow-set + 非 `SILENT_ALLOW_ALL`（tsc/make/rg/jq/npx）→ 严格 flag-only，任何 positional token 返回 `false`
- **Mode 3**：非空 allow-set 或 `SILENT_ALLOW_ALL`（git/npm/yarn/pnpm/cargo/go/openspec）→ 识别 subcommand，post-subcommand 阶段允许通过 Change B 建立的 gate 规则

Change B 后遗留的三类误报都集中在**空 allow-set** 或 **allow-set 不完整**的分支上：

1. `tsc` 在 Mode 2 分支，空 allow-set + 严格 flag-only，即使 `--noEmit` 也被判 UNRL
2. `go` 在 Mode 3 分支，allow-set 只有 `{version, env}`，`vet`/`fmt` 都不认
3. `npx` 在 Mode 2 分支，空 allow-set，即使 `--no-install` 也判 UNRL

现有约束：

- **公共契约变更**：本 change 触及 `bash-target-extraction` spec，追加三条 ADDED requirement——属 human-in-loop 基线第 1 类，本 proposal 已获用户确认（用户明确说"推进 Change C"）
- **TDD 边界**（profile-brownfield 变体规则）：新增行为强制 TDD；`isSilentCommand` 的老代码在改造前先加 characterization test（BT-C1-* / BT-C2-* / BT-C3-* 断言）
- **Change B 的教训固化**：Change B 的 code review 触发了 P1 缺陷——`isSilentCommand` 与 `extractBashTargets` step 4b 是同一语义的两个 state machine，Change B 只在 `isSilentCommand` 加了 `GIT_BLOB_OK_SUBCOMMANDS` gate、漏了 4b 分支，导致 `git config user.name Alice` 静默写入 `.git/config`。**本 change 的每个扩展点必须在两个 state machine 里同时落地**——`tasks.md` 显式包含一致性核对步骤
- **代码分层契约**：`src/lib/bash-extract.ts` 是纯函数库（无 IO），本 change 只改纯函数

## Goals / Non-Goals

**Goals:**

- 让 `tsc --noEmit`（及其合法 flag 组合 `--project`/`-p`/`--watch`/`--incremental`/`--pretty`/`--pretty false` 等）静默通过
- 让 `tsc --version` / `tsc --help` 静默通过
- 让 `go vet` 与 `go fmt` 静默通过，允许 repo 内相对路径作为 positional
- 让 `npx --no-install <pkg>` 静默通过
- 保持 `tsc src/main.ts`（无 `--noEmit`）/ `tsc --outDir <path>` / `tsc --emitDeclarationOnly` / `tsc --noEmit --emitDeclarationOnly` 的不可靠判定
- 保持 `go build` / `go test` / `go run` / `go mod tidy` / `go mod download` 的不可靠判定
- 保持 `npx <pkg>`（无 `--no-install`）/ `npx --no-install <pkg> <extra-positional>` 的不可靠判定

**Non-Goals:**

- **不放宽** `tsc` 的其他形式（`--outDir`/`--declarationDir`/`--rootDir`/`--emitDeclarationOnly`/无 `--noEmit` 的 `tsc <src>`）——这些允许 worktree 外写入或跳过类型检查，副作用面超出本 change 的精确边界
- **不放宽** `go build` / `go test` / `go run` / `go mod`——这些是执行/网络操作，弹窗正确
- **不放宽** `npx <pkg>`（无 `--no-install`）——`npx` 可能远程拉包执行任意脚本
- **不处理** `rg <pattern>` / `jq . <file>` 的 pattern/path 二义性判定——需要引入 regex/path 二义性识别规则，超出本 change 的"精确证明"标准（留给 Change D 或不做）
- **不处理** `cargo` / `make` 的白名单扩展——执行任意 Makefile / Cargo 脚本，静态分析层无解
- **不修改** `SILENT_COMMANDS.git` 的 allow-set 数据（Change B 已冻结）
- **不修改** `SILENT_COMMANDS.npm/yarn/pnpm` 的 allow-set 数据与 `run <script>` 语义（Change B 已冻结）
- **不改** `UNRELIABLE_COMMANDS` 集合、`COMMAND_TABLE`、`sensitive.ts`、bash extractor 的 shell forwarder / control flow / heredoc / pipeline 等其他判定路径
- **不改** 既有测试，只追加 BT-C1-* / BT-C2-* / BT-C3-* 断言

## Decisions

### D1: `isSilentCommand` 内部实现方式

**决策**：分三个独立分支扩展，每个分支只改一处：

- **`tsc` 分支（Mode 2 strict flag-only 扩展）**：在 Mode 2 内，若命令是 `tsc` 且首个非-flag token 是 `--noEmit`/`--version`/`--help` 之一，进入"tsc 特例路径"——后续 token 必须全部满足 `isSafeTscFlag(t)` 判定，才返回 `true`
- **`go` 分支（Mode 3 subcommand allow-set 扩展）**：把 `SILENT_COMMANDS.go` 的 allow-set 从 `{version, env}` 扩展为 `{version, env, vet, fmt}`；在 Mode 3 post-subcommand 阶段，若 subcommand ∈ `{vet, fmt}`，positional token 必须满足 `looksLikeRepoRelativePath`（Change B 已建立的 helper），否则返回 `false`
- **`npx` 分支（Mode 2 strict flag-only 扩展）**：在 Mode 2 内，若命令是 `npx` 且 tokens 中出现 `--no-install` 特例，进入"npx 特例路径"——`--no-install` 前后允许任意 flag，`--no-install` 之后只能有一个非-flag positional 作为包名，无更多 positional

**理由**：

- **三个分支独立演进**：`tsc` 与 `npx` 是 Mode 2 特例，`go` 是 Mode 3 扩展——三类扩展点互不干扰，独立测试、独立 review
- **复用 Change B 的 helper**：`go vet`/`go fmt` 的 repo 内路径识别直接调用 Change B 已建立的 `looksLikeRepoRelativePath`（`src/lib/bash-extract.ts:1080`），不重复实现识别规则
- **不改 `SILENT_COMMANDS` 数据结构**：`tsc`/`npx` 的特例在 `isSilentCommand` 内部处理，与 Change B 的 `npm run <script>` 形式处理一致
- **每个扩展点都在两个 state machine 同步落地**：`isSilentCommand` + `extractBashTargets` step 4b——T6.1 显式核对一致性

**替代方案**：

- ❌ 新增 Mode 4（"safe-tool-only"）：函数从"三种判定路径"变成"四种"，破坏现有可读性；Mode 4 与 Mode 2 的关系是包含（Mode 2 的 tsc/npx 分支被扩展），不是并列
- ❌ 引入 `SAFE_TOOL_FLAGS` 全局配置（`Record<cmdName, Set<flag>>`）：把 `tsc --noEmit`/`npx --no-install` 编码进数据，会让"允许的 flag 组合"与"命令的语义分类"分离——但本 change 的判定是"首个非-flag token 决定路径"（`tsc --noEmit --project` 与 `tsc --project --noEmit` 语义等价但 token 顺序影响状态机实现），数据编码无法表达
- ❌ 为每个特例新增独立的 `SILENT_COMMANDS.tsc.noEmit` 子配置：需要引入第二层嵌套（当前是扁平 `Record<cmdName, Set<subcommand>>`），改动面过大

### D2: `tsc` 特例的"允许 flag 白名单"

**决策**：`tsc` 特例路径接受以下 flag 组合：

- **允许的 flag**（安全，无 worktree 外副作用）：
  - `--noEmit`（决定路径的核心 flag，必须存在）
  - `--version`、`--help`、`-h`（元信息，路径入口本身）
  - `--project` / `-p`（TSConfig 路径参数，`tsc --noEmit -p tsconfig.json`）
  - `--watch` / `-w`（开发模式，纯检查）
  - `--incremental`、`--pretty`、`--pretty true`、`--pretty false`、`--pretty <bool>`（输出格式）
  - `--target`、`--module`、`--moduleResolution`、`--strict`、`--skipLibCheck`、`--esModuleInterop`、`--resolveJsonModule`、`--noImplicitAny`、`--noImplicitReturns`、`--strictNullChecks`、`--strictFunctionTypes`、`--noUncheckedIndexedAccess`、`--useDefineForClassFields`、`--forceConsistentCasingInFileNames`、`--jsx`（类型检查选项，纯检查语义）
  - 值形式：`--flag <value>` 与 `--flag=<value>` 都接受（后续值必须是非-flag token）
- **一律拒绝的 flag**（允许 worktree 外写入或改变 emit 语义）：
  - `--outDir`、`--declarationDir`、`--rootDir`、`--declaration`、`--declarationMap`、`--sourceMap`、`--outFile`
  - `--emitDeclarationOnly`、`--emitDecoratorMetadata`、`--isolatedDeclarations`
  - `--noCheck`（跳过类型检查，可能生成错误的类型错误报告）
  - `--build` / `-b`（触发 TypeScript Project References 构建，产出到多个 outDir）

**理由**：

- **保守判定**：宁可多判 UNRL（弹窗）也不要漏放行可疑命令。`--noEmit` 是 TypeScript CLI 显式禁 emit 的官方 flag，是唯一能"静态证明无 emit"的入口
- **拒绝 `--emitDeclarationOnly` 即使 `--noEmit` 存在**：TypeScript 的 `--emitDeclarationOnly` 与 `--noEmit` 组合的行为是"仍 emit 声明文件到磁盘"（`--noEmit` 的语义是"禁 emit JS"，不禁 emit d.ts）——这是 tsc CLI 的既有行为，需要显式排除
- **拒绝 `--noCheck`**：跳过类型检查可能隐藏真实错误，即使 `--noEmit` 组合使用也无法通过静态分析证明"这是安全的类型检查"

**允许 flag 的形式**：

- `--flag` 无值（如 `--strict`）
- `--flag <value>` 分隔（如 `--target es2022`）—— `<value>` 必须是**非 flag** token（不以 `-` 开头且不是纯数字之外的字符串，避免 `--target -1` 这类误判）
- `--flag=<value>` 等号形式（如 `--target=es2022`）

**实现细节**：值 token 的判定复用 Change B 建立的 `t.includes("=")` 与 `!t.startsWith("-")` 判定模式（见 `isSilentCommand` 现有的 flag 处理逻辑）。

**替代方案**：

- ❌ 只允许 `--noEmit` 一个 flag：会让 `tsc --noEmit -p tsconfig.json` 这类极常见的调用判 UNRL，用户体验极差
- ❌ 允许所有 tsc flag 只要 `--noEmit` 存在：会放行 `--noEmit --outDir /tmp/build` 这类非法组合（`--outDir` 与 `--noEmit` 语义冲突，但 tsc CLI 实际行为是 `--outDir` 生效——需要显式拒绝）
- ❌ 读取 tsconfig.json 判定实际 emit 目标：引入 IO 依赖到纯函数库层，违反代码分层契约

### D3: `go vet` / `go fmt` 的 positional 识别规则

**决策**：`go vet`/`go fmt` 的 post-subcommand 阶段接受**任意 repo 内相对路径**作为 positional token，复用 Change B 建立的 `looksLikeRepoRelativePath` helper：

- **允许的 positional**：
  - `./...`（当前目录的 Go 包）
  - `./src/...`（子目录递归）
  - `./src`（子目录）
  - `src/main.go`（具体 Go 文件）
  - `src/.../sub`（含省略号的路径）
  - 空（`go vet` 无 positional）
- **拒绝的 positional**（`looksLikeRepoRelativePath` 返回 `false`）：
  - `/tmp/evil.go`（绝对路径）
  - `~/evil.go`（家目录前缀）
  - `../../etc`（越界）
  - `C:\Users\...`（Windows 盘符）

**允许的 flag**：

- `go vet`：`-copylocks`、`-printf`、`-shadow`、`-structtag`、`-atomic`、`-bool`、`-buildtag`、`-httpmux`、`-loopclosure`、`-nilfunc`、`-printf`、`-slog`、`-stdmethods`、`-tests`、`-unsafeptr`、`-unusedresult`、`-unusedwrite`、`-all`、`-h`、`-help`——都是纯分析控制 flag，无副作用
- `go fmt`：`-l`（列出修改的文件）、`-w`（写入原文件，**worktree 内**才安全）、`-r <pattern>`（重构模式）、`-s`（额外简化）——`-w` 是关键：它触发写入，但只在传入路径的 Go 源文件上，若传入路径是 repo 内则安全

**拒绝的形式**：

- `go vet <pkg> --flag`：flag 出现在 positional 之后（Go CLI 语义上是 `<pkg>` 接收 `--flag`，静态分析不可靠）
- `go fmt -w /tmp/evil.go`：`-w` 允许写入，`/tmp/evil.go` 是绝对路径

**替代方案**：

- ❌ 拒绝 `go fmt -w`：`-w` 是 `go fmt` 的核心用途（`go fmt` 无 `-w` 时是 dry-run，只输出到 stdout），拒绝会让 `go fmt -w ./...` 判 UNRL——这是极常见的日常调用
- ❌ 允许任意路径作为 positional：会让 `go vet /etc/passwd` 静默通过（`looksLikeRepoRelativePath` 会拒绝绝对路径）

### D4: `npx --no-install` 的形式识别

**决策**：`npx` 特例路径接受以下形式：

- **允许的 tokens 序列**：
  - 任意数量的 flag（包括 `--no-install`、`--cache=<path>`、`--color=<mode>`、`--yes`、`-y`、`--loglevel=<level>`、`--silent`、`--quiet` 等 npm/npx 通用 flag）
  - `--no-install` 必须出现（这是特例路径的入口判定）
  - `--no-install` 之后**恰好一个**非-flag positional token 作为包名（如 `eslint`、`tsc`、`prettier`、`jest`）
- **拒绝的形式**：
  - `npx <pkg>`（无 `--no-install`）
  - `npx --no-install <pkg> <extra-positional>`（第二个 positional 是包接收的命令行参数，如 `npx --no-install eslint src/**`——`src/**` 会被 extractor 视为路径但语义上是 pattern）
  - `npx --no-install`（无包名）
  - `npx --no-install --pkg=<name>`（`--pkg` 形式与 positional 语义不同，静态分析不可靠）

**允许的 flag 白名单**：

- 通用 flag（`--cache=<path>`、`--color=<mode>`、`--yes`/`-y`、`--loglevel=<level>`、`--silent`、`--quiet`、`--no-fund`、`--no-timing`、`--no-update-notifier`、`--offline`、`--prefer-offline`）
- `--no-install` 本身（路径入口）
- 拒绝 `--prefix=<path>`（改变工作目录，与 Change B 的 `npm --cwd` 边界一致）
- 拒绝 `--package=<pkg>`（`--package` 与 positional 的 `<pkg>` 语义不同，且 `--package` 允许多值）
- 拒绝 `--call=<cmd>`、`-c <cmd>`（`npx -c <cmd>` 是 `npm exec -c <cmd>`，执行任意脚本）

**理由**：

- **`--no-install` 是 npm CLI 显式禁网络拉包的官方 flag**，静态可证明"只用本地已装包"
- **只允许一个 positional 作为包名**：包接收的命令行参数（如 `eslint src/**` 的 `src/**`）语义上不是路径，静态分析不可靠
- **拒绝 `--prefix`**：与 Change B 的 `npm --cwd` 边界保持一致——改变工作目录会绕开 project worktree 约束
- **拒绝 `--package=<pkg>` 形式**：`--package` 允许多值（`--package=a --package=b`），且语义上等价于 positional 但表达力更强，静态分析不可靠

**替代方案**：

- ❌ 允许 `npx --no-install <pkg> --<flag>`（flag 在包名之后）：仍可能传入包的命令行参数——`npx --no-install eslint --fix src/**` 的 `--fix` 是 eslint 的写入 flag，静态判定不成立
- ❌ 允许 `npx --no-install <pkg> <extra-positional>` 只要 `<extra-positional>` 是 flag：`npx --no-install eslint -- src/**` 的 `--` 之后的一切都被视为包的参数，静态判定不成立
- ❌ 白名单 `<pkg>` 名称（`{eslint, tsc, prettier, jest}`）：项目内的包名可以是任意 npm 包，无法静态列举

### D5: 两个 state machine 的一致性核对

**决策**：本 change 的三个扩展点（`tsc`/`go`/`npx`）都必须同时在两个 state machine 里落地：

- **`isSilentCommand`**：函数级判定，返回 `true`/`false`
- **`extractBashTargets` step 4b**：silent-form 内联 state machine，直接返回 `{ reliable, rawCommand, reason }`

**核对方式**：tasks.md 的 T6.1 显式核对——

1. 对每个扩展点，列出 `isSilentCommand` 里新加的所有分支，确认 `extractBashTargets` step 4b 里有对应的分支
2. 对每个分支，确认 gate 条件一致（例如 `tsc` 特例在两个 state machine 里都以"首个非-flag token 是 `--noEmit`/`--version`/`--help` 之一"为入口）
3. 跑 BT-C1-* / BT-C2-* / BT-C3-* 断言，确认两个 state machine 的行为一致

**理由**：

- Change B 的 P1 缺陷是"两个 state machine 分叉"的典型——`isSilentCommand` 加了 `GIT_BLOB_OK_SUBCOMMANDS` gate，`extractBashTargets` step 4b 没加，导致 `git config user.name Alice` 静默写入
- Change B 的教训固化成流程性检查：不是"记得两个地方都要改"（人容易忘），而是"T6.1 显式核对"（机械可验证）

**替代方案**：

- ❌ 依赖 code review 发现分叉：Change B 已经证明 code review 能发现，但 code review 是 review 后（apply 前）发现，本 change 选择在 T6.1 显式核对以更早发现
- ❌ 合并两个 state machine 为一个共享 helper：Change B 已经在 proposal 里评估过这个方案（"长期：把两个 state machine 合并为共享 helper 防止未来漂移"），但本 change 不做大重构，只加一致性核对——合并是本 change 的 Non-Goal

## Risks / Trade-offs

- **[Risk] `tsc --noEmit` 的语义随 TypeScript 版本变化** → 未来某个 tsc 版本可能改变 `--noEmit` 的语义（例如允许 side-effect hooks）。缓解：这是 TypeScript 官方语义，本 change 依赖官方保证；若未来变更，走下一个 change 回退
- **[Risk] `npx --no-install <pkg>` 里的 `<pkg>` 可能是本地不存在的包** → `npx --no-install foo` 会报错但不会拉包，本 change 的判定正确；用户执行时会看到报错，无安全影响
- **[Risk] `go fmt -w` 的写入边界依赖 Go CLI 语义** → Go 工具链保证 `go fmt` 只在传入路径的文件上写入；若传入路径含 worktree 外路径，本 change 的 `looksLikeRepoRelativePath` 会拒绝
- **[Risk] `tsc` 允许 flag 白名单过于严格** → 用户输入的常见 flag 组合（如 `tsc --noEmit --skipLibCheck`）需要显式加入白名单，否则判 UNRL。缓解：D2 的白名单已覆盖社区常见 flag；若用户反馈漏掉常用 flag，走下一个 change 增补
- **[Risk] `tsc` 允许 flag 白名单过于宽松** → 恶意构造 `tsc --noEmit --outDir /tmp/build` 试图绕开 `--outDir` 拒绝。缓解：D2 明确列出拒绝的 flag，测试断言 BT-C1-5/6 显式覆盖
- **[Risk] 两个 state machine 分叉（Change B 教训）** → 本 change 的 T6.1 显式核对是流程性防护；但依然依赖 agent 在 apply 阶段执行 T6.1。缓解：BT-C1-* / BT-C2-* / BT-C3-* 断言覆盖所有扩展点，即使 state machine 分叉也会被断言捕获
- **[Trade-off] 只放行 `tsc --noEmit`** → 用户可能觉得"为什么 `tsc --project` 不能静默？"——因为 `tsc --project tsconfig.json` 默认会 emit 到 tsconfig 定义的 `outDir`。缓解：见 D2；用户执行 `tsc --noEmit --project tsconfig.json` 即可
- **[Trade-off] `npx <pkg>`（无 `--no-install`）仍判 UNRL** → 用户跑 `npx eslint` 会判 UNRL，需手动加 `--no-install` 或先 `npm install eslint`。缓解：这是"npx 可能远程拉包执行任意脚本"的固有风险，静态分析层无法安全放行
- **[Trade-off] `rg <pattern>` / `jq . <file>` 留给 Change D 或不做** → 用户可能觉得"这两个是极常见的只读命令"。缓解：`rg`/`jq` 的 pattern/path 二义性判定需要引入 regex/path 识别规则，超出本 change 的"精确证明"标准；若要做，走独立 change

## Migration Plan

**部署顺序**（不涉及版本发布，扩展通过 pi 直接加载 TypeScript 源码）：

1. 合并 Change C 后，用户下次启动 pi 会话即生效
2. 无需数据迁移、无需配置变更
3. 无需通知用户（无 UI 变化，只是弹窗次数减少）

**回滚**：git revert 单个 commit 即可；无持久化状态改动。

**升级兼容性**：

- 新旧版本 pi-coding-agent 加载本 change：无兼容问题（`extractBashTargets` 的返回值 shape 不变，只是 `reliable` 的取值在 `tsc --noEmit` / `go vet` / `go fmt` / `npx --no-install <pkg>` 场景下更倾向 `true`）
- 新版本 pi-coding-agent 加载旧版本扩展：无兼容问题（旧扩展行为不变）

## Open Questions

**无**。

所有可能改变本 change 的 spec / 决策 / 任务分解的未知项都已在 Decisions 节里明确决策。若后续用户提出新诉求（例如"能不能把 `npx eslint` 不带 `--no-install` 也加入白名单"或"能不能把 `rg <pattern>` 也加入白名单"），走下一个 change（Change D）而不是扩展本 change 的 scope。
