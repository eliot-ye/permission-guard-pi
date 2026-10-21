# bash-target-extraction

## ADDED Requirements

### Requirement: 引号定界 heredoc 内容处理

当 bash 命令中出现 heredoc 操作符 `<<` 且其定界符以**引号**包裹（单引号 `'DELIM'`、双引号 `"DELIM"`）或带 dash 形式（`<<-'DELIM'`、`<<-"DELIM"`、`<<-DELIM` 中 DELIM 带引号）时，该 heredoc 的**内容** MUST 视为字面数据——不触发 `heredoc` 不可靠标记，不对内容做任何 `$` / 反引号 / `$(...)` / glob 检测。

**理由**：bash 语义下，引号定界的 heredoc 定界符表示内容**不做任何展开**——`$HOME`、`` `cmd` ``、`$(cmd)` 在引号定界 heredoc 内全是字面字符，等价于单引号字符串。当前 `scanUnreliable` 看到 `<<` 就返回 `"heredoc"`，不区分定界符是否引号包裹，导致 `node --input-type=module <<'EOF' ... EOF`（内联测试脚本）等安全场景被误判为不可靠。

**识别规则**：
1. `scanUnreliable` 遇到 `<<` 时，MUST 检查 `<<` 后（跳过可选的 `-`）是否紧跟 `'` 或 `"`
2. 若紧跟引号 → 读取引号内的定界符 `DELIM`，然后跳过从 `<<` 行结束到**以 DELIM 为唯一内容的行**之间的所有字符（heredoc 内容），继续扫描 heredoc 之后的命令
3. 若 `<<` 后无引号（未引号定界 heredoc，如 `<<EOF`）→ 保持原行为，返回 `"heredoc"` 不可靠标记（内容会展开 `$` / 反引号）

**dash 形式**（`<<-`）：`<<-` 后跟引号定界符时同样适用本规则。dash 形式的结束定界符行首允许前导空白（bash `<<-` 会去除前导 tab），本规则在匹配结束定界符行时 MUST 容忍前导 tab/空白。

**内容跳过的边界**：内容跳过 MUST 精确到结束定界符行——若找不到结束定界符（heredoc 未闭合），MUST 回退到原 `return "heredoc"` 行为（保守判不可靠）。

#### Scenario: 单引号定界 heredoc reliable

- **WHEN** bash 命令为 `cat <<'EOF'\nhello\nEOF`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——heredoc 内容 `hello` 视为字面数据，不触发 heredoc 不可靠标记

#### Scenario: 双引号定界 heredoc reliable

- **WHEN** bash 命令为 `cat <<"EOF"\nhello\nEOF`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——双引号定界同样不做展开

#### Scenario: dash + 引号定界 heredoc reliable

- **WHEN** bash 命令为 `cat <<-'EOF'\nhello\nEOF`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——dash 形式 + 引号定界同样 reliable

#### Scenario: 引号定界 heredoc 内含 `$` 与反引号 reliable

- **WHEN** bash 命令为 `cat <<'EOF'\n$(rm -rf /)\n\`whoami\`\nEOF`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——引号定界 heredoc 内的 `$()` 与反引号全是字面字符，不触发不可靠

#### Scenario: 未引号定界 heredoc 仍 unreliable

- **WHEN** bash 命令为 `cat <<EOF\nhello\nEOF`
- **THEN** 提取结果为 `{ reliable: false, reason: "heredoc" }`——未引号定界 heredoc 内容会展开 `$` / 反引号，仍判不可靠

#### Scenario: 引号定界 heredoc 前命令正常提取

