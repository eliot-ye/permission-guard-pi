## Context

See proposal.md for motivation. 当前 `src/lib/bash-extract.ts` 的解析链顺序为：`scanFindWriteFlags` → `scanUnreliable`（含命令替换/子进程/here-doc/glob/子 shell 检测）→ `scanControlFlow`（含字面量 `for` 循环豁免）→ `isShellForwarder` → `isAnyUnreliableCommand` → `isSilentCommand` 表单检查 → 变量解析 → 目标提取。`extensions/index.ts` 在拿到 `ExtractResult` 后按 target 走 `decideTarget`，最终由 `decision.ts` 的 `decide()` 判定 tier。

三个 P0 绕过点分别落在不同环节：L1/L2 在 `isShellForwarderTokenStream`（`SHELL_NAMES` 分支的长参数与外层 wrapper 处理），L3 在复合命令的 `cd` 语义处理（当前无处理）。两个 P1 决策层缺口在 `sensitive.ts` 的规则表与 `decision.ts` 的敏感路径 fallback 分支。

`src/lib/bash-extract.ts` 是约 3300 行的单体文件，已含 `SHELL_WRAPPER_NAMES`、`SHELL_NAMES`、`SUBSTITUTION_READONLY_CMDS`、`FIND_WRITE_FLAGS` 等常量集合与 `isShellForwarderTokenStream` / `isLiteralForLoop` / `parseGlobForLoop` 等解析函数。本设计沿用其风格与命名，不引入新模块。

## Goals / Non-Goals

**Goals:**

- 封堵三类 P0 静默放行绕过（L1 长参数前缀、L2 外层包装器、L3 `cd` cwd 变更），使 `bash --posix -c '...'`、`sudo bash -c '...'`、`cd /etc && rm -rf .` 均被分类为 unreliable 并触发 tier=two 提示。
- 补齐两类 P1 决策层保护（L4a 系统机密文件敏感名单、L4b 网络外带路径强制 tier=two），使 `/etc/shadow` 等系统机密文件读取和 `/dev/tcp/*` 等网络外带写入不再是"静默放行 / 可持久化"。
- 保持既有 `ExtractResult` 与 `Decision` 契约不变，让 `extensions/index.ts` 集成层零改动。
- 为每类修复在 `test/security-probe.mjs` 追加回归用例，锁定行为。

**Non-Goals:**

- 不做降噪类工作（`for`-bounded-glob 只读循环静默、guardrails 文案对齐、`find -not -path` 冗余目标消除）——已在 TODO 池 backlog，独立 propose。
- 不重构 `src/lib/bash-extract.ts` 的单体结构（虽已 3300 行，但拆分不在本次范围内；重构会放大变更面，与 brownfield "改老代码前 human-in-loop 最小化"原则相悖）。
- 不引入新的 reason 字符串到既有集合（复用 `shell_forwarder` 作为 L1/L2 的 reason；仅 L3 引入新 reason `cd_chdir`）。
- 不修改 `trusted.json` 的持久化 schema、不改 JSONC 配置文件格式、不改审计日志字段。
- 不调整 `SUBSTITUTION_READONLY_CMDS` 的白名单内容（既有 change `bash-substitution-readonly-exemption` 已确定，本次不动）。

## Decisions

### D1 — L1 修复：`isShellForwarderTokenStream` 长参数不再 `break`

**决策**：`SHELL_NAMES` 分支的参数扫描循环中，遇到 `arg.startsWith("--")` 从 `break` 改为 `continue`（跳过该长参数继续向后扫描）；同时保留 `-c` / 选项簇（`-/c` 后接 c）/ 非 flag 位置参数（脚本路径）三个触发条件。

**理由**：
- bash / sh / dash / zsh 的长参数（`--posix`、`--norc`、`--noprofile`、`--rcfile FILE` 等）合法且常见，`bash --posix -c '...'` 在 POSIX 模式下等价于 `bash -c '...'`。当前实现遇到长参数就退出扫描，导致后续的 `-c` 从未被看到。
- `continue` 而非 `break` 让扫描器继续看后续参数，覆盖 `-c`、`-xc`（选项簇）、脚本路径三种触发条件。
- 保留 `--` 之前的所有触发条件不改变既有 `bash -c '...'` / `bash /tmp/x.sh` 的判定结果。

