## Context

`isSilentCommand` 是 `bash-extract.ts` 内部分类命令是否 0-target 静默的核心判定函数（`src/lib/bash-extract.ts:957-1006`），采用三模式结构：

- **Mode 1**：命令不在 `SILENT_COMMANDS` → 返回 `false`
- **Mode 2**：空 allow-set + 非 `SILENT_ALLOW_ALL`（tsc/make/rg/jq/npx）→ 严格 flag-only，任何 positional token 返回 `false`
- **Mode 3**：非空 allow-set 或 `SILENT_ALLOW_ALL`（git/npm/yarn/pnpm/cargo/go/openspec）→ 识别 subcommand，post-subcommand 阶段严格禁止任何 positional token

Mode 3 的"post-subcommand 严格禁止任何 positional"策略是 Change B 的两个误报根因所在——它一刀切拒绝 `git blame src/main.ts`、`npm run test` 这类合法只读命令。

现有约束：

- **公共契约变更**：本 change 触及 `bash-target-extraction` spec，新增两条 ADDED requirement（"Git 只读子命令的 blob 语法与 repo 内路径静默放行" 与 "npm/yarn/pnpm run <script> 形式静默放行"）——属 human-in-loop 基线第 1 类，本 proposal 已获用户确认（用户明确说"按顺序建 change"）。
- **TDD 边界**（profile-brownfield 变体规则）：新增行为强制 TDD；`isSilentCommand` 是老代码，改造前先加 characterization test（BT-BLOB-* 与 BT-RUN-* 断言）。
- **已有边界**：archived changes 建立的 `bash-stage-b-security-fixes` 明确收窄了 pre-Stage-B 的命令名白名单——`npm run build`、`git log /etc/passwd`、`rg pattern /etc/shadow`、`jq . /etc/shadow`、`make -f /tmp/evil.mk`、`cargo run --manifest-path ...` 都不再静默。本 change 不违反这些既有边界。
- **代码分层契约**：`src/lib/bash-extract.ts` 是纯函数库（无 IO），本 change 只改纯函数。

## Goals / Non-Goals

**Goals:**

- 让 `git blame <file>` / `git diff <path>` / `git show HEAD:file` / `git log HEAD:file` / `git status <path>` / `git rev-parse HEAD:file` 静默通过（repo 内 blob 语法与相对路径）
- 让 `npm run test` / `npm run lint` / `yarn run test` / `pnpm run audit` 等与直接形式等价的 `run <script>` 静默通过
- 保持 `git fetch/pull/push/clone/add/commit/checkout` 等 network/写操作 subcommand 的不可靠判定
- 保持 `git log /etc/passwd` / `git diff /etc/passwd` 等 worktree 外绝对路径的不可靠判定
- 保持 `npm run build/dev/publish` 等非白名单脚本名的不可靠判定

**Non-Goals:**

- **不处理** `tsc src/main.ts` / `go build|vet|fmt|mod tidy` / `npx eslint` / `npx prettier` 等其他工具——见 proposal "Why" 节解释的取舍理由
- **不改** `SILENT_COMMANDS` 的数据结构（`Record<cmdName, Set<subcommand>>`）——`run <script>` 识别在 `isSilentCommand` 内部处理
- **不改** `SILENT_COMMANDS.git` 的 allow-set 内容——本 change 效果在 post-subcommand 阶段逻辑实现
- **不放宽** 任何其他 subcommand（`git fetch` 等 network 子命令仍判 UNRL）
- **不放宽** 任何其他 shell 构造（heredoc / pipeline / control flow / glob 等既有检测不变）
- **不做** `git diff <path-1> <path-2>` 的"多 positional 混用"的显式列举——本 change 允许 blob 语法与 repo 相对路径混用（如 `git diff HEAD~1 src/main.ts`）是通用规则，不单列 scenario（避免账本膨胀）
- **不做** `npx <pkg>` 的白名单扩展（`eslint`/`prettier`/`tsc` 等 dev 工具）——留给 Change C
- **不做** 敏感词脱敏、shell forwarder 增强、heredoc 增强——均非本 change 范畴

## Decisions

### D1: `isSilentCommand` 内部实现方式

**决策**：在 `isSilentCommand` 的 Mode 3（subcommand 模式）里，对 `git` 与 `npm/yarn/pnpm` 各加一段"post-subcommand 阶段扩展"分支，不改函数签名、不改数据结构。

- **git 分支**：Mode 3 识别到 subcommand 属于只读子命令 allow-set 后，继续扫描后续 tokens，若每个非-flag 的 positional token 都满足"git blob 语法"或"repo 内相对路径"两种形式之一，返回 `true`
- **npm/yarn/pnpm 分支**：Mode 3 识别到第一个 token 是 `"run"` 时，把后续 token 视为待识别的 script 名（必须 ∈ `{test, lint, audit}`），且后续不能有任何 `--` 分隔或 positional

