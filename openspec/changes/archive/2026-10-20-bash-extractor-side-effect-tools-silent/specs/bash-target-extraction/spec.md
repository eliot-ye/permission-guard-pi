## ADDED Requirements

### Requirement: `tsc` 纯检查形式静默放行

系统 SHALL 在 `SILENT_COMMANDS` 的 `tsc` 分支接受**纯检查形式**并判静默放行（`{ reliable: true, targets: [] }`）。

**入口判定**：`tsc` 命令的首个非-flag token MUST 是以下三个之一——`--noEmit`、`--version`、`--help`（或短形式 `-h`）。其他形式（包括无首个非-flag token 的 `tsc`、首个非-flag token 是源文件路径的 `tsc <src>`、首个非-flag token 是其他 flag 的 `tsc --project <path>` 等）MUST 判 `unreliable_command`。

**允许跟随入口 flag 的 flag 白名单**：

- `--noEmit`（重复出现允许）
- `--version`、`--help`、`-h`（元信息形式，允许重复）
- `--project` / `-p`（TSConfig 路径参数，值 MUST 是**非 flag** token）
- `--watch` / `-w`（开发模式，纯检查）
- `--incremental`、`--pretty`、`--pretty true`、`--pretty false`、`--pretty <bool>`（输出格式）
- `--target`、`--module`、`--moduleResolution`、`--strict`、`--skipLibCheck`、`--esModuleInterop`、`--resolveJsonModule`、`--noImplicitAny`、`--noImplicitReturns`、`--strictNullChecks`、`--strictFunctionTypes`、`--noUncheckedIndexedAccess`、`--useDefineForClassFields`、`--forceConsistentCasingInFileNames`、`--jsx`（类型检查选项，纯检查语义）
- 值形式：`--flag <value>` 与 `--flag=<value>` 都接受（后续值必须是**非 flag** token）

**一律拒绝的 flag**（MUST 判 `unreliable_command`，即使 `--noEmit` 存在）：

- `--outDir`、`--declarationDir`、`--rootDir`、`--declaration`、`--declarationMap`、`--sourceMap`、`--outFile`（允许 worktree 外写入）
- `--emitDeclarationOnly`、`--emitDecoratorMetadata`、`--isolatedDeclarations`（`--noEmit` 与这些组合时 tsc CLI 实际会 emit d.ts 到磁盘）
- `--noCheck`（跳过类型检查，静态分析无法证明安全）
- `--build` / `-b`（触发 TypeScript Project References 构建）

**约束**：

- 入口判定 MUST 是**首个非-flag token**，token 顺序不影响判定（`tsc --project tsconfig.json --noEmit` 与 `tsc --noEmit --project tsconfig.json` 语义等价，两者都 MUST 静默）
- 不允许任何非-flag positional token（源文件路径等）出现在 `tsc` 命令中——即使 `--noEmit` 存在，`tsc --noEmit src/main.ts` MUST 判 `unreliable_command`（源文件列表的语义是"编译这些源文件"，静态分析层无法排除其他 emit 行为）
- 本 requirement 的效果在 `isSilentCommand` 的 `tsc` 分支**以及** `extractBashTargets` silent-form 4b 分支**两处**通过一致的实现落地

**理由**：`--noEmit` 是 TypeScript CLI 显式禁 emit 的官方 flag，是唯一能"静态证明无 emit"的入口。`--version`/`--help` 是元信息输出，无副作用。拒绝 `--emitDeclarationOnly` 即使 `--noEmit` 存在，是因为 tsc CLI 的实际行为是 `--emitDeclarationOnly` 与 `--noEmit` 组合时仍 emit 声明文件到磁盘。

#### Scenario: `tsc --noEmit` 静默

- **WHEN** bash 命令为 `tsc --noEmit`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`--noEmit` 是入口 flag，静默

#### Scenario: `tsc --noEmit --project tsconfig.json` 静默

- **WHEN** bash 命令为 `tsc --noEmit --project tsconfig.json`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`--project <path>` 是允许的 flag，`tsconfig.json` 是允许的值

#### Scenario: `tsc --noEmit -p tsconfig.json` 静默

- **WHEN** bash 命令为 `tsc --noEmit -p tsconfig.json`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`-p` 是 `--project` 的短形式

#### Scenario: `tsc --version` 静默

- **WHEN** bash 命令为 `tsc --version`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；元信息输出

#### Scenario: `tsc --help` 静默

- **WHEN** bash 命令为 `tsc --help`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；元信息输出

