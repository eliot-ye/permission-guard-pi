## ADDED Requirements

### Requirement: Git 只读子命令的 blob 语法与 repo 内路径静默放行

系统 SHALL 在 `SILENT_COMMANDS` 的 `git` allow-set 内的**只读子命令**后续接受 git blob 语法与 repo 内相对路径作为 positional 参数，并判静默放行（`{ reliable: true, targets: [] }`）。

**只读子命令 allow-set**（本 requirement 生效的子命令白名单）：`status`、`log`、`diff`、`show`、`blame`、`rev-parse`、`rev-list`、`shortlog`。

**允许作为 positional 参数的两种形式**：

- **git blob 语法**：`<rev>:<path>` 形式，其中 `<rev>` 是**非路径形态**的 git revision，`<path>` 是任意非空字符串
  - `<rev>` 合法形态：单个字符（如 `M`）、分支/标签名（如 `HEAD`、`main`、`develop`）、revision 表达式（如 `HEAD~1`、`HEAD^`、`HEAD~10`、`HEAD~1^`、`HEAD^^`、`origin/main`、`HEAD..branch`、`HEAD...branch`、`v1.2.3`）
  - `<rev>` 非法形态：绝对路径（`/tmp/rev`）、家目录前缀（`~/rev`）、路径型名称（以 `.` 或 `..` 开头）、包含扩展名形态（`main.ts`）
- **repo 内相对路径**：`./path/to/file` 或 `path/to/file` 形式，且满足以下约束
  - MUST NOT 以 `/` 开头（绝对路径）
  - MUST NOT 以 `~/` 开头（家目录前缀）
  - MUST NOT 包含 `../` 越界片段
  - MUST NOT 是 Windows 盘符路径（`C:\` 等）
  - 可以是目录（结尾 `/`）或文件（任意扩展名）

**允许作为 flag 的任何 flag 组合**：与既有 allow-set 行为一致——`-L <range>`、`-n <num>`、`--oneline`、`--stat`、`--name-only`、`--reverse`、`--since <date>`、`--until <date>`、`--max-count <n>`、`--format=<fmt>` 等，值可以是任意字符串（包括数字、日期、字符串）。

**约束**：

- 一个 git 命令的 positional 参数 MUST 全部满足上述两种形式之一——只要有一个 positional 参数不满足，整个 git 命令 MUST 判 `unreliable_command`
- 命令在 allow-set 内的子命令 MUST NOT 出现多个 positional 参数形式混合时的额外约束（blob 语法与 repo 相对路径可以混用，如 `git diff HEAD~1 src/main.ts`）
- **不在只读子命令 allow-set 内的 git subcommand 不受本 requirement 影响**，MUST 保持既有严格"subcommand 后无 positional"行为：
  - 在 `SILENT_COMMANDS.git` 内但不在本 requirement 只读子命令 allow-set 内（`branch`、`tag`、`remote`、`config`、`ls-files`）：命令级 `isSilentCommand` 返回 `false`，随后走 `extractBashTargets` 的 silent-form 4b 分支——**该分支 MUST 对这类子命令拒绝任何 positional**（`git config user.name Alice`、`git branch foo`、`git tag v1.2.3`、`git ls-files src`、`git remote origin` 均 MUST 判 `unreliable_command`）。这是 Change B 与 silent-form 4b 之间的**必要 gate**——若 4b 未对 `GIT_BLOB_OK_SUBCOMMANDS` 做交集判定，`git config user.name Alice` 会因 positional 匹配 repo 相对路径形态而被误判为 `reliable: true` 0-target，绕过弹窗静默写入 `.git/config`。
  - 完全不在 `SILENT_COMMANDS.git` 内（`fetch`、`pull`、`push`、`clone`、`add`、`commit`、`checkout`、`rm` 等）：命令级 `isSilentCommand` 返回 `false`，silent-form 4b 分支亦返回 `unreliable_command`
- 本 requirement MUST NOT 修改 `SILENT_COMMANDS.git` 的 allow-set 数据（allow-set 内容保持不变）——本 requirement 的效果在 `isSilentCommand` 的 post-subcommand 阶段**以及** `extractBashTargets` silent-form 4b 分支**两处**通过一致的 `GIT_BLOB_OK_SUBCOMMANDS` 交集判定实现

**理由**：git 的 blob 语法天然被 git 自身限制在 repo 内——`git log /etc/passwd` 会被 git 拒绝（`fatal: ... is outside repository`），`git diff /etc/passwd` 同理。因此 extractor 层对 repo 内 blob/相对路径的静默放行是安全的，无需弹窗确认。

#### Scenario: `git blame src/main.ts` 静默

- **WHEN** bash 命令为 `git blame src/main.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`blame` 在 allow-set，`src/main.ts` 是 repo 内相对路径，判静默

