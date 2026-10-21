# bash-target-extraction

## MODIFIED Requirements

### Requirement: 复杂语法导致不可靠

以下 bash 语法 MUST 触发"不可靠"标记（走兜底弹窗而非尝试解析）：

- 命令替换：`$(...)`、反引号 `` `...` ``
- 子 shell：`(...)`
- Process substitution：`<(...)`、`>(...)`
- Heredoc：`<<EOF`
- 未展开的用户变量（详见"变量展开与展开失败"节）
- 未加引号的 glob 通配符（`*`、`?`、`[`）——无法枚举 shell 会展开到哪些文件

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
- **THEN** 提取结果为 `{ reliable: true, targets: [read /etc/passwd, ...] }`——管道不再单独触发"不可靠"；每个 stage 独立提取，完整行为见"管道按 stage 独立提取"requirement。转发器（`xargs`/`parallel`/`pforeach` 非首 stage）会判 `reliable: false, reason: "forwarding_command"`

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

## ADDED Requirements

### Requirement: 管道按 stage 独立提取

包含 `|`（管道）的 bash 命令 MUST 先在命令片段（由 `splitCommands` 按 `;` / `&&` / `||` 拆分得到）内部按顶层 `|` 拆分为多个 stage，然后对每个 stage 独立运行目标提取逻辑（重定向、命令表 extractor、变量展开），最后合并所有 stage 的 targets 数组。当合并后的结果非空且未触发转发器守卫、其他不可靠标记时，返回 `reliable: true`。

顶层 `|` 的判定 MUST 满足：

- 引号内的 `|`（单引号或双引号包裹）MUST NOT 作为拆分点
- `\|`（转义的 `|`）MUST NOT 作为拆分点
- `||`（逻辑或）MUST NOT 被识别为管道（避免与逻辑连接符混淆）
- `|&`（GNU bash pipe stdin+stderr 扩展）MUST 与 `|` 同拆分行为——拆开作为两个 stage

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
- **THEN** 提取结果为 `{ reliable: true }`，包含读 target `/a` 和读 target `/b`；命令被视为两个独立的命令序列，非管道

#### Scenario: pipe stdin+stderr 扩展视为普通管道

- **WHEN** bash 命令为 `echo err >&2 | tee /tmp/x`
- **THEN** 提取结果为 `{ reliable: true }`，包含写 target `/tmp/x`；`|&` 被拆分为两个 stage

#### Scenario: 引号感知与管道拆分协同

- **WHEN** bash 命令为 `grep -E "foo|bar" /etc/passwd`
- **THEN** 提取结果为 `{ reliable: true }`，包含读 target `/etc/passwd`；双引号内的 `|` 不拆分为两个 stage

### Requirement: 转发器命令守卫

某些命令消费 stdin 内容并将其作为参数传给下游工具（即"转发器"）。当转发器命令出现在**管道的非首 stage**（即有 `|` 将上游 stdout 送入该 stage）时，静态分析无法枚举下游调用参数——MUST 判整条命令为不可靠。

系统 MUST 定义转发器命令表，至少包含 `xargs`、`parallel`、`pforeach`。

判定条件：

- 命令名精确匹配（不模糊）
- 该 stage 不是第一个 stage（即在其前存在 `|` 连接符）
- 首个 stage 中出现转发器命令 MUST NOT 触发不可靠（无 pipe 输入意味着行为可预测）

转发器命令的 `reason` 字段 MUST 包含 `"forwarding_command"` 字样以便用户/审计识别。

#### Scenario: xargs 在管道后续 stage 判不可靠

- **WHEN** bash 命令为 `find /etc | xargs rm`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`

#### Scenario: parallel 在管道后续 stage 判不可靠

- **WHEN** bash 命令为 `cat /tmp/input.txt | parallel -a /tmp/input.txt`
- **THEN** 提取结果为 `{ reliable: false, reason: "forwarding_command" }`

#### Scenario: xargs 无管道输入不判转发器

- **WHEN** bash 命令为 `echo hi; xargs --help`
- **THEN** 提取结果为 `{ reliable: true }`，不提取 target（`echo`、`xargs --help` 均无路径参数）；`xargs` 未出现在管道后续 stage 位置，不触发转发器守卫

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