**理由**：

- **保持 Mode 1/2/3 的既有抽象**：三模式结构是本分系统的公共契约（`isSilentCommand` 被 `extractBashTargets` 内部调用，其他调用方通过 `extractBashTargets` 间接消费）
- **不改 `SILENT_COMMANDS` 数据结构**：把 `run <script>` 编码进 Set 数据需要新增"多 token subcommand"表达力（例如把 `["run test", "run lint", "test", "lint", "audit"]` 都写进 Set），会污染数据语义、增加后续演进成本
- **集中实现**：git 与 npm 的扩展逻辑都在同一个函数里，便于统一维护、单元测试、代码 review

**替代方案**：

- ❌ 在 `SILENT_COMMANDS.git` 的 allow-set 中加入 `["blame:file", "blame -L:range,file"]` 这类复合 key：数据结构从 `Set<string>` 变成 `Set<ComplexKey>`，破坏现有类型契约
- ❌ 为每个 subcommand 新增独立的 `SILENT_COMMANDS.git.blame` 子配置：需要引入第二层嵌套（当前是扁平 `Record<cmdName, Set<subcommand>>`），改动面过大
- ❌ 增加新的模式 Mode 4（"path-aware subcommand"）：函数从"三种判定路径"变成"四种"，破坏现有可读性；且 Mode 4 与 Mode 3 的关系是包含（Mode 3 的 git 部分被扩展），不是并列

### D2: git blob 语法与 repo 内相对路径的识别规则

**决策**：

- **git blob 语法识别**：`<token>` 匹配 `<rev>:<path>`，其中 `<rev>` 必须满足以下**全部**条件才被视为合法 revision：
  1. 长度 ≥ 1
  2. 不以 `/`、`~`、`.` 开头
  3. 不含 `..`（避免路径歧义）
  4. 不含 `.ext` 形态（如 `main.ts`——单个扩展点、扩展点后有字母，视为文件路径而非 revision）——但允许 `v1.2.3` 这类语义化版本
- **repo 内相对路径识别**：
  1. 不以 `/`、`~` 开头
  2. 不含 `../` 片段
  3. 不是 Windows 盘符路径（正则 `^[A-Za-z]:[\\/].*`）

**理由**：

- **保守判定**：宁可多判 UNRL（弹窗）也不要漏放行可疑命令。规则 3（不允许 `..`）虽然会让 `HEAD~1^:file` 这类 revision 表达式中的 `~1^` 部分误判——但 `~` 与 `^` 在 revision 表达式中通常紧跟在 `HEAD`/`origin/` 之后（如 `HEAD~1`、`origin/main~2`），且规则 3 只针对 token 起始的 `.` 与 `..`，不针对 token 中间的 `~` 与 `^`
- **不引入正则库**：用字符串方法（`startsWith`、`includes`、`indexOf`）+ 一个简单的 `looksLikeRevision` 辅助函数，避免正则在 TypeScript 与 Unicode 转义上的微妙差异

**替代方案**：

- ❌ 完整的 git revision grammar 解析（支持 `^@{upstream}`、`@{1}`、`HEAD^^^`、`main{remote}` 等）：过度复杂，且用户实际输入的 revision 表达式很少超过 `HEAD~N`、`HEAD^`、`origin/<branch>`、`v<semver>`
- ❌ 允许任何带 `:` 的 token 作为 blob 语法（只要 `:` 后非空）：会让 `/etc/passwd:/foo`、`./foo:bar` 这类可疑 token 通过
- ❌ 拒绝所有含 `.` 的 revision 表达式：会拒绝 `v1.2.3`、`HEAD.v1` 等合法 revision

### D3: `npm run <script>` 的等价判定

**决策**：

- `npm run test` / `npm run lint` / `npm run audit` 静默
- `yarn run test` / `yarn run lint` / `yarn run audit` 静默
- `pnpm run test` / `pnpm run lint` / `pnpm run audit` 静默
- 任何 `run <script>` 后跟其他 token（如 `npm run test -- --coverage`、`npm run build -- --watch`、`npm run -- scriptName`）一律判 UNRL
- 脚本名必须严格 ∈ `{test, lint, audit}`

**理由**：

- **等价于直接形式**：`npm test` 语义上等于 `npm run test`，`npm run test` 后跟 `-- ...` 是脚本参数，脚本本身可能有任意副作用（例如 test 脚本可以配置成 `prettier --write /etc/hosts`），无法静态判定
- **保守边界**：`build`、`publish`、`dev` 等常见脚本名不进入白名单——`build` 可能触发 TypeScript 编译到任意 outDir、`publish` 发布到 registry、`dev` 是长时驻留进程
- **`--` 分隔一律拒绝**：`npm run <script> -- <args>` 的 `<args>` 是脚本参数，extractor 静态无法判定脚本内容——即使 script 名是 `test`，`npm run test -- --coverage --watch` 的副作用也取决于项目的 package.json，无法静态判定

