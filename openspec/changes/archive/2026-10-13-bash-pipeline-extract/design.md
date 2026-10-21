# Design

## Context

审计日志（87 条）显示 **76 条 allow_once 都是 bash 命令弹窗**，真正需要用户判断的不到 10 条。绝大多数弹窗来自两个误伤源：

1. **`UNRELIABLE_PATTERNS` 未做引号感知**（占 ~57%）：`/\|/` 正则命中 grep -E 模式串里的字面 `\|`（如 `grep -n "FAIL\|error"`）、grep 的 `-oE '"id":"[^"]*"'` 双引号内的字面量、`git log --oneline | grep -E "foo\|bar"` 双重误伤
2. **`COMMAND_TABLE` 未覆盖主流开发命令**（占 ~26%）：`git log` / `npm test` / `openspec status` 等——这些命令要么无文件参数（0 target），要么只在项目内操作，本可静默放行

同时 `bash-extract.ts` 用 `/\|/` 一刀切把所有管道判为"不可靠"——过滤器流水线（head/tail/sort/grep/awk/sed/tee/wc/tr/cut）对文件系统无副作用，判不可靠制造了不必要的用户摩擦。真正危险的是"转发器" stage（`xargs`、`parallel`），它们把 stdin 当命令参数，静态分析必须放弃。

`extensions/index.ts` 的 `promptUser` 里 tier=two 分支硬编码了"未配置路径 / add declaration to permission.json"的副文本，但实际调用 tier=two 只有两个来源：外层敏感路径（无法持久化的语义合理）、bash-unreliable（与 permission.json 无关）。文案与场景错配。

架构基线不变：`bash-extract` 是纯函数、返回 `{reliable, targets|rawCommand}` 联合类型；`decide` 是决策引擎、只看策略与路径；`extensions/index.ts` 只做拦截、UI、记忆。本 change 严守三层解耦——只动 bash-extract 与 prompt 副文本分派。

## Goals / Non-Goals

**Goals:**

- **修复 82% 的误伤弹窗**：引号感知扫描 + SILENT_COMMANDS 白名单 + 管道拆分三者协同，消除审计中 npm test / grep -E / grep -oE / git / openspec 等高频命令的弹窗
- 保留"转发器流水线"（`xargs`、`parallel`、`pforeach`）的保守弹窗——它们消费 stdin 作为下游命令参数，静态分析必须放弃
- 修复 tier=two 弹窗副文本，让用户能理解"为什么弹这个"以及"如何彻底解决"
- 不动决策契约、不动信任记忆 schema、不动配置 schema、不动审计 schema

**Non-Goals:**

- **不做 bash 字符串信任**：本 change 不引入任何形式的"session/persistent 层允许 bash 命令"（讨论中的 a3/a4/a5 方向暂不做）。`SILENT_COMMANDS` 白名单不是 bash 信任——它仅是"这个命令名本身不携带文件系统参数"的声明，与 session/persistent 授权机制无关
- **不修 while/for/if/until/case 控制流关键字漏洞**：`while read x; do rm foo; done` 目前被误判为 reliable 0-target。这是与管道同源的"复合命令语义漏洞"但独立触发，已记入 `openspec/todo.md` 待办池，走独立 change 处理
- **不修 `bash -c` / `sh -c` / `dash -c` / `zsh -c` 类 shell 内嵌命令盲区**：`bash -c "rm -rf /"` 目前被 D6 的"未识别 = 0 target"逻辑放行（`bash` 不在 `COMMAND_TABLE`，字符串内层 `rm -rf /` 不被 tokenize/extract）。**这是 pre-existing 盲区**（现有 `UNRELIABLE_PATTERNS` 也未拦下，与 while/for 控制流关键字同类），D6 明确把"未识别 = 0 target"作为本 change 的核心哲学。本 change 不修但**显式承认**该盲区，已记入 `openspec/todo.md` 待办池走独立 change
- **不引入更完整的 shell 解析器**：不引入 tree-sitter、bash-parser 等第三方库。项目约束"不引入 wasm/native 依赖"
- **不重构 COMMAND_TABLE**：本 change 不修改既有 27 个命令的 extractor 行为（rm/cp/mv/cat/grep/tee/...）。新增的是独立的 `SILENT_COMMANDS` 集合，与 `COMMAND_TABLE` 正交——见 D10
- **不处理多行命令**：`\` 续行、heredoc 内容行——目前 `heredoc` 已判不可靠，续行不在范围内

## Decisions

### D1: splitPipelines 算法——顶层扫描 + 引号感知

**决策**：`splitPipelines` 采用**字符级扫描 + 引号感知 + 顶层检测**的算法：

```
char-by-char scan:
  - 跟踪单引号、双引号开合状态（quote = null | "'" | '"'）
  - 遇到反斜杠跳过下一字符（quote 状态不感知转义，转义单独处理）
  - 遇到 '|'：
    - quote !== null → 忽略
    - 后面是 '|'（即 '||'）→ 跳过 2 字符（逻辑或）
    - 前面是 '|' 且当前处于顶层 → 说明刚拆过一个 stage（这个逻辑由循环自然保证：每次拆完 cur 归零）
    - 其他情况 → 拆点，push(cur) 到 stages，cur 归零