#### Scenario: `git blame -L 1,10 src/main.ts` 静默

- **WHEN** bash 命令为 `git blame -L 1,10 src/main.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`-L <range>` 是允许的 flag，`src/main.ts` 是 repo 内相对路径

#### Scenario: `git show HEAD:file.txt` 静默

- **WHEN** bash 命令为 `git show HEAD:file.txt`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`HEAD:file.txt` 是 blob 语法，`HEAD` 是合法 revision

#### Scenario: `git show HEAD:src/main.ts` 静默

- **WHEN** bash 命令为 `git show HEAD:src/main.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；blob 语法的路径部分可以是嵌套路径

#### Scenario: `git diff src/main.ts` 静默

- **WHEN** bash 命令为 `git diff src/main.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`diff` 在 allow-set，`src/main.ts` 是 repo 内相对路径

#### Scenario: `git log HEAD:file.txt` 静默

- **WHEN** bash 命令为 `git log HEAD:file.txt`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；blob 语法

#### Scenario: `git status src/main.ts` 静默

- **WHEN** bash 命令为 `git status src/main.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`status` 在 allow-set，`src/main.ts` 是 repo 内相对路径

#### Scenario: `git rev-parse HEAD:file.txt` 静默

- **WHEN** bash 命令为 `git rev-parse HEAD:file.txt`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；blob 语法

#### Scenario: `git rev-parse HEAD~1` 静默（既有行为回归）

- **WHEN** bash 命令为 `git rev-parse HEAD~1`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`；`HEAD~1` 是合法 revision 表达式

#### Scenario: `git rev-parse HEAD` 静默（既有行为回归）

- **WHEN** bash 命令为 `git rev-parse HEAD`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`

#### Scenario: `git fetch` 仍判不可靠

- **WHEN** bash 命令为 `git fetch`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`fetch` 不在 allow-set

#### Scenario: `git push origin main` 仍判不可靠

- **WHEN** bash 命令为 `git push origin main`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`push` 不在 allow-set

#### Scenario: `git clone https://example.com/repo` 仍判不可靠

- **WHEN** bash 命令为 `git clone https://example.com/repo`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`clone` 不在 allow-set

#### Scenario: `git add src/main.ts` 仍判不可靠

- **WHEN** bash 命令为 `git add src/main.ts`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`add` 是写操作，不在 allow-set

#### Scenario: `git commit -m 'fix'` 仍判不可靠

- **WHEN** bash 命令为 `git commit -m 'fix'`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`commit` 是写操作，不在 allow-set

#### Scenario: `git checkout main` 仍判不可靠

- **WHEN** bash 命令为 `git checkout main`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`checkout` 是写操作，不在 allow-set

#### Scenario: `git log /etc/passwd` 仍判不可靠

- **WHEN** bash 命令为 `git log /etc/passwd`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`/etc/passwd` 是绝对路径，不满足 repo 内相对路径约束

#### Scenario: `git diff /etc/passwd` 仍判不可靠