- **WHEN** bash 命令为 `cat /etc/passwd; cat <<'EOF'\nx\nEOF`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd] }`——heredoc 内容跳过，heredoc 前的 `cat /etc/passwd` 正常提取

#### Scenario: 未闭合引号定界 heredoc 回退不可靠

- **WHEN** bash 命令为 `cat <<'EOF'\nhello`（无结束 `EOF` 行）
- **THEN** 提取结果为 `{ reliable: false, reason: "heredoc" }`——找不到结束定界符，保守回退到原 heredoc 不可靠行为

### Requirement: 字面量 for 循环豁免

当 `for` 关键字作为**引号外独立 token**出现时，若满足以下全部条件，MUST NOT 触发 `control_flow` 不可靠标记，改为按循环体命令对每个迭代词提取 read targets：

1. **字面量迭代集**：`for X in <words>` 中的 `<words>` MUST 全部是字面量词（不含 `$` / 反引号 / `$(...)` / 未加引号的 glob 元字符 `*`/`?`/`[`）。引号包裹的词（如 `"a b"`）允许（引号内字面量）
2. **可静态判定的循环体**：`do ... done` 内的命令 MUST 满足：
   - 每个命令的首命令名属于 READ_ONLY_COMMANDS（`cat`/`head`/`tail`/`wc`/`grep`/`find`/`ls`/`tree`/`stat`/`du`/`df`/`file`/`less`/`more`/`git log` 等）或属于 SILENT_COMMANDS（`git`/`npm`/`npx` 等）
   - 循环变量（如 `$f`）MUST 视为已解析的"迭代集字面量之一"——不触发 `unresolved variable`，因为它的值域已被条件 1 静态确定为字面量词集合
   - 体内 MUST NOT 含未引号 glob、命令替换 `$(...)` / 反引号、子 shell `(...)`、process substitution `<(...)`、heredoc（引号定界或未引号均判不可靠，因为 for 体内的 heredoc 边界与循环边界交互复杂）
   - 体内 MUST NOT 含其他控制流关键字（`while`/`if`/`case` 等嵌套控制流）
3. **无重定向到循环变量**：循环体内的重定向目标 MUST NOT 是循环变量（如 `cat > "$f"` 是 write，不满足 read-only 体条件）

**理由**：当 `for` 的迭代集是静态字面量词、循环体是 read-only 命令且循环变量只作为路径参数使用时，实际访问的文件集是"迭代集 × 体的 read targets"的笛卡尔积，静态可确定。与 `while`/`until`（迭代条件运行时决定）本质不同。

**反例（仍触发 control_flow）**：
- 迭代集含 `$` / 反引号 / `$(...)`（如 `for f in $FILES`）
- 迭代集含未引号 glob（如 `for f in /etc/*.conf`）
- 循环体含 write 命令（如 `for f in a b; do rm "$f"; done`）
- 循环体含命令替换（如 `for f in a; do cat $(cmd); done`）
- 嵌套控制流（如 `for f in a; do while ...; done; done`）

**其他控制流关键字不受豁免**：`while`/`until`/`do`/`done`/`if`/`then`/`else`/`elif`/`fi`/`case`/`in`/`esac` MUST 维持原 `control_flow` 判定，不适用本豁免。

#### Scenario: 字面量 for + read-only 体 reliable

- **WHEN** bash 命令为 `for f in a b c; do grep "$f"; done`
- **THEN** 提取结果为 `{ reliable: true, targets: [read a, read b, read c] }`——迭代集全字面量，体含 read-only `grep`，循环变量 `$f` 视为已解析

#### Scenario: 字面量 for + 多命令体 reliable

- **WHEN** bash 命令为 `for f in a b; do echo "$f"; grep "$f"; done`
- **THEN** 提取结果为 `{ reliable: true, targets: [read a, read b] }`——`echo` 0 target，`grep` 提取 read target

#### Scenario: for 迭代集含 glob 仍 unreliable

- **WHEN** bash 命令为 `for f in /etc/*.conf; do cat "$f"; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`——迭代集含未引号 glob，不满足字面量迭代条件

#### Scenario: for 迭代集含变量仍 unreliable

- **WHEN** bash 命令为 `for f in $FILES; do cat "$f"; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`——迭代集含 `$FILES`，不满足字面量迭代条件；`for` 豁免不适用，回退到原 control_flow 判定

#### Scenario: for 体含 write 命令仍 unreliable

- **WHEN** bash 命令为 `for f in a b; do rm "$f"; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`——体含 write 命令 `rm`，不满足 read-only 体条件

#### Scenario: while 循环仍 unreliable（不受豁免）

- **WHEN** bash 命令为 `while read x; do cat "$x"; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`——`while` 不受 `for` 豁免影响

#### Scenario: if 语句仍 unreliable（不受豁免）

- **WHEN** bash 命令为 `if true; then cat /etc/passwd; fi`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`——`if` 不受 `for` 豁免影响

## MODIFIED Requirements

### Requirement: 复杂语法导致不可靠

以下 bash 语法 MUST 触发"不可靠"标记（走兜底弹窗而非尝试解析）：

- 命令替换：`$(...)`、反引号 `` `...` ``
- 子 shell：`(...)`
- Process substitution：`<(...)`、`>(...)`
- Heredoc：`<<EOF`（**未引号定界**的 heredoc——内容会展开 `$` / 反引号；引号定界 heredoc `<<'EOF'`/`<<"EOF"` 见"引号定界 heredoc 内容处理"requirement，不触发不可靠）
- 未展开的用户变量（详见"变量展开与展开失败"节）
- 未加引号的 glob 通配符（`*`、`?`、`[`）——无法枚举 shell 会展开到哪些文件（有界 glob 例外见"有界 glob 免不可靠标记"requirement）

**引号感知**：以上所有模式 MUST 仅对**引号外且未被反斜杠转义**的字符生效。判定规则：

- 单引号 `'...'` 内的所有字符 MUST 视为字面量，不触发任何不可靠标记（bash 语义：单引号内 `\$` 也是字面 `$`）
- 双引号 `"..."` 内的字符 MUST 遵循 bash 双引号语义——`\$`、`\"`、`\\` 视为字面字符；裸 `$` 后接 `(` MUST 触发 command_substitution（bash 双引号内 `$()` 仍执行命令替换）
- 反斜杠 `\X`（引号外）MUST 使 `X` 视为字面字符（如 `\|`、`\$`、`` \` ``、`\(`、`\*`）
- 转义序列的判定 MUST 先于引号开合——`\\"` 中的 `\"` 是字面双引号，不视为引号开合

管道 `|` MUST NOT 单独作为"不可靠"标记；管道的处理见"管道按 stage 独立提取"与"转发器命令守卫"两个 requirement。

#### Scenario: 命令替换不可靠

- **WHEN** bash 命令为 `rm -rf $(cat /etc/hosts)`（引号外的 `$(`）
- **THEN** 提取结果为 `{ reliable: false, reason: "command_substitution" }`

#### Scenario: 管道命令不可靠

- **WHEN** bash 命令为 `cat /etc/passwd | grep root`（无转发器、无其他不可靠语法）
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd, ...] }`——管道不再单独触发"不可靠"；每个 stage 独立提取，完整行为见"管道按 stage 独立提取"requirement。转发器（`xargs`/`parallel`/`pforeach` 非首 stage）会判 `reliable: false, reason: "forwarding_command"`（除非满足"转发器命令守卫"requirement 的 read-only 下游豁免）

#### Scenario: 反引号不可靠

- **WHEN** bash 命令为 `rm -rf \`cat /etc/hosts\``
- **THEN** 提取结果为 `{ reliable: false }`

#### Scenario: 用户变量导致不可靠

- **WHEN** bash 命令为 `cat $MYSECRETS`（`MYSECRETS` 未展开）
- **THEN** 提取结果为 `{ reliable: false, rawCommand: "..." }`

#### Scenario: 未加引号的 glob 不可靠

- **WHEN** bash 命令为 `rm -rf /etc/*.log`
- **THEN** 提取结果为 `{ reliable: false, reason: "glob_expansion" }`

#### Scenario: 双引号内的转义字符不触发不可靠

- **WHEN** bash 命令为 `echo "x\$(cat /etc/passwd)"`
- **THEN** 提取结果为 `{ reliable: true }`；`\$` 在双引号内视为字面 `$`，不触发 command_substitution

#### Scenario: 单引号内的所有字符都是字面量

- **WHEN** bash 命令为 `echo 'literal \$(command) and `backtick`'`
- **THEN** 提取结果为 `{ reliable: true }`；单引号内 `$()` 与反引号都是字面字符

#### Scenario: 引号外的命令替换仍判不可靠

- **WHEN** bash 命令为 `echo $(cat /etc/passwd)`
- **THEN** 提取结果为 `{ reliable: false }`；引号外的 `$(` 仍是 command_substitution

#### Scenario: 转义管道字符不触发不可靠

- **WHEN** bash 命令为 `echo foo\|bar > /tmp/x`
- **THEN** 提取结果为 `{ reliable: true }`，包含写 target `/tmp/x`；`\|` 是字面管道字符

#### Scenario: 未引号定界 heredoc 不可靠

- **WHEN** bash 命令为 `cat <<EOF\nhello\nEOF`
- **THEN** 提取结果为 `{ reliable: false, reason: "heredoc" }`——未引号定界 heredoc 内容会展开 `$` / 反引号

#### Scenario: 引号定界 heredoc reliable

- **WHEN** bash 命令为 `cat <<'EOF'\nhello\nEOF`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——引号定界 heredoc 内容视为字面数据，见"引号定界 heredoc 内容处理"requirement

### Requirement: 转发器命令守卫

某些命令消费 stdin 内容并将其作为参数传给下游工具（即"转发器"）。当转发器命令出现在**管道的非首 stage**（即有 `|` 将上游 stdout 送入该 stage）时，默认判整条命令为不可靠——静态分析无法枚举下游调用参数。

**read-only 下游豁免**：当转发器 stage 满足以下全部条件时，MUST NOT 判 `forwarding_command`，改为按下游命令的 read target 提取规则处理上游输出的文件列表：

1. 转发器后的**下游命令**（转发器 token 后的第一个非 flag token）属于 READ_ONLY_COMMANDS（`cat`/`head`/`tail`/`wc`/`grep`/`find`/`ls`/`tree`/`stat`/`du`/`df`/`file`/`less`/`more`/`git log` 等）
2. 下游命令的参数 MUST 可静态判定——不含 `$`（除循环变量白名单 `$?`/`$!`/`$#`/`$$`）、反引号、`$(...)`、未加引号的 glob 元字符、未引号定界 heredoc
3. 转发器自身的参数（如 `xargs -I {}`、`xargs -n 1`）不影响豁免判定——只看下游命令

**理由**：`xargs grep` / `xargs wc` / `xargs ls` 等组合的实际行为是"对上游输出的文件列表做只读操作"——安全包络等价于直接枚举文件后跑 read-only 命令。下游命令是 read-only 且参数可静态判定时，不构成安全风险。下游是 write 命令（`xargs rm`）或参数含 `$` / glob 时仍不可靠。

系统 MUST 定义转发器命令表，至少包含 `xargs`、`parallel`、`pforeach`。

判定条件（默认 + 豁免）：

- 命令名精确匹配（不模糊）
- 该 stage 不是第一个 stage（即在其前存在 `|` 连接符）
- 首个 stage 中出现转发器命令 MUST NOT 触发不可靠（无 pipe 输入意味着行为可预测）
- **豁免判定**：转发器在非首 stage 时，MUST 先检查 read-only 下游豁免条件；满足豁免 → 不判不可靠，按下游命令提取 read targets；不满足豁免 → 维持 `forwarding_command`

转发器命令的 `reason` 字段 MUST 包含 `"forwarding_command"` 字样以便用户/审计识别（仅在豁免不适用时）。

#### Scenario: xargs 在管道后续 stage 判不可靠

- **WHEN** bash 命令为 `find /etc | xargs rm`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——下游 `rm` 是 write 命令，不满足 read-only 下游豁免

#### Scenario: parallel 在管道后续 stage 判不可靠

- **WHEN** bash 命令为 `cat /tmp/input.txt | parallel -a /tmp/input.txt`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——`parallel` 无明确 read-only 下游命令，不满足豁免

#### Scenario: xargs 无管道输入不判转发器

- **WHEN** bash 命令为 `echo hi; xargs --help`
- **THEN** 提取结果为 `{ reliable: true }`，不提取 target（`echo`、`xargs --help` 均无路径参数）；`xargs` 未出现在管道后续 stage 位置，不触发转发器守卫

#### Scenario: xargs grep read-only 下游 reliable

- **WHEN** bash 命令为 `find /tmp -name "*.log" | xargs grep "error"`
- **THEN** 提取结果为 `{ reliable: true }`——下游 `grep` 属于 READ_ONLY_COMMANDS 且参数可静态判定，满足 read-only 下游豁免

#### Scenario: xargs wc read-only 下游 reliable

- **WHEN** bash 命令为 `find /tmp | xargs wc -l`
- **THEN** 提取结果为 `{ reliable: true }`——下游 `wc` 属于 READ_ONLY_COMMANDS

#### Scenario: xargs 下游含 `$` 仍 unreliable

- **WHEN** bash 命令为 `find /tmp | xargs grep $PATTERN`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——下游参数含 `$PATTERN`，不满足可静态判定条件

#### Scenario: xargs 下游含未引号 glob 仍 unreliable

- **WHEN** bash 命令为 `find /tmp | xargs grep *.log`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`——下游参数含未引号 glob

### Requirement: 控制流关键字守卫

以下 bash 控制流关键字作为**引号外独立 token**出现时 MUST 触发"不可靠"标记，整条命令走 tier=two 弹窗而非尝试解析：

- `while`、`do`、`done`
- `until`
- `if`、`then`、`else`、`elif`、`fi`
- `case`、`in`、`esac`

**`for` 的字面量迭代豁免**：`for` 关键字作为独立 token 出现时，若满足"字面量 for 循环豁免"requirement 的条件（字面量迭代集 + read-only 循环体），MUST NOT 触发 `control_flow`；不满足豁免条件时，`for` 仍触发 `control_flow`。详见"字面量 for 循环豁免"requirement。

**理由**：控制流关键字使得命令的实际执行取决于运行时条件或循环变量，静态分析无法预测循环体内变量的取值，也无法预测 `if`/`case` 分支的实际路径。这与管道转发器同类问题（"实际访问的文件集无法静态确定"），处理策略一致。`for` 的豁免是例外——当迭代集与循环体都可静态判定时，实际访问集是确定的，不适用"不可静态确定"的判定。

**引号感知**：控制流关键字判定 MUST 遵循引号语义——

- 单引号 `'...'` 内的关键字 MUST 视为字面量，不触发
- 双引号 `"..."` 内的关键字 MUST 视为字面量，不触发
- 引号外的关键字 MUST 作为独立 token（前后为空白或命令分隔符）时才触发；作为更长 token 的一部分（如变量名 `whileFoo`、路径 `/tmp/if.txt`）MUST NOT 触发

**检测位置**：控制流检查 MUST 在 pipeline 拆分**之前**执行——一旦检测到控制流（且不满足豁免），整条命令判不可靠，无需再拆分 stage。

#### Scenario: while 关键字判不可靠

- **WHEN** bash 命令为 `while read x; do cat $x; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: for 关键字判不可靠

- **WHEN** bash 命令为 `for f in $FILES; do cat $f; done`（迭代集含变量）
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`——迭代集含 `$FILES`，不满足字面量迭代豁免条件，`for` 仍触发 control_flow

#### Scenario: until 关键字判不可靠

- **WHEN** bash 命令为 `until ls /; do echo hi; done`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: case 关键字判不可靠

- **WHEN** bash 命令为 `case "$x" in a) cat a;; b) cat b;; esac`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: if 关键字判不可靠

- **WHEN** bash 命令为 `if true; then cat /etc/passwd; fi`
- **THEN** 提取结果为 `{ reliable: false, reason: "control_flow" }`

#### Scenario: 控制流关键字在引号内视为字面

- **WHEN** bash 命令为 `echo "while" && cat /etc/passwd`（`while` 在双引号内）
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd] }`——引号内关键字不触发；命令按 stage 正常提取

#### Scenario: 控制流关键字作为 token 子串不触发

- **WHEN** bash 命令为 `cat /tmp/if.txt`（`if` 是文件名的一部分）
- **THEN** 提取结果为 `{ reliable: true, targets: [read /tmp/if.txt] }`——`if` 不作为独立 token 出现，不触发

#### Scenario: 字面量 for 循环 reliable（豁免）

- **WHEN** bash 命令为 `for f in a b c; do grep "$f"; done`
- **THEN** 提取结果为 `{ reliable: true, targets: [read a, read b, read c] }`——满足字面量迭代豁免，不触发 control_flow；详见"字面量 for 循环豁免"requirement
