# bash-target-extraction

## MODIFIED Requirements

### Requirement: 有界 glob 免不可靠标记

当未加引号的 glob 通配符（`*`、`?`、`[`）满足以下全部条件时，MUST NOT 触发"不可靠"标记（即不再因 glob_expansion 走 tier=two 弹窗），而是交给后续正常提取流程按 read/write target 处理：

1. 该 glob 元字符出现在**引号外且未被反斜杠转义**的位置（遵循现有引号感知规则）
2. glob 元字符前的路径前缀（从命令起始到 glob 元字符之前的路径片段）MUST 完全位于 `<projectRoot>` 内部（不含 `../` 越界）
3. glob 所在的 pipeline stage 的首命令（command name）MUST 属于 **read-only 命令集合**：`cat`、`head`、`tail`、`wc`、`grep`、`find`、`ls`、`tree`、`stat`、`du`、`df`、`file`、`less`、`more`、`git log`、`git show`、`git diff`、`git status`、`git ls-files`、`git branch`、`git tag`、`git remote`、`git config`（即：不产生文件系统写入副作用的开发工具命令）

**命令片段上下文**：条件 3 中的"pipeline stage 的首命令"按以下方式确定——先把整条命令按"命令分隔符"（见"管道按 stage 独立提取"requirement）拆为多个**命令片段**，再把每个命令片段按顶层 `|` 拆为多个 pipeline stage；条件 3 判定的是"包含该 glob 的那个 pipeline stage 的首命令"，属于哪个命令片段不影响其他片段。

**理由**：这类 glob 的前缀路径已知且在项目内，且命令语义为只读——静态分析无法枚举具体文件列表，但可确定访问范围在项目内只读，不构成安全风险。与管道转发器、控制流关键字（"实际访问集无法静态确定"）本质不同。多个命令片段之间的组合（例如"先 echo 一个提示，再 wc 一些项目内的 *.ts"）不改变"每个片段独立可静态判定"的性质——只要每个包含 glob 的片段自身满足上述 3 个条件，整条命令就可判定为可靠。

**反例（仍触发 glob_expansion）**：
- glob 前缀出界（如 `ls ../other/*`、`cat /tmp/*.log`）
- 命令属于写/删操作（如 `rm -rf /tmp/*.log`、`cp *.txt /dest/`、`mv *.tmp /tmp/`）——**注意**：即便该写命令只是命令序列中的一个片段（如 `echo hi; rm -rf src/*.ts`），只要该片段本身含未加引号的 glob，仍触发 glob_expansion
- glob 嵌套在写操作的参数中（如 `echo > /tmp/*.log` 的重定向目标）

#### Scenario: 项目内 ls glob 自动放行

- **WHEN** bash 命令为 `ls openspec/changes/archive/*/`，projectRoot 为 `/Users/eliot/my/@permission-system:pi-extension`
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-system:pi-extension/openspec/changes/archive/] }`（按前缀目录读处理），不触发 glob_expansion

#### Scenario: 项目内 cat glob 自动放行

- **WHEN** bash 命令为 `cat openspec/specs/*/spec.md`，projectRoot 内
- **THEN** 提取结果为 `{ reliable: true, targets: [read /Users/eliot/my/@permission-system:pi-extension/openspec/specs/] }`，不触发 glob_expansion

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
