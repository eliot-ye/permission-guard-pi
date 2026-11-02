## MODIFIED Requirements

### Requirement: 有界 glob 免不可靠标记

当未加引号的 glob 通配符（`*`、`?`、`[`）满足以下全部条件时，MUST NOT 触发"不可靠"标记（即不再因 glob_expansion 走 tier=three 弹窗），而是交给后续正常提取流程按 read/write target 处理：

1. 该 glob 元字符出现在**引号外且未被反斜杠转义**的位置（遵循现有引号感知规则）
2. glob 元字符前的路径前缀（从命令起始到 glob 元字符之前的路径片段）MUST 完全位于 `<projectRoot>` 内部（不含 `../` 越界）。**例外（空前缀）**：当 glob 前缀为空（glob 是 token 整体，如 `*.md`）时，若满足以下任一情形，空前缀 MUST 视为 bounded（cwd == projectRoot 假设下，cwd-relative glob 展开于 projectRoot 内）；否则空前缀仍视为出界（无路径上下文可绑定）：
   - **情形 A（for 循环迭代集）**：glob 出现在 for 循环迭代集内（见条件 3c）且 glob 是迭代词整体（如 `for x in *.log; do ...`），且迭代词不以 `/`、`~` 或 Windows 盘符（`C:\`）开头
   - **情形 B（只读命令）**：glob 所在的 pipeline stage 的首命令满足条件 3 的只读判定（见下方条件 3），且该 glob 不以 `/`、`~` 或 Windows 盘符（`C:\`）开头——即命令是 read-only 时，cwd-relative 空 prefix glob 视为 bounded 于 projectRoot
   - 若迭代词/glob 以 `/`、`~` 或 Windows 盘符开头，空前缀仍视为出界（绝对路径前缀无法 bounded 于 projectRoot）
3. glob 所在的 pipeline stage 的首命令（command name）**及其参数** MUST 共同构成"只读"命令。判定采用**析取式**：满足以下任一条件即判为只读——
   - **条件 3a**：命令名属于 READ_ONLY_COMMANDS（`cat`/`head`/`tail`/`wc`/`grep`/`ls`/`tree`/`stat`/`du`/`df`/`file`/`less`/`more`/`git log` 等）——命令名属于集合即视为只读，不看参数
   - **条件 3b**：命令名为 `find` 且通过"find 的参数条件性只读判定"（见下方"find 的参数条件性只读判定"节）
   - **条件 3c**：命令名为 `for` 且该 stage 是一个结构完整的 for 循环（`for VAR in WORDS; do BODY; done`）且迭代集 WORDS 中包含至少一个未加引号的 glob 元字符且 BODY 通过"for 循环体只读判定"（见下方"for 循环体只读判定"节）——**本 change 新增（前序 change 引入）**
   - 命令名既不属于 READ_ONLY_COMMANDS、也不是 `find`、也不满足条件 3c 的 `for` 时，条件 3 不满足

**find 的参数条件性只读判定**：当命令名为 `find` 时，MUST 检查其所有参数——若任一参数是以下写操作标志之一，MUST NOT 判为只读（glob 判定条件 3 不满足）：

- `-delete`（就地删除匹配文件）——始终判写，不看载荷
- `-exec`（对匹配文件执行任意命令）——**载荷感知（payload-aware）**：`-exec` 后的载荷命令名（`;` 或 `+` 终止符之前的首个非 flag token）属于 READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS 时，该 `-exec` 不判写；否则判写
- `-execdir`（在匹配文件所在目录执行任意命令）——**载荷感知**：判定同 `-exec`
- `-ok`（交互式对匹配文件执行任意命令）——始终判写（交互式，无法静态确定用户答复）
- `-okdir`（交互式在匹配文件所在目录执行任意命令）——始终判写（交互式，无法静态确定用户答复）

`-exec`/`-execdir` 的**载荷命令名**按以下规则确定，任一不满足则维持判写（fail-closed）：

1. 载荷命令名是 `-exec`/`-execdir` 之后到终止符（`;` 或 `+`）之前的首个 token；token 以 `/` 开头时取 basename（`/bin/cat` → `cat`）
2. 载荷命令名在终止符之前**必须存在**且不是 `{}`、不是 flag（以 `-` 开头）——`find . -exec {} \;`、`find . -exec \;` 均判写
3. 载荷命令名属于 READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS → 不判写；否则（`rm`/`sh`/`bash`/`xargs`/`eval`/`chmod`/`mv`/未知命令等）→ 判写

`find` 的其他参数（`-name`/`-type`/`-size`/`-mtime`/`-user`/`-group`/`-newer`/`-newermt`/`-maxdepth`/`-mindepth` 等 100+ 个过滤条件）MUST 视为不改变 `find` 的只读性质。

**for 循环体只读判定**：当命令名为 `for` 且条件 3c 的前置（结构完整 + 迭代集含 glob）满足时，MUST 检查该 for 循环的 BODY 是否只读。BODY 的只读判定复用"字面量 for 循环豁免"requirement 中的 BODY 只读规则——BODY 里的每条命令都必须是 read-only（READ_ONLY_COMMANDS 集合、SILENT_COMMANDS、HARMLESS_BUILTINS，或 `find` 且通过 find 的参数条件性只读判定），**或变量赋值形态（`VAR=...`，其中右侧为纯字面量，或右侧经"命令替换内只读命令豁免"requirement 判定为只读的 `$(...)`）**——本 change 新增赋值形态识别。

**理由**：`for` 循环的迭代集 glob（如 `for d in openspec/specs/*/; do ls "$d"; done`）在实际文件访问上等价于 shell 展开后的 `ls openspec/specs/1/ openspec/specs/2/ ...`——展开的目标集合完全位于项目内（因为 glob 前缀被条件 2 限定在项目内），且循环体只做 read-only 操作（通过条件 3c 的 BODY 只读判定）。原实现把 `for` 当作"不在 READ_ONLY_COMMANDS"的普通命令处理，导致迭代集内的 glob 被 `scanUnreliable` 提前触发 `glob_expansion`，永远走不到 `scanControlFlow` 的字面量 for 循环豁免。本条件 3c 直接在 `isBoundedGlobSafe` 层面处理该情形，避免 `scanUnreliable` 与 `scanControlFlow` 的短路冲突。

**find 载荷感知（payload-aware）判定的理由（前序 change 引入）**：原实现把 `-exec`/`-execdir` 一律判写——即使载荷命令是 `cat`/`wc`/`grep` 这类已知只读命令（`find . -name '*.ts' -exec cat {} \;` 对匹配文件仅读取，无写副作用）。实测确认本项目对该形态判 `find_write_flag`（误报），与宿主 bash 审批层的同类弹窗一致。本 change 在「载荷命令名 ∈ READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS」这一窄条件下放宽，写载荷（`rm`）、未知载荷（`sh`/`bash`/`xargs`）、`{}` 直接执行、`+` 终止、交互式 `-ok`/`-okdir` 均维持判写（fail-closed）。放宽不弱化对真实写操作的保守判定，属局部优化且不全局失调。

**空 prefix 放宽的理由（前序 change 引入）**：条件 2 原本要求 glob 前缀完全位于 projectRoot 内部，并显式拒绝空 prefix（"Empty prefix means the glob is at token start"）。前序 change 引入两处情形 A/B 的放宽：

- **情形 A（for 循环迭代集）**：对 for-loop 迭代集内的空 prefix glob（如 `for x in *.log; do wc -l "$x"; done`），迭代词 `*.log` 是 cwd-relative 的——shell 在 cwd 展开，cwd == projectRoot 假设下展开结果完全 bounded 于 projectRoot。原实现对该形态误判 `glob_expansion`，导致用户在项目根下运行只读 for 循环被弹窗打断。该情形在既有 spec 已有覆盖，此处保留。
- **情形 B（只读命令）**：对非 for-loop 路径的空 prefix glob（如 `ls *.md`、`ls *`），当命令只读（条件 3 满足）且 glob 不以绝对路径标志开头时，空前缀视为 cwd-relative 并 bounded 于 projectRoot——cwd == projectRoot 假设下，`ls *.md` 展开结果完全位于项目内，且命令只读，无写副作用风险。原实现对 `ls *.md` 误判 `glob_expansion`，导致用户顺手列文件被弹窗打断。情形 B 仅在该窄条件放宽：(1) 命令只读；(2) 前缀为空；(3) glob 不以绝对路径标志开头。三重约束保证放宽范围极窄，不影响绝对路径前缀（`/etc/*.conf` 仍拒绝）或写命令（`rm *.log` 仍拒绝）的判定。

**边界**：
- 条件 3c 只在迭代集**含 glob** 时适用；不含 glob 的字面量 for 循环（如 `for i in a b c`）走"字面量 for 循环豁免"requirement
- BODY 内 glob 的判定不在本条件 3c 范围内——BODY 内的 glob 仍走常规 bounded-glob 判定，因为 BODY 内的 glob 前缀通常含 `$VAR`（`"$d"/*.md`），其前缀无法静态解析到具体路径，仍判 `glob_expansion`。这是与"字面量 for 循环豁免"requirement 保持一致的保守判定
- for 循环结构不完整（无 `do`、无 `; done`）时，条件 3c 不满足
- 空 prefix 放宽（情形 A/B）仅适用于 glob 不以绝对路径标志开头；以 `/`、`~`、`C:\` 开头的 glob（如 `/etc/*.conf`）仍拒绝
- **情形 B 与条件 3 的耦合**：情形 B 的放宽判定**要求条件 3 的只读判定通过**——若命令是写命令（`rm`、`tar`、`mv` 等），条件 3 不满足，空 prefix glob 仍判 `glob_expansion`（写命令的空 prefix glob 无法静态确定目标集合，且可能删除/写入未知文件）
- **赋值形态的判定边界（本 change 新增）**：`VAR=...` 赋值仅当右侧为纯字面量（`n=5`）或右侧 `$(...)` 通过"命令替换内只读命令豁免"时视为只读；右侧含未知命令/写操作/未绑定路径时，赋值命令不满足只读，整条 BODY 判非只读（fail-closed）

**反例（仍触发 glob_expansion）**：
- glob 前缀出界（如 `for d in ../other/*; do ls "$d"; done`、`for d in /tmp/*; do cat "$d"; done`）
- BODY 含写操作（如 `for d in openspec/*/; do rm "$d"; done`、`for x in *.log; do rm "$x"; done`）
- BODY 含非只读命令（如 `for d in openspec/*/; do curl "$d"; done`）
- for 循环结构不完整（如 `for d in openspec/*/; do ls "$d"` 无 `; done`）
- 迭代集全字面量（如 `for i in a b c; do echo "$i"; done`）——本条件不适用，走"字面量 for 循环豁免"requirement
- `find` 含写操作参数（如 `find src/ -name "*.bak" -delete`、`find . -name "*.log" -exec rm {} \;`）——`-delete` 始终判写；`-exec rm` 载荷 `rm` 是写载荷，判写
- `find -exec`/`-execdir` 载荷命令名不在 READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS（如 `find . -exec sh -c 'rm $1' _ {} \;`、`find . -exec chmod 600 {} \;`）
- `find -exec`/`-execdir` 载荷命令名缺失或为 `{}`/flag（如 `find . -exec {} \;`、`find . -exec \;`）
- 空 prefix 迭代词以绝对路径标志开头（如 `for f in /etc/*.conf; do cat "$f"; done`、`for f in ~/*.conf; do cat "$f"; done`）
- **情形 B 的写命令空 prefix glob**（如 `rm *.log`、`tar xzf *.tgz`）——命令不满足条件 3 只读判定，空 prefix 放宽不适用，仍判 `glob_expansion`
- **情形 B 的绝对路径前缀 glob**（如 `ls /etc/*.conf`、`ls ~/*.md`）——glob 以绝对路径标志开头，情形 B 不适用

**命令片段上下文**：条件 3 中的"pipeline stage 的首命令及其参数"按以下方式确定——先把整条命令按"命令分隔符"（见"管道按 stage 独立提取"requirement）拆为多个**命令片段**，再把每个命令片段按顶层 `|` 拆为多个 pipeline stage；条件 3 判定的是"包含该 glob 的那个 pipeline stage 的首命令及其参数"，属于哪个命令片段不影响其他片段。

#### Scenario: 项目内 ls glob 自动放行

- **WHEN** bash 命令为 `ls openspec/changes/archive/*/`，projectRoot 为 `/Users/eliot/my/permission-guard-pi`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/permission-guard-pi/openspec/changes/archive/] }`（按前缀目录读处理），不触发 glob_expansion