```

**理由**：

- 字符级而非正则：正则在处理 `||` vs `|`、引号内 `|`、转义 `\|` 时容易出错。手写扫描虽然代码多几行但边界更明确
- 只做拆分，不做嵌套引号（如 `$(echo '"')` 这类）处理：嵌套引号属于命令替换范畴，已被 UNRELIABLE_PATTERNS 拦下，不会走到 splitPipelines
- 保持"纯函数、无副作用、不修改输入字符串"的既有约定

**Alternative 考虑过**：

- **正则拆分 `cmd.split(/\|/)`**：太粗糙，会把 `||` 拆开、会拆引号内的 `|`。否决。
- **调用 bash 自身的 `-c 'echo $@' _ $cmd`**：会执行用户命令，安全灾难。否决。
- **调用 bash-parser 库**：引入外部依赖，破坏"无 wasm/native"约束。否决。

### D2: 转发器命令表——显式白名单

**决策**：定义 `FORWARDING_COMMANDS: Set<string>`，初始包含 `xargs`、`parallel`、`pforeach`。检测规则：

- 命令名精确匹配（不模糊）
- 该 stage **不是第一个**（有管道输入）
- 命中即整条命令判 `{ reliable: false, reason: "forwarding_command" }`

**理由**：

- 白名单而非黑名单：转发器是一个小集合且明确，用集合查找（O(1)）比"识别所有非转发器过滤器"更稳。过滤器列表随时在扩展（`awk`、`perl -ne`、`jq -f -` 等），黑名单维护成本过高
- 首 stage 豁免：这里的"首 stage"是指整个 bash 命令（已经按 `;` / `&&` / `||` 拆过后的命令）中的 stage 位置。具体地：命令先按 `splitCommands` 拆成多个"命令片段"，每个片段内部再按 `splitPipelines` 拆成 stage。当 xargs 位于某个片段的首 stage（即无管道上游）时不触发守卫。例：`echo hi; xargs --help` 是两个片段（以 `;` 分隔），第二个片段的 `xargs --help` 是首 stage、无管道上游，不触发；`find /etc | xargs rm` 是一个片段（无命令分隔符），`xargs rm` 是第 2 stage、有管道上游，触发守卫

**Alternative 考虑过**：

- **把 xargs 加入 COMMAND_TABLE 尝试解析**：`xargs` 的参数（`-I{}`、`-n`、`-L`、`-a file` 等）组合爆炸，任何静态分析都不可靠。否决。
- **用 ARGV 分析**（检查 xargs 后面是否有路径参数）：`find /etc | xargs rm` 里 `rm` 是 xargs 调用时的第一个参数，但实际 rm 的参数由 xargs 从 stdin 拼装，静态分析无法确定。否决。

### D3: tee 与其他"过滤器带副作用"命令

**决策**：不特殊处理。`teeExtract` 已经按 arg 提取 write targets，pipeline 拆分后各 stage 独立跑 extractor，`tee /tmp/x` 在 stage 2 里会正常被识别为 write target。

**验证**：spec 场景 `tee 在管道中仍提取写 target`（`echo hi | tee /tmp/log.txt` → 提取写 target `/tmp/log.txt`）覆盖此点。

**Alternative 考虑过**：

- **tee 加入 FORWARDING_COMMANDS**：过保守。`tee` 的下游行为只有"复制到文件 + 透传到 stdout"，不产生新的 filesystem 副作用。否决。

### D4: `reason` 字段规范

**决策**：新增的 `reason: "forwarding_command"` 是**新的 reason 值**，与既有 `pipeline`、`command_substitution`、`glob_expansion` 等并列。字符串小写，蛇形命名，与既有约定一致。

审计日志 `note` 字段沿用现有的 `extraction.reason` 拼进 reason 字符串的模式（见 `extensions/index.ts:314`），无需 schema 变更。

**注意**：本 change 落地后，既有 `UNRELIABLE_PATTERNS` 里的 `{ pattern: /\|/, reason: "pipeline" }` **删除**——因为管道不再走 UNRELIABLE 通道，改由 stage 级检测处理。这是唯一对既有 `reason` 值的破坏性影响：`grep "reason.*pipeline" 审计日志` 会命中历史数据但未来不再产生新条目。这个影响可接受：

- 审计是历史档案，不修改既有日志
- 未来新条目的 `reason: "forwarding_command"` 反而更精确——它明确了"是因为有转发器"而非笼统"pipeline"

### D5: promptUser 副文本分派

**决策**：`promptUser` 增加第 4 个参数 `subtitle: string`（可选，默认空），调用点根据 `decision` 类型决定传入的副文本。签名变更是**向后兼容**的（旧调用不传参数仍用默认）。

**合并语义：替换而非追加**。tier=two 下现有的硬编码副文本 `(No "Always allow" for unconfigured paths. To persist, add a declaration to permission.json.)` **被新的分派文案完全替换**——不追加、不保留。理由：旧文案对"外层敏感路径"和"bash-unreliable"两个真实场景都不准确（一个说"unconfigured"但其实是"sensitive_default"；一个说"add declaration to permission.json"但实际无法通过配置修复），保留旧文案会让新分派文案的准确性被旧文案干扰。既有测试 AF4（断言包含 "no 'always allow'" 或 "unconfigured" 英文子串）因本次替换会**失效**，需要在 RED 阶段（task 1.2）同步更新 AF4 的断言为新的中文副文本子串。

**分派规则**（在 `handlePromptDecision` 里判定，不放在 `promptUser` 内部）：

```ts
let subtitle = "";
if (decision.tier === "two") {
  if (bashCommand && decision.declaration === "unconfigured") {
    subtitle = "命令无法静态解析，请审阅整条命令；无法通过配置持久化。";
  } else if (decision.declaration === "sensitive_default" && decision.region === "project_outer") {
    subtitle = "敏感系统路径不能持久化，如需长期允许请编辑 permission.json。";
  }
} else if (decision.tier === "three") {
  // 沿用现有："Always allow 保存到 <trustedPath>"
  subtitle = `Note: "Always allow" saves to ${prettyPath(trustedPath)}`;
}
```

**既有测试影响（AF4）**：
- 既有 `extensions/index.test.ts` 的 AF4 断言 `capturedPrompt.toLowerCase().includes("no 'always allow'") || capturedPrompt.toLowerCase().includes("unconfigured")` 会因替换失效
- RED 阶段（task 1.2）同步修改 AF4：外层敏感路径测试的断言改为检查中文副文本子串（如 "敏感系统路径不能持久化"）；tier=two 弹窗的选项数量（3 个）与"不出现'总是允许'"的断言保持不变
- tasks.md 3.1 声称"AF1–AF10 全部继续通过"需要修正——AF4 需要修改断言，其他 9 条继续通过

**理由**：

- 副文本的分派逻辑依赖 `decision` 字段（`declaration`、`region`、`bashCommand`），放在 `handlePromptDecision` 层是"数据流驱动"，而非 `promptUser` 内部猜测
- `promptUser` 保持"只负责 UI 呈现"的职责单一
- tier=three 的副文本保持向后兼容（既有测试 AF3 依然通过）

**Alternative 考虑过**：

- **给 `decision.ts` 增加一个 `uiHint` 字段**：让决策引擎直接输出"用户应该怎么理解这个决策"。否决——耦合太重，决策引擎不该关心 UI 文案。
- **`promptUser` 内部根据 tier 分派**：`promptUser` 只接收 `tier` 而没有 `declaration` / `region` / `bashCommand` 上下文，需要额外传更多参数才能分派。否决——参数爆炸。

### D6: 首 stage 中"无 extractor 命令"的处理

**决策**：如果一个 stage 里的命令名不在 `COMMAND_TABLE` 且没有重定向（例如 `npm test`、`git status`），该 stage 贡献 0 个 target，**不判整条命令不可靠**——只影响该 stage 的贡献。

**理由**：

- 保持"未识别命令 = 0 target"的既有语义（`npm test 2>&1 | tail -8` 里 `npm test` 不识别、`2>&1` 是 fd 重定向（跳过）、`tail -8` 无路径参数 → 3 个 stage 都 0 target → reliable true、targets 空 → 走 auto-allow 路径）
- 与"用户变量导致不可靠"的语义区分：变量是**已知**的不确定性，未识别命令是**未知的 0**——前者我们不知道要访问什么所以必须问，后者我们知道 stage 里根本没提文件路径所以可以直接放行
- 潜在风险：`echo $(curl -x /etc/passwd)` 会漏——但命令替换 `$(...)` 已经在 UNRELIABLE_PATTERNS 里，兜得住

**Alternative 考虑过**：

- **未识别命令 = 整条命令不可靠**：过于保守，`npm test`、`git commit` 等日常命令会被强制弹窗。否决。
- **未识别命令 = tier=two 弹窗但跳过 target 检查**：需要引入"部分不可靠"新状态，改变 `ExtractResult` 联合类型，破坏既有决策契约。否决。

### D7: `scanUnreliable` 引号感知扫描——取代正则 UNRELIABLE_PATTERNS

**决策**：将现有 `UNRELIABLE_PATTERNS: Array<{pattern: RegExp, reason: string}>` 从正则匹配改为**字符级扫描函数** `scanUnreliable(cmd: string): string | undefined`（返回首个命中的 reason 或 undefined）。扫描器跟踪以下状态：

```
state: { quote: null | "'" | "\"", escaped: boolean }
for each char:
  if escaped:
    skip next char (unconditionally)
    continue
  if backslash:
    escaped = true; continue
  if quote state is open:
    if char matches open quote: quote = null
    else: skip (all chars inside quote are literal)
    continue
  if char is ' or ": open quote; continue
  # outside quote, check unreliable patterns
  if char is '|': reason "pipeline" (handled by splitPipelines instead)
  if char is '$' and next is '(': reason "command_substitution"
  if char is '`': reason "backtick_substitution"
  if char is '<' and next is '(': reason "process_substitution_input"
  if char is '>' and next is '(': reason "process_substitution_output"
  if char is '<' and next is '<': reason "heredoc"
  if char is '(' or ')' at top level: reason "subshell"
  if glob metachar (* ? [) at token start: reason "glob_expansion"
```

**关键语义**：

- **单引号 `'...'`**：引号内所有字符都是字面量，包括 `$`、`\`、`"`。bash 里单引号内 `\` 是字面反斜杠，不做转义
- **双引号 `"..."`**：引号内 `$` 和 `\` 仍有效（`\$`、`\\`、`\"`、`\n` 等 bash 转义），但 `$` 后面接非 `{`、非 `(` 时不是命令替换；扫描器只在 `$` 后接 `(` 时才触发 command_substitution
- **转义 `\X`**（引号外）：`\|`、`\$`、`\``、`\(`、`\)` 都被视为字面字符，不触发对应 reason
- **管道 `|` 由 `splitPipelines` 处理**：扫描器遇到 `|` 时不返回 reason（splitPipelines 负责拆分），仅用于识别 `||` 逻辑或
- **glob 检测限于顶层 token 起始**：`"foo*bar"` 双引号内不触发；`rm foo*` 触发；`rm foo_*` 触发

**理由**：

- **审计数据支持**：87 条审批中约 57 条来自引号误伤（grep -E `\|` 字面量、grep -oE 双引号字面量、git log `|` 组合），这是当前最大误报源
- **`pattern.test()` 的正则局限**：JS 正则无法原生区分引号内外；用 `(?<!['"])(?<!\\)` 之类负向先行断言能部分解决但无法处理引号开合配对（`"foo\|bar"` vs `"foo\|bar" and echo baz\|qux` 无法用单个正则精确判定）
- **字符扫描代码量少**：约 60 行 TypeScript，比手写嵌套正则更清晰，性能与正则相当（都是 O(n)）
- **保持 reason 值语义**：既有 reason（`command_substitution`、`backtick_substitution`、`glob_expansion`、`process_substitution_input` 等）语义不变，只是**触发点**从"任意位置"变为"引号外且未转义的位置"

**Alternative 考虑过**：

- **保留正则数组 + 引号清理预处理**：先把引号内容替换为占位符，跑正则，再还原。否决——占位符会污染 rawCommand 字段（如果清理失败），且占位符长度不同会影响 line/column 报告
- **用 bash 词法分析库**：如 `shell-words`。否决——引入外部依赖，破坏"无 wasm/native"约束；且 bash 词法分析本身对 `$()` 与 `` ` `` 的嵌套处理不总是可靠
- **只用负向先行断言正则**：`/(?<!['\"])[|`$()<>/]/` 等。否决——bash 的引号嵌套（如 `"'"'"`）用单个正则无法精确判定开合

**测试**：BTP11–BTP17 七个测试覆盖引号感知的各种边界；覆盖引号外保持严格（BTP14 无引号命令替换仍判不可靠）

### D8: SILENT_COMMANDS 静默命令白名单——独立于 COMMAND_TABLE

**决策**：新增 `SILENT_COMMANDS: Set<string>`，初始包含：`git`、`npm`、`npx`、`yarn`、`pnpm`、`make`、`tsc`、`go`、`cargo`、`openspec`、`rg`、`jq`、`tree`、`du`、`df`、`file`、`less`、`more`、`which`、`env`、`uname`、`echo`、`printf`、`true`、`false`。这些命令被视为 **0-target 静默**：extractor 存在但永远返回 0 target，即使后面跟管道或跟路径参数也不提取。

**关键判定**：`SILENT_COMMANDS` 与 `COMMAND_TABLE` **正交且互斥**：

```
const extractor = COMMAND_TABLE[cmdName];      // 优先：显式提取 targets
if (extractor) { extractor(...); continue; }
if (SILENT_COMMANDS.has(cmdName)) continue;    // 静默：0 target，不判不可靠
// 否则：D6 逻辑，未识别命令贡献 0 target
```

**SILENT_COMMANDS 与 FORWARDING_COMMANDS 的优先级**：`FORWARDING_COMMANDS` 检查在 pipeline 拆分的 stage 循环内，早于 extractor 查找；所以 `find /etc | xargs rm` 中 `find` 在 SILENT 里但 `xargs` 触发转发器，仍判不可靠（BTP22 覆盖）。

**理由**：

- **审计数据支持**：26% 弹窗来自 git/npm/openspec 类未识别命令。`git log`、`npm test`、`openspec status` 都是纯项目开发工具，其文件系统副作用被 git/npm 自身约束在项目 worktree 内，属于既有决策引擎 "project-inner 默认允许" 的覆盖范围
- **不加到 COMMAND_TABLE 的理由**：`COMMAND_TABLE` 的 extractor 语义是"从 arg 提取路径并交给决策引擎"，如果给 git 加 extractor，`git log /some/path` 就会被误提取成 read target（但 `git log` 的 path 参数是"限制范围"而非"读取"，语义不同）；把 git 加入 SILENT 保持"0 target" 语义正确
- **SILENT 集合小**：12 个常见开发命令（git/npm/npx/yarn/pnpm/make/tsc/go/cargo/openspec/rg/jq），白名单维护成本低。宁可少加几个也不多加——多加的代价是"不该放的命令被静默"，少加的代价是"该静默的命令每次弹窗"。tree/du/df/file/less/more 已在 COMMAND_TABLE 中（正常提取 target），不重复加入 SILENT_COMMANDS（与 COMMAND_TABLE 严格互斥）
- **可审计性**：`SILENT_COMMANDS` 集中在一处，维护者可 diff 审计

**Alternative 考虑过**：

- **给 git/npm 加 extractor 尝试提取子命令路径**：否决——`git commit -m "msg"`、`git push origin`、`git checkout main`、`npm install foo@1.0.0` 等大量子命令的"路径"参数不是文件系统路径而是仓库/包名。误提取会引入假阳 target，反而增加决策引擎负载
- **加入决策引擎的 `knownBashSafeCommands`**：否决——违反三层解耦（决策引擎不该关心 bash 命令名）
- **动态学习：审计记录里的 allow_once 命令自动加入 SILENT**：否决——需要 session/persistent 层机制，与 Non-Goals "不做 bash 字符串信任" 冲突

**边界与安全考量**：

- `git rm` / `git checkout -- file` 类有 write 副作用的子命令：不提取 target，但因 `git` 在 SILENT 里静默放行。**已知风险**——但 git 自身约束改动在 worktree 内，属于 project-inner 默认允许范围。如果项目配置了 unread 或 read_only 路径在 worktree 内，那些路径的 write 会被决策引擎的 file tool 通道拦截（read/write/edit 工具仍走决策引擎），bash 通道不检查
- `npm install` / `yarn install` / `pnpm install`：有网络副作用（下载包）与 node_modules 写入。决策引擎不检查网络；node_modules 在 project-inner 默认允许。可接受
- `cargo build` / `go build`：写 target 目录，同样在 project-inner 默认允许范围

**测试**：BTP18–BTP22 五个测试覆盖 SILENT 与 FORWARDING 的正交边界

## Risks / Trade-offs

- **风险 1：管道拆分漏处理边界**（中风险，缓解：单元测试覆盖）
  - 边界：`\|`（转义）、`|&`（同时 pipe stdin+stderr）、管道中的引号嵌套（`echo 'a' | echo 'b'`）
  - 缓解：`|&` 在 bash 里是 GNU 扩展而非 POSIX——保守起见当普通 `|` 处理（拆开），因为 bash 会在 pipe 阶段传递 stdin+stderr，语义与 `2>&1 | ` 类似，拆分后 `tee`、`xargs` 等仍能正确识别
  - `|&` 拆后左 stage 是 `echo a`（0 target），右 stage 是 `tee /tmp/x`（提取 target）——结果正确
  - 测试：新增 BTP4（引号内管道字符不拆分）、BTP9（逻辑或逻辑与不视为管道）

- **风险 2：转发器命令白名单不完整**（低风险，缓解：显式文档 + 未来扩展路径）
  - 未来若有新的转发器命令（`pmap`、`dispatch` 等），需要更新 `FORWARDING_COMMANDS`
  - 缓解：在 `bash-extract.ts` 顶部注释里说明"转发器定义：消费 stdin 作为下游命令参数的命令"，便于后续维护者判断
  - 保守选择：宁可漏几个新命令也不误报过滤器命令。漏报的代价是"该弹窗没弹"，误报的代价是"每次日常命令都被打断"

- **风险 3：审计日志语义连续性**（低风险）
  - 未来 `reason: "pipeline"` 不再产生，仅出现在历史日志
  - 缓解：审计消费方若硬编码 `"pipeline"` 字符串匹配，会看到未来条目缺失——但这本来就是"更精确的原因"迁移，属于正向演进

- **风险 4：与既有权限扩展（`permission-gate` 等）叠加**（可忽略）
  - pi 的多个扩展同时启用时，本扩展与内置扩展的决策是"最保守胜出"叠加
  - 本 change 让决策更"宽容"（更多 auto-allow），叠加后仍然正确——只要没有扩展把"pipeline 一刀切"当成安全兜底，语义一致

- **风险 5：与 `installPromptGuardrails` 提示不一致**（低-中风险，缓解：更新 guardrail 文案）
  - `extensions/index.ts` 里 `BASH_GUARDRAILS` 第一条写"Bash: avoid unquoted `|` (pipes) ... the permission system cannot extract targets from such commands"——这句话在本 change 后不再准确
  - 缓解：同步更新 guardrail 文案为"Bash: avoid `xargs`/`parallel` in pipelines ... the permission system treats them as unreliable and will prompt"——本 change 的 tasks 里包含此更新

- **风险 6：SILENT_COMMANDS 过度放行**（中风险，缓解：审计数据 + 测试边界）
  - 例：`git rm -r /path` 会被 SILENT 静默，实际有 delete 副作用（虽然被 git 约束在 worktree 内）
  - 缓解：
    - SILENT 集合严格白名单，只包含主流开发工具的"项目内操作"命令
    - 决策引擎的 file tool 通道（read/write/edit）仍对 unread/read_only 配置的路径生效——bash 通道不检查，但典型 git/npm 操作会读写的是 worktree 内的文件
    - 测试 BTP21（rm 不在 SILENT，仍走 COMMAND_TABLE 提取 write target）与 BTP22（SILENT 不遮盖 FORWARDING）保证正交边界

- **风险 7：引号感知扫描边界遗漏**（中风险，缓解：BTP11–BTP17 六个测试覆盖）
  - 例：嵌套引号（`"'"'"`、`"\"'"\""`）、heredoc 与引号混合、多行命令
  - 缓解：单引号/双引号配对处理保持简单（不处理 bash 的引号嵌套技巧）；heredoc 内容行本身判不可靠（`<<EOF` 触发 heredoc reason），扫描器不处理多行
  - 漏报的兜底：`bash -c`、while/for 控制流已在 todo.md 独立跟踪；其他漏报场景通过审计数据在后续 change 中迭代

- **trade-off: 不处理 `while read x; do ...; done`**（记录）
  - 与管道同源的问题（复合命令的语义分析）
  - 已记入 `openspec/todo.md` 待办池，走独立 change
  - 本 change 不解决该问题的合理性：控制流关键字（`while`、`for`、`if`、`case`）的静态分析比管道复杂（要处理循环体内变量、递归引用），单独立项更清楚