**替代方案**：

- ❌ 白名单扩展到 `{test, lint, audit, typecheck, check, validate}`：这些是社区常见的只读脚本名，但不同项目的定义可能不同（例如 `typecheck` 可能被定义为 `tsc --noEmit`，也可能被定义为 `tsc --outDir /tmp/out && eslint`）——静态判定不成立，宁可保守
- ❌ 允许 `npm run <script> -- --<flag>`（仅 flag 形式）：仍可能触发脚本执行时 `-- --flag` 传入脚本，脚本根据 flag 决定行为——静态判定不成立
- ❌ 动态读取项目的 package.json 判定脚本内容：引入 IO 依赖到 `bash-extract.ts` 的纯函数库层，违反代码分层契约（`src/lib/*.ts` 保持无 UI/IO 依赖）

### D4: `npm`/`yarn`/`pnpm` 的 flag 一律拒绝

**决策**：`npm`/`yarn`/`pnpm` 在 Mode 2（strict flag-only）或 Mode 3 的 subcommand 模式下，任何形如 `--workspace=.`、`--cwd=<path>`、`--prefix=<path>` 的 flag 都视为 positional 值，导致判 UNRL。

**理由**：

- `--cwd=<path>` 让 npm 在 `<path>` 目录下执行，可以完全绕开 project worktree 边界——`npm --cwd=/etc/hosts test` 是完全合法的 npm 调用（虽然语义奇怪），但让工作目录变成 `/etc/hosts` 后 test 脚本的行为无法静态判定
- `--workspace=<ws>` 与 `--filter=<pattern>` 让 monorepo 项目运行子工作区的脚本，行为同样取决于该子工作区的 package.json

**替代方案**：

- ❌ 允许 `--workspace=` 只当值为 `.` 或 `..` 时静默：判断"是否为 repo 内相对路径"与 D2 的判定规则一致，但 workspace 是 monorepo 概念，路径解析依赖 npm 的 workspace 定义——超出静态分析能力
- ❌ 允许 `--dry-run`、`--frozen-lockfile` 这类无副作用 flag：npm 的 flag 系统复杂，且 flag 值可能包含路径（如 `--config=<file>`）——一律拒绝更保守

### D5: `git` 的 subcommand allow-set 保持既有内容

**决策**：`SILENT_COMMANDS.git` 的 allow-set 保持 `{status, log, diff, branch, tag, remote, config, rev-parse, rev-list, shortlog, blame, show, ls-files}` 不变。

**理由**：

- 本 change 的效果在 `isSilentCommand` 内部实现（Mode 3 post-subcommand 阶段扩展），不需要修改数据
- 保持 `git config`、`git branch`、`git tag`、`git remote`、`git ls-files` 在 allow-set 中：这些子命令的既有 Mode 3 行为是"允许任何 flag，禁止 positional"，本 change 不改变这些行为
- 保持 `git fetch`、`git pull`、`git push`、`git clone`、`git add`、`git commit`、`git checkout`、`git rm` 不在 allow-set：这些 subcommand 不在 allow-set 时，`isSilentCommand` 返回 `false`，然后 `extractBashTargets` 判定为 `unreliable_command`——本 change 不改变这些行为

**边界裁定**：本 change 明确只扩展"git 只读子命令"的 post-subcommand 阶段行为，不涉及 allow-set 数据变更。

### D6: 保持"多 positional 混用"的通用规则

**决策**：一个 git 命令的 positional 参数可以混合 blob 语法与 repo 内相对路径（如 `git diff HEAD~1 src/main.ts`、`git log HEAD:src/main.ts src/main.ts`），只要每个 positional 都满足约束即可。

**理由**：

- `git diff <rev> <path>` 是极常见的合法调用形式（对比某 revision 与某文件）
- `git log <rev>:<path>` 与 `git log <path>` 语义不同（前者限定 blob，后者限定文件）——两者都合法
- 通用规则比"逐条枚举允许的 positional 组合"更简洁、可测试性更强

**替代方案**：

- ❌ 严格禁止 blob 语法与相对路径混用：会让 `git diff HEAD~1 src/main.ts` 判 UNRL，这是极常见的日常调用
- ❌ 限制 positional 数量上限：无根据

### D7: 不修改既有测试，只追加

**决策**：`test/bash-extract.test.ts` 只追加 BT-BLOB-* 与 BT-RUN-* 断言，不修改既有测试断言。

**理由**：