#### Scenario: `tsc --noEmit --target es2022 --strict` 静默

- **WHEN** bash 命令为 `tsc --noEmit --target es2022 --strict`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`--target` 与 `--strict` 都是类型检查选项

#### Scenario: `tsc src/main.ts` 仍判不可靠

- **WHEN** bash 命令为 `tsc src/main.ts`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；无 `--noEmit`，默认会 emit 到 worktree 外的 `outDir`

#### Scenario: `tsc --outDir /tmp/build` 仍判不可靠

- **WHEN** bash 命令为 `tsc --outDir /tmp/build`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`--outDir` 允许 worktree 外写入，被显式拒绝

#### Scenario: `tsc --noEmit --emitDeclarationOnly` 仍判不可靠

- **WHEN** bash 命令为 `tsc --noEmit --emitDeclarationOnly`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`--emitDeclarationOnly` 与 `--noEmit` 组合时 tsc CLI 实际 emit d.ts 到磁盘，被显式拒绝

#### Scenario: `tsc --noEmit src/main.ts` 仍判不可靠

- **WHEN** bash 命令为 `tsc --noEmit src/main.ts`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；不允许任何非-flag positional（源文件路径）

#### Scenario: `tsc --noCheck` 仍判不可靠

- **WHEN** bash 命令为 `tsc --noCheck`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`--noCheck` 跳过类型检查，静态分析无法证明安全

#### Scenario: `tsc -b` 仍判不可靠

- **WHEN** bash 命令为 `tsc -b`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`-b` / `--build` 触发 Project References 构建

### Requirement: `go vet` / `go fmt` 子命令静默放行

系统 SHALL 在 `SILENT_COMMANDS` 的 `go` allow-set 内接受 `vet` 与 `fmt` 子命令，并判静默放行（`{ reliable: true, targets: [] }`）。

**子命令 allow-set**（本 requirement 生效的子命令白名单）：`vet`、`fmt`。

**允许作为 positional 参数的形式**：