**替代方案**：
- **A（采纳）**：`continue` 跳过长参数继续扫描。
- **B**：显式列出已知 bash 长参数白名单，只有白名单外的 `--` 参数才 `break`。放弃理由：bash 长参数集合庞大且随版本增加（`--posix` / `--norc` / `--noprofile` / `--rcfile` / `--help` / `--version` / `--login` 等），维护成本高，且"白名单外的 `--` 参数"仍需要继续扫描而非 break——本质上回到 A 的语义。
- **C**：把长参数视作 shell forwarder 的直接证据（遇 `--` 就 return true）。放弃理由：过度激进，`bash --version` 只是打印版本，不是 forwarder。

### D2 — L2 修复：`SHELL_WRAPPER_NAMES` 扩展外层包装器

**决策**：向 `SHELL_WRAPPER_NAMES` 常量集合追加 `sudo`、`nohup`、`timeout`、`watch`、`nice` 五个常见外层包装器名。`skipWrapperTokens` 对 wrapper 的通用跳过逻辑（`KEY=VAL` 赋值 + `--flag` + 短 flag 值）已能正确处理这五个包装器的常见形式（`sudo bash -c '...'`、`nohup bash /tmp/x.sh`、`timeout 5 bash -c '...'`、`watch bash -c '...'`、`nice -n 10 bash -c '...'`）。

**理由**：
- 这五个命令在 shell 生态里是常见外层包装器，用于改变进程上下文（提权 / 忽略 SIGHUP / 限时 / 定时循环 / 调整优先级），不改变内层命令的语义。
- `skipWrapperTokens` 的通用逻辑（跳过 KEY=VAL、`--flag`、短 flag + 值）足以覆盖这五个包装器的常见参数形式。`timeout 5 bash -c '...'` 中的 `5` 是位置参数而非 flag，`skipWrapperTokens` 会把它当实际命令而 return——需要单独处理。见 D2.1。
- 保持集合最小：不加入 `bg`、`fg`、`time`、`wait` 等 bash 内建，也不加入 `env`（已在既有集合）以外的通用工具。

**替代方案**：
- **A（采纳）**：扩展现有 `SHELL_WRAPPER_NAMES`。
- **B**：新增独立的 `OUTER_WRAPPER_NAMES` 集合与单独的 `skipOuterWrapper` 函数。放弃理由：语义上完全等价于扩展 `SHELL_WRAPPER_NAMES`，增加代码冗余。
- **C**：把外层包装器视作 unreliable_command（直接触发 tier=two）。放弃理由：过度激进，`sudo` / `nohup` / `timeout` 本身不是不安全命令，只是不改变内层语义；把它们全部判为 unreliable 会让用户被误报。

**D2.1 — `timeout` / `nice` 的位置参数处理**：
- `timeout 5 bash -c '...'` 中的 `5` 是 timeout 的持续时间（位置参数，非 flag）。当前 `skipWrapperTokens` 只跳过 `KEY=VAL` / `--flag` / 短 flag + 值，遇到非 flag 位置参数会 return——把 `5` 当作实际命令。
- 修复：在 `skipWrapperTokens` 中为 `timeout` 与 `nice` 特殊处理——`timeout` 接受"持续时间 + 命令"形式，`nice` 接受 `-n LEVEL + 命令` 形式。具体实现：
  - 若 wrapper 名为 `timeout`：跳过第一个位置参数（持续时间，如 `5`、`1m`、`1h`），继续扫描。
  - 若 wrapper 名为 `nice`：显式识别 `-n` 为取值短 flag，消费 2 个 token（`-n` + `LEVEL`）。**注意**：当前 `skipWrapperTokens` 的"其他短 flag"分支（line 2927 `i += 1; continue`）不识别 `-n` 为取值 flag，只消费 1 个 token，`LEVEL` 会被当位置参数 break——`isShellForwarderTokenStream` 随后拿到 `base = "10"`，既非 `SHELL_NAMES` 也非 `source`/`.`，返回 false。因此必须在 `skipWrapperTokens` 中显式加入 `nice -n` 的取值识别，不能只依赖"通用短 flag + 值"逻辑。