- 既有 BT-B21 `git_status_no_positional_is_silent` 断言 `git status` 无 positional 时静默——本 change 的效果是"加 positional 后仍静默"，二者不冲突
- 既有 SYS4/SYS5/SYS8 集成测试断言 shell forwarder / control flow / forwarder 三类不可靠行为——与 `git blame <file>` / `npm run test` 无交集
- 追加不改动是 brownfield 变体规则的直接要求：老代码改造前加 characterization test，不动既有断言

**T0.1 grep 前置检查**（在 TDD 阶段之前）：

- `grep -c "git blame\|git diff.*src/\|git log HEAD:" test/bash-extract.test.ts` 应为 0
- `grep -c "npm run\|yarn run\|pnpm run" test/bash-extract.test.ts` 应为 0

若非 0，需先阅读命中的测试，判断是否与 BT-BLOB-* / BT-RUN-* 有语义重叠——有重叠则调整命名，无重叠则照写。

## Risks / Trade-offs

- **[Risk] git blob 语法识别规则过于严格** → 用户输入 `HEAD.abc:file` 这类少见但合法的 revision 表达式会被误判为 UNRL。缓解：这是保守判定（多弹窗不致命），用户可用 `git --no-pager log HEAD:file` 绕过（`--no-pager` 是允许的 flag）；本 change 优先保证不误放行而非完全覆盖所有合法 revision。
- **[Risk] git blob 语法识别规则过于宽松** → 恶意构造 `git log /etc/passwd` 若通过某种路径歧义被判为 blob 语法。缓解：D2 的规则 1-4 都基于"不以 / ~ . 开头 + 不含 .. + 不含 .ext 形态"，绝对路径与家目录前缀在规则 1 就被拒绝；`/etc/passwd` 中的 `passwd` 前无 `:`，不匹配 blob 语法；测试断言 BT-BLOB-17/18 显式覆盖此场景。
- **[Risk] `npm run <script>` 通过 package.json 中的钩子扩展执行更多命令** → npm 的 `pretest`/`posttest` 等钩子会在 `npm run test` 时自动执行，如果钩子定义为 `rm -rf /` 就绕过了本 change 的静默判定。缓解：这是 npm 的**固有语义**，本 change 的等价于"用户执行 `npm test`"，用户已经在接受这个 npm 语义风险——本 change 不额外引入风险，只是让两种等价调用形式获得一致的静默判定。用户如果需要针对 `pretest` 钩子做防护，应该通过 `sensitive.ts` 的敏感路径表实现，而不是 extractor 层。
- **[Risk] TypeScript 编译产物差异** → `isSilentCommand` 的辅助函数 `looksLikeGitBlob` 与 `looksLikeRepoRelativePath` 若使用 ES2020+ 语法，在 jiti 加载时可能触发兼容性问题。缓解：全部用 ES2020 之前的字符串方法（`startsWith`、`includes`、`indexOf`），正则使用简单字符类，避免 `??=`、`#private` 等现代语法。
- **[Trade-off] 只放行 test/lint/audit 三个脚本名** → 用户可能觉得"为什么 `typecheck` / `check` / `validate` 不能静默？"——这三个脚本名在社区常见，但每个项目的定义不同，静态判定不成立。缓解：见 D3 的替代方案；这是"保守 vs 灵活"的取舍，本 change 选择保守。
- **[Trade-off] 不允许 `npm run <script> -- --<flag>`** → 用户跑 `npm run test -- --watch` 会判 UNRL，可能觉得"watch 只是开发模式"。缓解：`--watch` 语义取决于脚本本身，可能启动长时驻留进程或修改文件（如 `eslint --fix`），静态判定不成立。

## Migration Plan

**部署顺序**（不涉及版本发布，扩展通过 pi 直接加载 TypeScript 源码）：

1. 合并 Change B 后，用户下次启动 pi 会话即生效
2. 无需数据迁移、无需配置变更
3. 无需通知用户（无 UI 变化，只是弹窗次数减少）

**回滚**：git revert 单个 commit 即可；无持久化状态改动。

**升级兼容性**：

- 新旧版本 pi-coding-agent 加载本 change：无兼容问题（`extractBashTargets` 的返回值 shape 不变，只是 `reliable` 的取值在 git blob / npm run 场景下更倾向 `true`）
- 新版本 pi-coding-agent 加载旧版本扩展：无兼容问题（旧扩展行为不变）

## Open Questions

**无**。

所有可能改变本 change 的 spec / 决策 / 任务分解的未知项都已在 Decisions 节里明确决策。若后续用户提出新诉求（例如"能不能把 `npm run typecheck` 也加入白名单"），走下一个 change 而不是扩展本 change 的 scope——扩展 allow-set 到 `{test, lint, audit, typecheck, check, validate}` 是一个独立的产品决策，需要用户对"每个项目的 typecheck 定义不同"这一事实做取舍。