- **repo 内相对路径**：`./path/to/file` 或 `path/to/file` 形式，且满足以下约束（复用 Change B 建立的 `looksLikeRepoRelativePath` 识别规则）
  - MUST NOT 以 `/` 开头（绝对路径）
  - MUST NOT 以 `~/` 开头（家目录前缀）
  - MUST NOT 包含 `../` 越界片段
  - MUST NOT 是 Windows 盘符路径（`C:\` 等）
  - 可以是目录（结尾 `/`）或文件（任意扩展名）
  - 支持 Go 包约定：`./...`（当前目录递归）、`./src/...`（子目录递归）
- **无 positional**：`go vet`、`go fmt` 单独调用（无路径参数）

**允许作为 flag 的组合**：

- `go vet` 的分析控制 flag：`-copylocks`、`-printf`、`-shadow`、`-structtag`、`-atomic`、`-bool`、`-buildtag`、`-httpmux`、`-loopclosure`、`-nilfunc`、`-slog`、`-stdmethods`、`-tests`、`-unsafeptr`、`-unusedresult`、`-unusedwrite`、`-all`、`-h`、`-help`
- `go fmt` 的写入控制 flag：`-l`（列出修改的文件）、`-w`（写入原文件）、`-r <pattern>`（重构模式，值 MUST 是**非 flag** token）、`-s`（额外简化）

**约束**：

- 一个 `go vet` / `go fmt` 命令的 positional 参数 MUST 全部满足"repo 内相对路径"约束——只要有一个 positional 不满足，整个命令 MUST 判 `unreliable_command`
- Flag MUST 出现在 subcommand 之后、positional 之前——`go vet <pkg> --flag` MUST 判 `unreliable_command`（flag 出现在 positional 之后，Go CLI 语义上是 `<pkg>` 接收 `--flag`，静态分析不可靠）
- 其他 `go` 子命令（`build`、`test`、`run`、`mod`、`install`、`generate`、`list` 等）MUST 保持既有不可靠判定
- 在 `SILENT_COMMANDS.go` 内但不在本 requirement 允许子命令内（`version`、`env`）MUST 保持既有静默判定
- 本 requirement 的效果在 `isSilentCommand` 的 `go` 分支**以及** `extractBashTargets` silent-form 4b 分支**两处**通过一致的 `GO_SILENT_POSITIONAL_SUBCOMMANDS` 交集判定落地

**理由**：`go vet` 是纯静态分析（Go 工具链保证），`go fmt` 只在传入路径的 Go 源文件上格式化（Go 工具链保证）。两者的路径约束行为由 Go CLI 自身保证——传入的绝对路径或越界路径会被本 requirement 的 `looksLikeRepoRelativePath` 显式拒绝。

#### Scenario: `go vet` 静默

- **WHEN** bash 命令为 `go vet`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`vet` 在 allow-set，无 positional

#### Scenario: `go vet ./...` 静默

- **WHEN** bash 命令为 `go vet ./...`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`./...` 是 repo 内相对路径（Go 包递归约定）

#### Scenario: `go vet ./src/...` 静默

- **WHEN** bash 命令为 `go vet ./src/...`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；子目录递归

#### Scenario: `go vet -shadow ./...` 静默

- **WHEN** bash 命令为 `go vet -shadow ./...`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`-shadow` 是允许的分析控制 flag

#### Scenario: `go fmt` 静默

- **WHEN** bash 命令为 `go fmt`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；无 positional

#### Scenario: `go fmt ./...` 静默

- **WHEN** bash 命令为 `go fmt ./...`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；子目录递归

#### Scenario: `go fmt src/main.go` 静默

- **WHEN** bash 命令为 `go fmt src/main.go`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；具体 Go 文件

#### Scenario: `go fmt -w ./...` 静默

- **WHEN** bash 命令为 `go fmt -w ./...`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`-w` 是允许的写入控制 flag（写入边界由 `looksLikeRepoRelativePath` 约束）

#### Scenario: `go version` 静默（既有行为回归）

- **WHEN** bash 命令为 `go version`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`version` 在 allow-set，保持既有静默

#### Scenario: `go env` 静默（既有行为回归）

- **WHEN** bash 命令为 `go env`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`env` 在 allow-set，保持既有静默

#### Scenario: `go vet /tmp/evil.go` 仍判不可靠

- **WHEN** bash 命令为 `go vet /tmp/evil.go`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；绝对路径不满足 repo 内相对路径约束

#### Scenario: `go fmt -w /tmp/evil.go` 仍判不可靠

- **WHEN** bash 命令为 `go fmt -w /tmp/evil.go`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`-w` 允许写入，但 `/tmp/evil.go` 是绝对路径，被 `looksLikeRepoRelativePath` 拒绝

#### Scenario: `go vet ./.../../../etc` 仍判不可靠

- **WHEN** bash 命令为 `go vet ./.../../../etc`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；包含 `../` 越界片段

#### Scenario: `go vet ./... --flag` 仍判不可靠

- **WHEN** bash 命令为 `go vet ./... --flag`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；flag 出现在 positional 之后，Go CLI 语义上是 `<pkg>` 接收 `--flag`，静态分析不可靠

#### Scenario: `go build ./...` 仍判不可靠

- **WHEN** bash 命令为 `go build ./...`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`build` 不在本 requirement 允许子命令 allow-set，且触发依赖下载 + 产出二进制

#### Scenario: `go test ./...` 仍判不可靠

- **WHEN** bash 命令为 `go test ./...`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`test` 不在本 requirement 允许子命令 allow-set

#### Scenario: `go run .` 仍判不可靠

- **WHEN** bash 命令为 `go run .`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`run` 不在本 requirement 允许子命令 allow-set

#### Scenario: `go mod tidy` 仍判不可靠

- **WHEN** bash 命令为 `go mod tidy`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`mod` 不在本 requirement 允许子命令 allow-set，且触发网络操作

#### Scenario: `go mod download` 仍判不可靠

- **WHEN** bash 命令为 `go mod download`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`mod` 不在本 requirement 允许子命令 allow-set，且触发网络操作

### Requirement: `npx --no-install` 形式静默放行

系统 SHALL 在 `SILENT_COMMANDS` 的 `npx` 分支接受**`--no-install` 形式**并判静默放行（`{ reliable: true, targets: [] }`）。

**形式识别**：

- `npx` 命令的 tokens 中 MUST 包含 `--no-install` flag（这是特例路径的入口判定）
- `--no-install` 前后 MUST 允许任意数量的允许 flag（见下方"允许 flag 白名单"）
- `--no-install` 之后 MUST 恰好有**一个**非-flag positional token 作为包名（如 `eslint`、`tsc`、`prettier`、`jest`、`vitest` 等任意包名，不做白名单枚举）
- `--no-install` 之后 MUST NOT 有任何额外 token（无更多 positional、无 `--` 分隔、无 flag 在包名之后）

**允许 flag 白名单**：

- `--no-install` 本身（路径入口）
- 通用 npm/npx flag：`--cache=<path>`、`--color=<mode>`、`--yes` / `-y`、`--loglevel=<level>`、`--silent`、`--quiet`、`--no-fund`、`--no-timing`、`--no-update-notifier`、`--offline`、`--prefer-offline`

**一律拒绝的 flag**：

- `--prefix=<path>`（改变工作目录，与 Change B 的 `npm --cwd` 边界一致）
- `--package=<pkg>`（`--package` 允许多值，语义与 positional 不同，静态分析不可靠）
- `--call=<cmd>`、`-c <cmd>`（`npx -c <cmd>` 是 `npm exec -c <cmd>`，执行任意脚本）

**约束**：

- 包名 MUST 是**单个非-flag token**——不允许 `--pkg=<name>` 形式（`--pkg` 与 positional 语义不同）
- 不允许 `npx <pkg>`（无 `--no-install`）——`npx` 可能远程拉包执行任意脚本
- 不允许 `npx --no-install <pkg> <extra-positional>`——第二个 positional 是包接收的命令行参数（如 `eslint src/**` 的 `src/**`），pattern/path 二义性静态分析不可靠
- 不允许 `npx --no-install <pkg> --<flag>`——flag 在包名之后是包接收的命令行参数（如 `eslint --fix`）
- 不允许 `npx --no-install`（无包名）——`npx` 无包名时会报错但不拉包，但语义上不是"执行已装包"
- 本 requirement 的效果在 `isSilentCommand` 的 `npx` 分支**以及** `extractBashTargets` silent-form 4b 分支**两处**通过一致的实现落地

**理由**：`--no-install` 是 npm CLI 显式禁网络拉包的官方 flag，静态可证明"只用本地已装包"。只允许一个 positional 作为包名，避免包接收的命令行参数被误判为路径。拒绝 `--prefix`/`--package`/`--call` 保持与 Change B 的 `npm --cwd` 边界一致。

#### Scenario: `npx --no-install eslint` 静默

- **WHEN** bash 命令为 `npx --no-install eslint`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`--no-install` 是入口，`eslint` 是包名

#### Scenario: `npx --no-install tsc` 静默

- **WHEN** bash 命令为 `npx --no-install tsc`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；任意包名都允许

#### Scenario: `npx --color=always --no-install jest` 静默

- **WHEN** bash 命令为 `npx --color=always --no-install jest`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；允许 flag 在包名之前

#### Scenario: `npx --no-install --cache=./node_modules/.cache prettier` 静默

- **WHEN** bash 命令为 `npx --no-install --cache=./node_modules/.cache prettier`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`--cache=<path>` 是允许 flag，`--no-install` 与 `<path>` 顺序不影响

#### Scenario: `npx -y --no-install eslint` 静默

- **WHEN** bash 命令为 `npx -y --no-install eslint`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`-y` 是允许 flag

#### Scenario: `npx eslint` 仍判不可靠

- **WHEN** bash 命令为 `npx eslint`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；无 `--no-install`，可能远程拉包执行任意脚本

#### Scenario: `npx --no-install eslint src/**` 仍判不可靠

- **WHEN** bash 命令为 `npx --no-install eslint src/**`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；第二个 positional 是包接收的命令行参数，pattern/path 二义性

#### Scenario: `npx --no-install eslint --fix` 仍判不可靠

- **WHEN** bash 命令为 `npx --no-install eslint --fix`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；flag 在包名之后是包接收的命令行参数（`eslint --fix` 是写入 flag）

#### Scenario: `npx --no-install eslint -- src/**` 仍判不可靠

- **WHEN** bash 命令为 `npx --no-install eslint -- src/**`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`--` 之后的所有 token 被视为包的参数

#### Scenario: `npx --no-install` 仍判不可靠

- **WHEN** bash 命令为 `npx --no-install`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；无包名

#### Scenario: `npx --no-install --pkg=eslint` 仍判不可靠

- **WHEN** bash 命令为 `npx --no-install --pkg=eslint`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`--pkg=<name>` 形式与 positional 语义不同

#### Scenario: `npx --no-install --prefix=/tmp eslint` 仍判不可靠

- **WHEN** bash 命令为 `npx --no-install --prefix=/tmp eslint`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`--prefix` 改变工作目录，被显式拒绝

#### Scenario: `npx --no-install -c "eslint src/"` 仍判不可靠

- **WHEN** bash 命令为 `npx --no-install -c "eslint src/"`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`-c <cmd>` 是 `npm exec -c <cmd>`，执行任意脚本