- 其他三个 wrapper（`sudo` / `nohup` / `watch`）的位置参数直接是命令名，不需要特殊处理。

**跨守卫传播**：`SHELL_WRAPPER_NAMES` 被两个守卫共用——`isShellForwarderTokenStream`（`src/lib/bash-extract.ts:2970`）与 `isAnyUnreliableCommand`（`src/lib/bash-extract.ts:1723`）。扩展集合会让 `sudo sed -i ...`、`sudo python3 ...` 等命令被识别为"外层 sudo 包装 + 内层 sed/python3"，内层命令命中 `UNRELIABLE_COMMANDS` 返回 true——**净效果是新行为**（原本静默，现判 `unreliable_command`）。方向上"收窄"符合安全目标，但作者在 caller impact 分析中必须明确列出这一跨守卫影响。

### D3 — L3 修复：`cd` 语义判 unreliable

**决策**：在 `extractBashTargets` 的 `scanControlFlow` 之后、`isShellForwarder` 之前，新增一个 `scanCdChdir` 检查——若命令中任一复合命令片段的首个 token（basename）为 `cd`，返回 `{ reliable: false, reason: "cd_chdir" }`。

**理由**：
- `cd` 是 bash 内建，会改变后续所有相对路径命令的 cwd 基准。当前实现把相对路径的解析基准固定为 `projectRoot`（见 `toAbsolutePath(path, projectRoot)`），完全忽略 `cd` 的实际效果。`cd /etc && rm -rf .` 中的 `.` 被解析为 `<projectRoot>/.` 而不是 `/etc/`，实际执行会删除 `/etc` 内容。
- 把整条含 `cd` 的复合命令判为 unreliable 是最小侵入的修复：不改路径解析器、不改 `looksLikePath`、不改任何 extractor 的语义。代价是"含 `cd` 的合法命令"（如 `cd src && ls`）也会触发 tier=two 提示——这个代价可接受，因为 `cd` 出现在 bash 命令里本身就是"想改变 cwd 上下文"的信号，值得用户确认。
- 单命令 `cd /etc`（不含 `&&` / `;`）不判 unreliable：单纯 cd 不产生文件访问，静默放行。判定条件是"复合命令中含 cd 片段"，而非"任何含 cd 的命令"。

**替代方案**：
- **A（采纳）**：含 cd 片段的复合命令整条 unreliable。
- **B**：把 `cd` 的后续命令片段中所有相对路径都按 cd 后的目标解析。放弃理由：需要构建完整的 cd 目标跟踪器（含 `cd -`、`cd`（无参回到 HOME）、`cd ..`、`cd ~` 等语义），实现复杂且容易漏 case；即使实现完整，也无法覆盖 `cd $(dirname $file)` 这类动态 cd 目标。
- **C**：把 `.` 加入 `looksLikePath`（让 `rm -rf .` 产生 delete 目标）。放弃理由：`.` 的语义在 `cd` 后完全不同，无法在 extractor 内区分；且加入后会导致 `cd src && ls` 中的 `.` 产生大量 spurious 目标。

**新 reason 字符串 `cd_chdir` 的处理**：
- `extensions/index.ts` 的 `bashPermissionForReason` 与 `bashSubtitleForReason` 需要在 switch 里增加 `cd_chdir` 分支，返回 `read_write` 权限（因为 cd 后的实际 cwd 未知，可能是任意目录）与合适的提示文案。
- 这是本次 change 唯一引入的新 reason 字符串，caller 影响已在 proposal 的 caller impact 分析节标注。

### D4 — L4a 修复：`sensitive.ts` 新增系统机密文件规则