#### Scenario: 项目内 cat glob 自动放行

- **WHEN** bash 命令为 `cat openspec/specs/*/spec.md`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/permission-guard-pi/openspec/specs/] }`，不触发 glob_expansion

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
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`-exec` 载荷 `rm` 是写载荷（不在 READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS），判写，条件 3 不满足

#### Scenario: `find -execdir` 在 glob 上下文触发 glob_expansion

- **WHEN** bash 命令为 `find src/ -name "*.log" -execdir cat {} \;`
- **THEN** 提取结果为 `{ reliable: true }`——`-execdir` 载荷 `cat` 属于 READ_ONLY_COMMANDS，载荷感知判定不判写，条件 3 满足（本 change：场景名沿用既有 anchor，行为从误判 glob_expansion 修正为只读载荷放行）

#### Scenario: `find -ok` 在 glob 上下文触发 glob_expansion

- **WHEN** bash 命令为 `find src/ -name "*.tmp" -ok rm {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`-ok` 是交互式写操作 flag，始终判写

#### Scenario: `find -exec cat` 只读载荷自动放行

- **WHEN** bash 命令为 `find src/ -name "*.tmp" -exec cat {} \;`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——`-exec` 载荷 `cat` 属于 READ_ONLY_COMMANDS，载荷感知判定不判写，条件 3 满足（前序 change 新增：原实现误判 glob_expansion）

#### Scenario: `find -exec wc` 只读载荷自动放行

- **WHEN** bash 命令为 `find src/ -name "*.log" -exec wc -l {} \;`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——`-exec` 载荷 `wc` 属于 READ_ONLY_COMMANDS，不判写（前序 change 新增）

#### Scenario: `find -execdir cat` 只读载荷自动放行

- **WHEN** bash 命令为 `find src/ -name "*.log" -execdir cat {} \;`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——`-execdir` 载荷 `cat` 属于 READ_ONLY_COMMANDS，不判写（前序 change 新增：原实现误判 glob_expansion）

#### Scenario: `find -exec cat {} +` 加号终止只读载荷自动放行

- **WHEN** bash 命令为 `find src/ -name "*.ts" -exec cat {} +`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——`+` 终止符与 `;` 等价处理，载荷 `cat` 属于 READ_ONLY_COMMANDS，不判写（前序 change 新增）

#### Scenario: `find -exec echo` HARMLESS 载荷自动放行

- **WHEN** bash 命令为 `find src/ -name "*.tmp" -exec echo {} \;`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——载荷 `echo` 属于 HARMLESS_BUILTINS，不判写（前序 change 新增）

#### Scenario: `find -exec sh -c` 载荷仍触发 glob_expansion

- **WHEN** bash 命令为 `find src/ -name "*.tmp" -exec sh -c 'rm "$1"' _ {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——载荷 `sh` 不在 READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS（shell 转发器，可执行任意命令），判写（前序 change 新增反例）

#### Scenario: `find -exec {}` 无命令载荷仍触发 glob_expansion

- **WHEN** bash 命令为 `find src/ -name "*.tmp" -exec {} \;`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`-exec` 后无载荷命令名（首个 token 是 `{}`），判写（前序 change 新增反例）

#### Scenario: 写命令内的 glob 仍触发 glob_expansion

- **WHEN** bash 命令为 `rm -rf /tmp/build/*.log`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`rm` 不在 read-only 命令集合

#### Scenario: 跨项目边界的 glob 仍触发 glob_expansion

- **WHEN** bash 命令为 `ls ../other-project/*/`，projectRoot 为 `/proj`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——前缀 `../other-project/` 出界

#### Scenario: git log 带路径 glob 自动放行

- **WHEN** bash 命令为 `git log --oneline openspec/specs/*/spec.md`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/permission-guard-pi/openspec/specs/] }`，不触发 glob_expansion

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

#### Scenario: for 循环迭代集 glob + read-only body 自动放行

- **WHEN** bash 命令为 `for d in openspec/specs/*/; do ls "$d"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——迭代集 glob 前缀 `openspec/specs/` 在项目内（条件 2 满足），`for` 循环体 `ls "$d"` 是 read-only（条件 3c 满足），不触发 glob_expansion

#### Scenario: for 循环迭代集 glob 前缀出界仍触发 glob_expansion

- **WHEN** bash 命令为 `for d in /etc/*/; do ls "$d"; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——迭代集 glob 前缀 `/etc/` 在 projectRoot 之外，条件 2 不满足

#### Scenario: for 循环迭代集 glob + write body 仍触发 glob_expansion

- **WHEN** bash 命令为 `for d in openspec/specs/*/; do rm "$d"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——循环体 `rm "$d"` 是写操作，条件 3c 不满足

#### Scenario: for 循环迭代集 glob + cat body 自动放行

- **WHEN** bash 命令为 `for d in openspec/specs/*/; do cat "$d"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——循环体 `cat "$d"` 是 read-only，条件 3c 满足

#### Scenario: for 循环迭代集 glob + echo body 自动放行

- **WHEN** bash 命令为 `for d in openspec/specs/*/; do echo "$d"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——循环体 `echo "$d"` 是 HARMLESS_BUILTINS，条件 3c 满足

#### Scenario: for 循环迭代集 glob + 多命令只读 body 自动放行

- **WHEN** bash 命令为 `for f in openspec/changes/archive/*/; do echo "=== $f ==="; grep -n "^## " "$f"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——循环体两条命令 `echo` 与 `grep -n "^## "` 都是 read-only/HARMLESS，条件 3c 满足

#### Scenario: for 循环迭代集 glob + body 含 glob 仍触发 glob_expansion

- **WHEN** bash 命令为 `for d in openspec/specs/*/; do ls "$d"/*.md; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——BODY 内的 glob（`"$d"/*.md`）前缀含 `$d` 无法静态解析，仍判 glob_expansion

#### Scenario: for 循环结构不完整仍触发 glob_expansion

- **WHEN** bash 命令为 `for d in openspec/specs/*/; do ls "$d"`（无 `; done`）
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——for 循环结构不完整，条件 3c 不满足

#### Scenario: for 循环迭代集全字面量走另一条路径

- **WHEN** bash 命令为 `for i in a b c; do echo "$i"; done`，projectRoot 内
- **THEN** 本条件 3c 不适用（迭代集不含 glob）；此命令走"字面量 for 循环豁免"requirement 的判定路径，与 bounded-glob 判定无关

#### Scenario: for 循环迭代集空 prefix + read-only body 自动放行

- **WHEN** bash 命令为 `for x in *.log; do wc -l "$x"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——迭代集 glob `*.log` 前缀为空但迭代词是相对路径（不以 `/`、`~`、`C:\` 开头），条件 2 例外适用（cwd-relative bounded 于 projectRoot），循环体 `wc -l "$x"` 是 read-only（条件 3c 满足），不触发 glob_expansion

#### Scenario: for 循环迭代集空 prefix + 非空 prefix 同命令形态自动放行

- **WHEN** bash 命令为 `for x in ./*.log; do wc -l "$x"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——迭代集 glob `*.log` 前缀为 `./`（项目内），条件 2 常规满足，循环体 read-only（条件 3c 满足），不触发 glob_expansion

#### Scenario: for 循环迭代集空 prefix + 写 body 仍触发 glob_expansion

- **WHEN** bash 命令为 `for x in *.log; do rm "$x"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——循环体 `rm "$x"` 是写操作，条件 3c 不满足，不享受空 prefix 放宽

#### Scenario: for 循环迭代集绝对路径前缀仍触发 glob_expansion

- **WHEN** bash 命令为 `for f in /etc/*.conf; do cat "$f"; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——迭代词以 `/` 开头（绝对路径前缀），条件 2 例外不适用（绝对路径无法 bounded 于 projectRoot）

#### Scenario: for 循环迭代集 ~ 前缀仍触发 glob_expansion

- **WHEN** bash 命令为 `for f in ~/*.conf; do cat "$f"; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——迭代词以 `~` 开头（home 展开），条件 2 例外不适用

#### Scenario: 非 for-loop 路径的空 prefix glob 仍触发 glob_expansion

- **WHEN** bash 命令为 `rm *.log`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——非 for-loop 路径，空 prefix 放宽的情形 B 不适用（`rm` 不满足条件 3 只读判定），`rm` 不在 read-only 命令集合

#### Scenario: for 循环迭代集空 prefix + cat body 自动放行

- **WHEN** bash 命令为 `for x in *.ts; do cat "$x"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——迭代词 `*.ts` 相对路径，空 prefix 放宽适用，循环体 `cat "$x"` read-only，条件 3c 满足

#### Scenario: 只读命令 + 空 prefix glob 自动放行（情形 B 新增）

- **WHEN** bash 命令为 `ls *.md`，projectRoot 内（cwd == projectRoot）
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/*.md] }`，不触发 glob_expansion——`ls` 满足条件 3 只读判定（条件 3a），空 prefix glob 不以绝对路径标志开头，情形 B 放宽适用

#### Scenario: 只读命令 + 裸空 prefix glob 自动放行（情形 B 新增）

- **WHEN** bash 命令为 `ls *`，projectRoot 内（cwd == projectRoot）
- **THEN** 提取结果为 `{ reliable: true, targets: [read <projectRoot>/*] }`，不触发 glob_expansion——`ls` 只读，情形 B 放宽适用

#### Scenario: 写命令 + 空 prefix glob 仍触发 glob_expansion（情形 B 反例新增）

- **WHEN** bash 命令为 `tar xzf pi-ui-extension-*.tgz`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——`tar` 不满足条件 3 只读判定，情形 B 不适用

#### Scenario: 只读命令 + 绝对路径前缀 glob 仍触发 glob_expansion（情形 B 反例新增）

- **WHEN** bash 命令为 `ls /etc/*.conf`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——glob 以 `/` 开头（绝对路径前缀），情形 B 不适用，绝对路径无法 bounded 于 projectRoot

#### Scenario: 只读命令 + ~ 前缀 glob 仍触发 glob_expansion（情形 B 反例新增）

- **WHEN** bash 命令为 `ls ~/*.md`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——glob 以 `~` 开头（home 展开），情形 B 不适用

#### Scenario: for 迭代集 glob + 赋值 $(grep) 只读 body 自动放行（本 change 新增）

- **WHEN** bash 命令为 `for f in openspec/specs/*/spec.md; do n=$(grep -c '^### Requirement:' "$f"); echo "$n"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——循环体含变量赋值 `n=$(grep -c ...)`，赋值右侧 `$(grep ...)` 经"命令替换内只读命令豁免"的 for-body 迭代变量绑定判据判定为只读（`$f` 绑定迭代集，迭代集 glob 前缀 `openspec/specs/` 在项目内），条件 3c 满足，不触发 glob_expansion

#### Scenario: for 迭代集 glob + 纯赋值只读 body 自动放行（本 change 新增）

- **WHEN** bash 命令为 `for f in openspec/specs/*/spec.md; do n=5; echo "$n"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——循环体含纯字面量赋值 `n=5`（无 `$()`），赋值视为只读，条件 3c 满足

#### Scenario: for 迭代集 glob + 赋值 $(rm) 写 body 仍触发 glob_expansion（本 change 新增反例）

- **WHEN** bash 命令为 `for f in openspec/specs/*/spec.md; do n=$(rm "$f"); echo "$n"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——赋值右侧 `$(rm "$f")` 内命令 `rm` 是写操作，不满足只读，条件 3c 不满足

#### Scenario: for 迭代集 glob + 赋值 $(grep 未绑定路径) 仍触发 glob_expansion（本 change 新增反例）

- **WHEN** bash 命令为 `for f in openspec/specs/*/spec.md; do n=$(grep -c '^###' "$f" /etc/passwd); echo "$n"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——赋值右侧 `$(grep ...)` 含非绑定路径参数 `/etc/passwd`（不在迭代集内），不满足 for-body 迭代变量绑定判据，条件 3c 不满足

#### Scenario: for 迭代集 glob + 赋值 $(grep 未绑定变量) 仍触发 glob_expansion（本 change 新增反例）

- **WHEN** bash 命令为 `for f in openspec/specs/*/spec.md; do n=$(grep -c '^###' "$f" $OTHER); echo "$n"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——赋值右侧 `$(grep ...)` 含未绑定用户变量 `$OTHER`，不满足 for-body 迭代变量绑定判据，条件 3c 不满足

### Requirement: 命令替换内只读命令豁免

当 bash 命令中的命令替换 `$(...)` 满足以下**全部**条件时，MUST NOT 触发 `command_substitution` 不可靠标记，让命令走正常提取流程：

1. **顶层命令属于豁免白名单**：`$(...)` 内展开后的顶层命令名属于 `SUBSTITUTION_READONLY_CMDS` 集合（`basename` / `dirname` / `echo` / `printf` / `pwd` / `test`）——这些命令只执行路径字符串变换、标准输出打印、当前目录输出或条件查询，无任意文件读写、无网络访问、无子命令执行副作用。**注意**：`realpath`（即使 `-m` 形式）与 bash 的 `[` test builtin 别名**不在**白名单内——前者涉及文件系统遍历，后者的语法检查成本高、收益低。
2. **嵌套替换递归判定**：`$(basename $(dirname $f))` 这类嵌套形式中，外层 `$(basename ...)` 通过条件 1 后，其参数 `$(dirname $f)` 是嵌套命令替换，MUST 递归地对最内层命令替换运行相同的条件 1/2 判定。嵌套深度超过 3 层 MUST NOT 豁免（触发 `command_substitution`），避免恶意构造。
3. **顶层无副作用构造**：`$(...)` 顶层命令的**参数部分**（不含被递归判定的嵌套 `$(...)`）MUST NOT 包含以下任一 shell 层副作用构造：
   - 未加引号的 glob 元字符（`*` / `?` / `[`）——与"有界 glob 免不可靠标记"一致，无界 glob 不豁免
   - heredoc 定界符 `<<`
   - 反引号 `` `...` ``（命令替换的旧形式）
   - 未加引号的形式化命令替换 `$(...)`（未被递归判定接受为嵌套豁免）
   - 输出重定向 `>` / `>>` / `2>` 等（会写入任意文件，绕过 `command_substitution` 门禁）
   - 管道 `|`（引入额外命令执行，extractor 无法穿透边界判定）
   - 后台分隔符 `&` 与逻辑与 `&&`（引入额外命令执行）
   - 命令分隔符 `;`（引入额外命令执行）
4. **用户变量在参数中允许**：白名单命令的参数中可以出现引号内的用户变量（如 `basename "$f"`）——变量的实际值不影响命令的静态只读性判定。这类命令里的用户变量**仍会**在 `findUnresolvedVariable`（"变量展开与展开失败"requirement）判定中被识别为未解析用户变量，走兜底弹窗——**本豁免不覆盖用户变量判定**，豁免判定与用户变量判定是**独立且顺序执行**的两步。

**for-body 迭代变量绑定豁免（本 change 新增）**：当 `$(...)` 出现在一个**结构完整 for 循环的 BODY 内**时，若满足以下**全部**条件，MUST NOT 触发 `command_substitution`——这是独立于上述条件 1-4 的**平行判据**（不与白名单合并，不改变既有白名单语义）：

- **B1 命令只读**：`$(...)` 内展开后的顶层命令名属于 `READ_ONLY_COMMANDS`（`grep` / `cat` / `head` / `tail` / `wc` / `ls` / `stat` 等，不含 `find` 的写形态）或 `HARMLESS_BUILTINS`——命令只读，无写副作用
- **B2 路径参数绑定**：`$(...)` 内所有**文件系统路径参数**必须静态绑定到 for 迭代变量（`"$f"`，`f` 是当前 for 循环的迭代变量）或项目内字面路径（无 `$` / glob / 反引号）；任一路径参数含未绑定用户变量（`$OTHER`）、未加引号 glob、或非迭代变量的 `$` 引用，MUST NOT 豁免
- **B3 迭代集 bounded**：当前 for 循环的迭代集是字面量词集合，或含 glob 但 glob 前缀完全位于 `<projectRoot>` 内（复用"有界 glob 免不可靠标记"条件 2）——迭代变量 `$f` 的值域静态确定且 bounded 于项目内
- **B4 无其他副作用构造**：`$(...)` 内不含输出重定向、管道、`&&`/`;`/`&`、反引号、未引号 heredoc、子 shell（同条件 3 的副作用清单）

**fail-closed 边界（本 change 新增）**：上述 B1-B4 只覆盖 for-body 内的窄上下文。**无 for 上下文**的顶层 `$(grep /etc/passwd)`、`$(cat /etc/passwd)`、`$(rm -rf /tmp)` 等 MUST 维持原 `command_substitution` 判定（白名单外命令不因本 change 获得豁免）——这保持 `readonly.ts` 既有设计的安全边界（豁免顶层读替换会成 silent no-op，绕过授权检查）。

**边界与理由**：命令替换的豁免判定是**保守白名单准入**——白名单外的形式（`$(cat ...)`、`$(grep ...)`、`$(rm -rf ...)`）一律保持原 `command_substitution` 判定不变，**除非**满足上述 for-body 迭代变量绑定豁免（B1-B4 全部满足）。豁免的存在不改变默认行为，只让"用户眼中显然安全"的常见 shell 惯用法（`$(basename ...)`、`$(dirname ...)`）不再被误判为噪音弹窗；for-body 绑定豁免进一步让"for 迭代变量驱动的只读统计命令"（如 `n=$(grep -c ... "$f")`）不再误判。

**顺序与交互**：
- 本豁免在 `scanUnreliable` 的字符扫描循环内判定，位置在同循环内其他 unreliable 检测（backtick / heredoc / subshell / glob）的**同一次遍历**中——即豁免掉一个 `$(...)` 后，扫描继续向后，其他位置的 unreliable 模式仍会被检测。
- 豁免判定通过之后，整条命令仍要经过 `scanControlFlow` / `isShellForwarder` / `isAnyUnreliableCommand` / `findUnresolvedVariable` 等**后续所有守卫**——豁免仅关闭 `command_substitution` 这一条理由，不短路任何其他守卫。
- 与"有界 glob 免不可靠标记"requirement 一致：豁免判定失败立即回退原判定，不影响其他 guardrail 层。

#### Scenario: `$(basename ...)` 在 read-only for 循环内自动放行

- **WHEN** bash 命令为 `for f in openspec/changes/archive/*/proposal.md; do echo "=== $(basename $f) ==="; head -20 "$f"; done`
- **THEN** 提取结果为 `{ reliable: true }`——`$(basename $f)` 的顶层命令 `basename` 在白名单内，参数 `"$f"` 是引号内字面量，无副作用构造，豁免条件 1-4 全部满足；不触发 `command_substitution`，命令按正常提取流程判 reliable

#### Scenario: 嵌套 basename+dirname 自动放行

- **WHEN** bash 命令为 `for f in openspec/**/*.md; do echo "=== $(basename $(dirname $f)) ==="; head -20 "$f"; done`
- **THEN** 提取结果为 `{ reliable: true }`——外层 `$(basename $(dirname $f))` 的顶层命令 `basename` 在白名单内（条件 1），参数 `$(dirname $f)` 是嵌套命令替换（条件 3），递归判定 `$(dirname $f)` 通过（`dirname` 也在白名单内），豁免成立

#### Scenario: 白名单外命令替换仍判不可靠

- **WHEN** bash 命令为 `echo "$(cat /etc/passwd)"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`cat` 不在 `SUBSTITUTION_READONLY_CMDS` 内，条件 1 不满足，豁免失败回退原判定

#### Scenario: `realpath`（含 `-m`）暂不豁免

- **WHEN** bash 命令为 `echo "$(realpath -m openspec/specs/foo.md)"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`realpath` 不在 `SUBSTITUTION_READONLY_CMDS` 白名单内（即使 `-m` 形式涉及路径参数与文件系统遍历，本 change 暂不纳入白名单，待二次评估）；豁免失败回退原判定

#### Scenario: 白名单命令含未加引号 glob 参数仍判不可靠

- **WHEN** bash 命令为 `echo "$(basename /etc/*.txt)"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——虽然 `basename` 在白名单内（条件 1），但参数 `*.txt` 是未加引号的 glob 元字符，违反条件 3，豁免失败回退原判定

#### Scenario: 嵌套深度超过 3 层判不可靠

- **WHEN** bash 命令为 `echo "$(basename $(dirname $(pwd $(pwd))))"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——嵌套深度达到 3 层，第 4 层触发嵌套深度上限，豁免失败回退原判定（条件 3 违反）

#### Scenario: 白名单命令参数中嵌套替换含写操作仍判不可靠

- **WHEN** bash 命令为 `echo "$(basename $(rm -rf /tmp/x))"`
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——外层 `basename` 通过条件 1，但嵌套 `$(rm -rf /tmp/x)` 递归判定时 `rm` 不在白名单内，条件 3 递归失败，豁免失败回退原判定

#### Scenario: 白名单命令参数含用户变量仍豁免但走变量判定

- **WHEN** bash 命令为 `echo "path: $(basename $MY_FILE)"`，`MY_FILE` 未展开
- **THEN** 提取结果为 `{ reliable: false }`——`basename` 通过豁免条件 1-4（参数 `"$MY_FILE"` 是引号内字面变量引用，豁免判定不检查变量值），但 `findUnresolvedVariable` 在后续步骤检测到未展开用户变量 `MY_FILE`，命令仍判 `unreliable, unresolved variable: MY_FILE`——豁免与用户变量判定是独立的两个步骤

#### Scenario: 白名单命令 + 后续命令含真实写操作仍提取 write target

- **WHEN** bash 命令为 `echo "$(basename $f)" && rm -rf /tmp/scratch`
- **THEN** 提取结果为 `{ reliable: true, targets: [delete /tmp/scratch] }`——`$(basename $f)` 豁免通过，命令不判 `command_substitution`；但 `&&` 后的 `rm -rf /tmp/scratch` 由正常的 `rm` 提取器（`COMMAND_TABLE.rm`）提取为 delete target，命令仍判 reliable（`scanControlFlow` 等其他守卫不触发）。这演示了"豁免仅关闭 command_substitution 单条理由，不短路任何其他守卫"的规则

#### Scenario: `$(dirname ...)` 单独出现自动放行

- **WHEN** bash 命令为 `head -20 "$(dirname openspec/specs/bash-target-extraction/spec.md)/spec.md"`
- **THEN** 提取结果为 `{ reliable: true }`——`$(dirname ...)` 参数是纯字面量路径，无副作用构造，豁免成立

#### Scenario: `$(pwd)` 自动放行

- **WHEN** bash 命令为 `echo "cwd: $(pwd)"`
- **THEN** 提取结果为 `{ reliable: true }`——`pwd` 在白名单内，无参数，豁免成立

#### Scenario: for-body 迭代变量绑定 $(grep) 自动放行（本 change 新增）

- **WHEN** bash 命令为 `for f in openspec/specs/*/spec.md; do n=$(grep -c '^### Requirement:' "$f"); echo "$n"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——`$(grep -c ... "$f")` 顶层命令 `grep` 属 READ_ONLY_COMMANDS（B1），路径参数 `"$f"` 绑定迭代变量（B2），迭代集 glob 前缀 `openspec/specs/` 在项目内（B3），无其他副作用构造（B4），for-body 绑定豁免成立，不触发 `command_substitution`

#### Scenario: for-body 迭代变量绑定 $(cat) 自动放行（本 change 新增）

- **WHEN** bash 命令为 `for f in openspec/specs/*/spec.md; do n=$(cat "$f"); echo "$n"; done`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`——`cat` 属 READ_ONLY_COMMANDS（B1），`"$f"` 绑定迭代变量（B2），迭代集 bounded（B3），无副作用（B4），绑定豁免成立

#### Scenario: for-body 绑定 $(grep) 含非绑定路径仍判不可靠（本 change 新增反例）

- **WHEN** bash 命令为 `for f in a b c; do n=$(grep -c '^###' "$f" /etc/passwd); echo "$n"; done`，projectRoot 内（字面量迭代集，无 glob 分支拦截，`$()` 分支可达）
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`$(grep ...)` 路径参数 `/etc/passwd` 非迭代变量且非项目内字面路径（B2 不满足），绑定豁免失败，回退原判定

#### Scenario: for-body 绑定 $(grep) 含未绑定变量仍判不可靠（本 change 新增反例）

- **WHEN** bash 命令为 `for f in a b c; do n=$(grep -c '^###' "$f" $OTHER); echo "$n"; done`，projectRoot 内（字面量迭代集）
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`$(grep ...)` 路径参数含未绑定用户变量 `$OTHER`（B2 不满足），绑定豁免失败，回退原判定

#### Scenario: for-body 绑定 $(rm) 写命令仍判不可靠（本 change 新增反例）

- **WHEN** bash 命令为 `for f in a b c; do n=$(rm "$f"); echo "$n"; done`，projectRoot 内（字面量迭代集）
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`$(rm ...)` 顶层命令 `rm` 非只读（B1 不满足），绑定豁免失败，回退原判定

#### Scenario: for 迭代集出界时绑定豁免不适用（本 change 新增反例）

- **WHEN** bash 命令为 `for f in /etc/passwd /etc/shadow; do n=$(grep -c '^#' "$f"); echo "$n"; done`（绝对路径字面量迭代集，无 glob 分支拦截，`$()` 分支可达）
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——迭代集含绝对路径 `/etc/passwd`、`/etc/shadow`，不在 projectRoot 内（B3 不满足），绑定豁免失败，回退原判定（注：用绝对路径字面量迭代而非 glob 出界，是为了让 `$()` 分支真正执行以测试 B3；glob 出界迭代会被「有界 glob 免不可靠标记」的 glob 分支先拦截，reason 为 glob_expansion，测试不到 B3）

#### Scenario: 顶层 $(grep /etc/passwd) 无 for 上下文仍判不可靠（本 change 新增反例，安全边界）

- **WHEN** bash 命令为 `echo "$(grep -c '^#' /etc/passwd)"`，无 for 循环
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`grep` 不在 `SUBSTITUTION_READONLY_CMDS` 白名单，且无 for-body 上下文（for-body 绑定豁免不适用），维持原 `command_substitution` 判定——**本 change 不改变顶层读替换的安全边界**

#### Scenario: 顶层 $(cat /etc/passwd) 无 for 上下文仍判不可靠（本 change 新增反例，安全边界）

- **WHEN** bash 命令为 `echo "$(cat /etc/passwd)"`，无 for 循环
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`——`cat` 不在白名单，无 for-body 上下文，维持原判定