- **WHEN** bash 命令为 `git diff /etc/passwd`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；绝对路径不满足 repo 内相对路径约束

### Requirement: npm/yarn/pnpm `run <script>` 形式静默放行

系统 SHALL 在 `SILENT_COMMANDS` 的 `npm`、`yarn`、`pnpm` 的 allow-set 支持范围内，除既有的直接形式（`npm test`、`npm lint`、`npm audit`、`yarn test` 等）外，同时接受 `run <script>` 形式，且 `<script>` 名必须在**脚本名白名单** `{test, lint, audit}` 中。

**支持的两种等价形式**：

- **直接形式**（既有，保持不变）：`npm <script>` / `yarn <script>` / `pnpm <script>`，其中 `<script>` ∈ `{test, lint, audit}`
- **run 形式**（本 requirement 新增）：`npm run <script>` / `yarn run <script>` / `pnpm run <script>`，其中 `<script>` ∈ `{test, lint, audit}`

**约束**：

- 脚本名 MUST 是 `{test, lint, audit}` 之一——任何其他脚本名（`build`、`dev`、`publish`、`start`、`prepare`、`pretest`、`unknown` 等）MUST 判 `unreliable_command`
- `npm run -- <script>` 形式（用 `--` 分隔的参数列表）MUST 判 `unreliable_command`——`--` 后的参数是脚本接收的命令行参数而非脚本名，extractor 无法静态确定哪个脚本被调用
- 脚本名后 MUST NOT 跟任何 positional 参数——`npm run test -- --path=/etc/passwd` MUST 判 `unreliable_command`（`--` 后参数被视为脚本参数，不静默）
- `npm`/`yarn`/`pnpm` 的 flag（如 `--workspace=.`、`--cwd=<path>`）MUST NOT 出现——这些命令不识别 flag（不同于 git）
- 本 requirement MUST NOT 修改 `SILENT_COMMANDS.npm/yarn/pnpm` 的 allow-set 数据——allow-set 保持 `{test, lint, audit}`；`run <script>` 形式在 `isSilentCommand` 内部通过额外的模式匹配处理

**理由**：`npm run test` 与 `npm test` 语义完全等价（npm 内部：`npm test` 是 `npm run test` 的 shortcut）；`yarn test` 与 `yarn run test` 同理。允许两种形式等价，让用户的日常开发习惯（无论偏好哪种写法）都能被静默放行。脚本名白名单严格限制为 `{test, lint, audit}` 三个只读脚本名——`build`、`publish`、`dev` 等可能有网络访问、包发布、长时驻留进程等副作用，不在静默范围内。

#### Scenario: `npm run test` 静默

- **WHEN** bash 命令为 `npm run test`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`

#### Scenario: `npm run lint` 静默

- **WHEN** bash 命令为 `npm run lint`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`

#### Scenario: `yarn run test` 静默

- **WHEN** bash 命令为 `yarn run test`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`

#### Scenario: `pnpm run audit` 静默

- **WHEN** bash 命令为 `pnpm run audit`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`

#### Scenario: `npm run build` 仍判不可靠

- **WHEN** bash 命令为 `npm run build`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`build` 不在脚本名白名单

#### Scenario: `npm run publish` 仍判不可靠

- **WHEN** bash 命令为 `npm run publish`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`publish` 不在脚本名白名单

#### Scenario: `npm run dev` 仍判不可靠

- **WHEN** bash 命令为 `npm run dev`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`dev` 不在脚本名白名单

#### Scenario: `npm run -- scriptName` 仍判不可靠

- **WHEN** bash 命令为 `npm run -- scriptName`
- **THEN** 提取结果为 `{ reliable: false, reason: "unreliable_command" }`；`--` 形式无法静态确定脚本名

#### Scenario: `npm test` 直接形式静默（既有行为回归）

- **WHEN** bash 命令为 `npm test`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——直接形式不受本 requirement 影响，仍按既有 allow-set 处理