**决策**：在 `DEFAULT_SENSITIVE_RULES` 数组尾部追加一条新规则，test 函数匹配以下路径（basename 精确匹配 + 目录前缀匹配）：
- `/etc/shadow`、`/etc/sudoers`、`/etc/master.passwd`（macOS 用户密码哈希文件）
- `/etc/crontab`、`/etc/cron.d/*`、`/etc/cron.hourly/*`、`/etc/cron.daily/*`、`/etc/cron.weekly/*`、`/etc/cron.monthly/*`（cron 调度配置）
- `/etc/hosts.allow`、`/etc/hosts.deny`（TCP Wrappers 访问控制）

reason 字段设为 `"System credential/config file"`（与既有 reason 命名风格一致：`SSH key file` / `Private key / certificate file` / `Env file or credential store` / `Credential config`）。

**理由**：
- 这十个路径是常见 Unix 系统机密文件，泄露后可能导致提权或横向移动。
- 匹配规则用 basename + 目录前缀组合，与既有 SSH 密钥规则的匹配风格一致（`b === "known_hosts"` / `d.endsWith("/.ssh")`）。
- 追加到数组尾部而非头部：既有规则的匹配顺序不变，前向兼容——所有既有 caller 的敏感路径判定结果不变，只新增这十条路径。
- 不加入 `/etc/passwd`：`passwd` 是公开用户列表，只含非敏感信息（用户名 / UID / GID / home / shell），泄露不影响安全。加入会引入大量误报。

**替代方案**：
- **A（采纳）**：追加 basename 精确匹配规则。
- **B**：把所有 `/etc/**` 视为敏感。放弃理由：过度激进，`/etc/hosts` / `/etc/hostname` 等公开配置文件会被误报。
- **C**：不修改 sensitive.ts，把 dev-socket 与系统机密文件合并成一条新规则。放弃理由：语义混杂，sensitive.ts 是路径分类器，dev-socket 属于决策层 tier 判定（见 D5），职责不应合并。

### D5 — L4b 修复：`decision.ts` dev-socket 写入强制 tier=two

**决策**：在 `decide()` 的敏感路径 fallback 分支（`if (sensitive) { ... }`）之前，插入一个 dev-socket 写入检查——若 `action === "write"` 且 `absPath` 匹配 `/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+`（复用 `bash-extract.ts` 已导出的 `isDevSocketOrFd` 函数），返回 tier=two 的 prompt 决策，reason 为 `"Network exfiltration path: ${absPath}"`。

**理由**：
- `bash-extract.ts` 的 `extractRedirects` 已经把 `/dev/tcp/*`、`/dev/udp/*`、`/dev/fd/[0-9]+` 作为普通写目标产出（既不豁免也不敏感判定），当前决策层把它们当作"外部非敏感写入"→ tier=three 提示，用户勾选"Always allow"后可被持久化——后续 `/dev/tcp` 外带命令无提示通过。
- 强制 tier=two 关闭持久化通路：用户必须每次确认，不能"Always allow"。
- 复用 `isDevSocketOrFd`：`bash-extract.ts` 已导出该函数，`decision.ts` 直接 import 使用，避免规则重复定义。
- 位置在敏感路径 fallback 之前：dev-socket 路径通常不会命中 sensitive.ts 的规则（它们不是文件），提前返回 tier=two 更清晰。
- 只针对写入操作（`action === "write"`）：`/dev/tcp` 用于写入（外带），`/dev/fd/[0-9]+` 用于双向（但写入是主要风险）。读取不拦截（避免误报，读取 `/dev/fd/3` 通常是无害的 fd 复用）。

**替代方案**：
- **A（采纳）**：在 `decide()` 内插入 dev-socket 检查分支。
- **B**：在 `sensitive.ts` 新增 dev-socket 规则。放弃理由：职责混乱，sensitive.ts 是路径分类器（判断"是否是敏感文件"），dev-socket 不是"文件"而是"网络外带通道"，属于决策层 tier 判定范畴。
- **C**：在 `extensions/index.ts` 的 `handleBash` 内对 dev-socket target 做特殊处理。放弃理由：集成层不应包含决策逻辑（既有约定：决策逻辑在 `decision.ts` 的纯函数里）。
- **D**：在 `bash-extract.ts` 的 `extractRedirects` 内直接豁免 dev-socket 路径（当作无害 `/dev/null` 处理）。放弃理由：过度宽容，dev-socket 是网络外带通道，静默放行是安全问题。

### D6 — 测试策略：TDD + security-probe 追加

**决策**：
- 每个修复点在实施前先在 `test/` 下追加失败用例（RED），再实现修复（GREEN），最后重构（REFACTOR）。
- L1/L2/L3 的 payload 用例追加到 `test/security-probe.mjs`（沿用既有探针风格），锁定回归。
- L4a/L4b 的用例追加到 `test/sensitive.test.ts` 与 `test/decision.test.ts`（沿用既有单测风格）。

**理由**：
- TDD 是项目既有约定（config.yaml 的 Conventions 节声明），brownfield profile 下新代码强制 TDD。
- `security-probe.mjs` 是既有的安全回归探针，追加 L1/L2/L3 用例可以复用其 payload 表结构与 exit code 契约。
- L4a/L4b 是决策层改动，用既有单测框架覆盖即可。

## Risks / Trade-offs

- **[L3 误报合法 cd 命令]** → 缓解：`cd src && ls` 等合法命令会触发 tier=two 提示，但这是"含 cd 的复合命令"的统一策略——用户确认一次后即可 session/persistent 记忆。若误报过多，可在后续 change 中收窄为"cd 后接写入命令"才 unreliable（本次不做，避免过度设计）。
- **[L2 wrapper 集合过窄]** → 缓解：本次只加入五个最常见的外层包装器；若后续发现其他 wrapper（如 `pv`、`stdbuf`、`flock`）绕过，可在下一个 change 中扩展集合。判定标准："是否改变内层命令的语义"——不改变的 wrapper 才纳入，改变的（如 `pv` 读取输入数据）不纳入。
- **[L4a 系统机密名单过窄]** → 缓解：本次只加入十个最常见路径；`/etc/ld.so.preload`、`/etc/security/`、`/etc/pam.d/` 等可后续扩展。判定标准："是否含敏感凭据 / 提权入口"——含的才加入。
- **[L4b dev-socket 检查性能]** → 缓解：`isDevSocketOrFd` 是 O(1) 的前缀匹配，零开销；非 dev-socket 路径直接跳过检查。
- **[caller 影响：`test/bash-extract.test.ts` 可能断言旧的静默放行行为]** → 缓解：实施前 grep `test/bash-extract.test.ts` 与 `test/decision.test.ts`，定位可能受影响的既有用例，按新语义更新断言（不删除既有覆盖点，只调整预期值）。
- **[决策层职责边界争议]** → 缓解：D5 的替代方案讨论已记录"为什么在 decision.ts 而非 sensitive.ts / extensions/index.ts"，架构 review 时如仍有争议，可通过新增 `src/lib/network-egress.ts` 拆分职责（不在本次范围内）。

## Migration Plan

- **无迁移**：本次 change 是纯增量修复，不涉及 JSONC 配置格式、trusted.json schema、审计日志字段、CLI 参数等公共契约的变更。既有用户的 `permission.json` 与 `trusted.json` 无需修改。
- **回滚策略**：每个修复点独立可回滚（L1/L2/L3 在 `bash-extract.ts`，L4a 在 `sensitive.ts`，L4b 在 `decision.ts`），回滚单个修复点不会影响其他修复点。回滚操作：`git revert <commit>`。
- **部署顺序**：一次 commit 提交全部修复点（不分多次），便于回滚粒度控制。

## Open Questions

- 无。所有决策点在 explore 阶段已闭合（b1=a1 / b2=独立 / b3=纳入 / b4=落池），本设计文档不涉及需用户拍板的开放问题。
