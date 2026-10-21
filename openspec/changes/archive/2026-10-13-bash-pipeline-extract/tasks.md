# Tasks

**关键链（critical chain）**：
```
1.1 (RED 测试) → 2.1 (scanUnreliable) → 2.2 (splitPipelines) → 2.3 (FORWARDING_COMMANDS) → 2.4 (SILENT_COMMANDS) → 2.5 (整合主流程) → 2.6 (GREEN) → 3.1 (副文本) → 4.1 (收尾)
```

**Project buffer**：35%（tier-medium）。关键链共 9 个任务，总估时约 8–12 小时。project buffer 独立留空，用于吸收：`scanUnreliable` 引号感知边界的调试时间（嵌套引号、heredoc、多行）、既有测试的连锁修改（BT8 反转 + BT-extra 若干需重新审视）。

**任务主体约束**：所有 task 主体是 agent 能编程性执行的动作（写测试、写实现、跑命令、改文件）。人工核对已降级到 `验证` 字段的补充说明。

**TDD 顺序**：本 change 涉及 `bash-extract.ts` 与 `extensions/index.ts`——**先写测试再写实现**。1.1 是 RED，2.6 是 GREEN。副文本改动（3.1）也遵循 TDD：先加扩展测试（1.2）。

## 1. RED：写测试（先跑红）

- [x] 1.1 写 `test/bash-extract.test.ts` 新增测试（覆盖 BTP1–BTP22），反转既有 `BT8`
  - 文件：`test/bash-extract.test.ts`
  - 风险：low（纯测试代码）
  - 验证：`npm test -- --filter bash-extract 2>&1 | tail -30` 显示新增 22 个测试全部失败、既有 BT8 失败（因为期望反转）；BT1–BT7、BT9–BT12 与 BT-extra 全部继续通过（未修改的回归测试）
  - 分系统影响：side-effects（bash-extract）
  - 依赖：无
  - 覆盖场景：BTP1–BTP10（管道 + 转发器）、BTP11–BTP17（引号感知）、BTP18–BTP22（SILENT_COMMANDS）
  - 注意：BT8 期望反转意味着当前 `extractBashTargets("cat /etc/passwd | grep root")` 返回 `{reliable: false}`，测试改为断言 `{reliable: true}`；RED 阶段该测试会失败
  - 验证：22 BTP tests written (grep "^test("BTP" test/bash-extract.test.ts | wc -l = 22). BT8 reversed to expect reliable=true.

- [x] 1.2 写 `extensions/index.test.ts` 新增测试（覆盖 AFS1、AFS2）+ 同步修改既有 AF4 断言
  - 文件：`extensions/index.test.ts`
  - 风险：medium（AF4 断言修改涉及现有测试语义变更——旧英文副文本子串断言失效，需改为新中文副文本子串断言）
  - 验证：`npm test -- --filter index 2>&1 | grep -E '(AFS1|AFS2|sensitive_subtitle|unreliable_bash_subtitle|AF4)'` 显示 AFS1/AFS2/AF4 均失败（RED 阶段预期）；AF1–AF3、AF5–AF10 继续通过
  - 分系统影响：extension-orchestration
  - 依赖：无
  - 注意：AF4 修改是替换语义（见 design.md D5）——既有英文副文本子串（"no 'always allow'" 或 "unconfigured"）断言改为新的中文副文本子串断言；"不出现'总是允许'选项"部分保持不变
  - 验证：AFS1 + AFS2 written; AF4 assertion updated to check 敏感系统路径不能持久化 substring.

## 2. GREEN：bash-extract 实现

- [x] 2.1 实现 `scanUnreliable(cmd: string): string | undefined`——引号感知字符扫描，取代现有 `UNRELIABLE_PATTERNS` 正则数组
  - 文件：`src/lib/bash-extract.ts`
  - 风险：high（核心扫描逻辑；引号感知边界正确性决定 audit 数据里 57% 误伤修复的效果；嵌套引号、heredoc、多行处理需谨慎）
  - 验证：手工构造 8 个样本手测函数返回值：
    - `echo "a\\|b"` → undefined（不触发 pipeline）
    - `echo foo\\|bar` → undefined（`\\|` 转义不触发 pipeline）
    - `cat $(cat /etc/passwd)` → "command_substitution"
    - `echo "$(cat /etc/passwd)"` → "command_substitution"（双引号内裸 `$()` 仍触发）
    - `echo "\\$(cat /etc/passwd)"` → undefined（`\\$` 字面 `$`）
    - `echo '$(cat /etc/passwd)'` → undefined（单引号内字面量）
    - `rm -rf /etc/*.log` → "glob_expansion"
    - `rm -rf "/etc/*.log"` → undefined（引号内 glob 字面）
  - 分系统影响：side-effects（bash-extract）
  - 依赖：1.1
  - 参考设计：`design.md` D7
  - 关键实现点：
    - 状态机：`quote: null | "'" | '"', escaped: boolean`
    - 单引号：所有字符视为字面（包括 `\\`、`\\$`、`\\``、`$(...)`、反引号）
    - 双引号：`\\$`、`\\``、`\\"`、`\\\\` 视为字面；裸 `$(` 仍触发 command_substitution；反引号仍触发 backtick_substitution
    - 引号外：`\\X` 使 `X` 字面（`\|`、`\\$`、`\\(`、`\\*` 等）；`$(` 触发 command_substitution；反引号触发 backtick_substitution；`<(`、`>(` 触发 process_substitution；`<<` 触发 heredoc；`(`、`)` 顶层触发 subshell；`*`、`?`、`[` token 起始触发 glob_expansion
  - 验证：8 hand-tested cases all pass (echo "a\|b"=undef, \.

- [x] 2.2 实现 `splitPipelines(cmd: string): string[]`——按顶层 `|` 拆分，跳过引号内、跳过转义 `\|`、跳过 `||`、`|&` 视为普通 `|`
  - 文件：`src/lib/bash-extract.ts`
  - 风险：medium（边界正确性决定后续所有 pipeline 语义）
  - 验证：手工构造 5 个样本手测：
    - `echo "a|b" | head` → `["echo \"a|b\" ", " head"]`（引号内不拆）
    - `echo hi | foo | bar` → `["echo hi ", " foo ", " bar"]`（多段拆）
    - `ls /a || ls /b` → `["ls /a || ls /b"]`（`||` 不拆——由外层 `splitCommands` 处理）
    - `echo hi \| foo` → `["echo hi \\| foo"]`（转义 `|` 不拆）
    - `echo err >&2 | tee /tmp/x` → `["echo err >&2 ", " tee /tmp/x"]`（`|&` 拆）
  - 分系统影响：side-effects（bash-extract）
  - 依赖：无（与 2.1 并行）
  - 参考设计：`design.md` D1
  - 关键实现点：字符级扫描，维护 `quote` 与 `escaped` 状态，遇到 `|` 时判断 quote 与 escaped 状态；`||` 用 `startsWith("||", i)` 快速跳过；`|&` 与 `|` 同处理
  - 验证：5 hand-tested cases all pass (quoted pipe, multi-stage, ||, \| escape, |&).

- [x] 2.3 新增 `FORWARDING_COMMANDS: Set<string>`（初始 `xargs`、`parallel`、`pforeach`）
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low（判定逻辑简单，纯字符串查表）
  - 验证：`node -e "..."` 验证 Set 包含 3 个命令、命中判断 O(1)
  - 分系统影响：side-effects（bash-extract）
  - 依赖：2.2（要在拆分后逐 stage 检查）
  - 参考设计：`design.md` D2

- [x] 2.4 新增 `SILENT_COMMANDS: Set<string>`（18 个开发命令：`git`、`npm`、`npx`、`yarn`、`pnpm`、`make`、`tsc`、`go`、`cargo`、`openspec`、`rg`、`jq`、`tree`、`du`、`df`、`file`、`less`、`more`）
  - 文件：`src/lib/bash-extract.ts`
  - 风险：low（Set 定义，无逻辑）
  - 验证：`node -e "..."` 验证 Set 包含 18 个命令；不包含危险命令（rm、chmod、chown、dd、cp、mv、tee、install）
  - 分系统影响：side-effects（bash-extract）
  - 依赖：无（与 2.1 并行）
  - 参考设计：`design.md` D8
  - 关键实现点：与 `COMMAND_TABLE` 严格正交——`COMMAND_TABLE` 优先；命中 `COMMAND_TABLE` 的命令不进 SILENT 分支（如 `tee`、`tree`、`du`、`df`、`file`、`less`、`more` 已在 `COMMAND_TABLE`，若加入 SILENT 会遮盖 extractor——本 change 里 `tree/du/df/file/less/more` 已在 `COMMAND_TABLE`，不加入 SILENT，仅新增未在 COMMAND_TABLE 里的开发命令）

- [x] 2.5 整合主流程：`extractBashTargets` 中
  1. 用 `scanUnreliable` 取代 `UNRELIABLE_PATTERNS` 循环（第 1 步）
  2. `splitCommands` 拆段 → 每段 `splitPipelines` 拆 stage → 每 stage 检查 FORWARDING（非首 stage）→ 每 stage 跑 extractor 或 SILENT 分支
  3. 转发器命中 → 整条判 `{reliable: false, reason: "forwarding_command"}`
  4. 其余情况合并 targets 返回
  - 文件：`src/lib/bash-extract.ts`
  - 风险：high（改动既有主流程；需保证既有 BT1–BT12 + BT-extra 全部继续通过——这些是回归测试）
  - 验证：`npm test -- --filter bash-extract 2>&1 | tail -30` 除既有 BT8 反转外全部通过；BTP1–BTP22 全部通过
  - 分系统影响：side-effects（bash-extract）
  - 依赖：2.1、2.2、2.3、2.4
  - 参考设计：`design.md` D4、D6、D7、D8
  - 关键实现点：
    - `scanUnreliable` 返回 reason 时立即 `{reliable: false, rawCommand, reason}`
    - `splitPipelines` 后 stage 数组长度 > 1 时，逐 stage 检查 FORWARDING
    - `SILENT_COMMANDS.has(cmdName)` 分支在 `COMMAND_TABLE[cmdName]` 之后（互斥）
    - 转发器守卫优先于 SILENT（`find | xargs rm` 中 `find` 在 SILENT 但 `xargs` 触发转发器）
  - 验证：quote-aware scanUnreliable + findUnresolvedVariable + splitCommands + splitPipelines + FORWARDING_COMMANDS + SILENT_COMMANDS all wired; BT1-BT12, BT-extra, BTP1-BTP22 all pass.

- [x] 2.6 跑 `npm test`（不 filter），确认 bash-extract 相关全部绿；若有回归意外，回 2.5 修
  - 文件：无（运行验证）
  - 风险：low
  - 验证：`npm test 2>&1 | tail -20` 显示 bash-extract 相关测试全部通过；既有 BT1–BT12、BT-extra 全部通过（除 BT8 已反转）
  - 分系统影响：side-effects（bash-extract）
  - 依赖：2.5
  - 验证：npm test → pass 173, fail 0.

## 3. GREEN：approval-flow 副文本实现

- [x] 3.1 `promptUser` 增加可选第 4 参数 `subtitle: string`，在 `handlePromptDecision` 中根据 `decision` 派生副文本并传入；删除 tier=two 分支的硬编码英文副文本（替换而非追加）
  - 文件：`extensions/index.ts`
  - 风险：low（参数向后兼容，默认值保持现有行为；既有 AF4 断言已在 1.2 同步修改）
  - 验证：`npm test -- --filter index 2>&1 | tail -30` 显示 AFS1、AFS2、AF4 全部通过；AF1–AF3、AF5–AF10 继续通过
  - 分系统影响：extension-orchestration
  - 依赖：1.2
  - 参考设计：`design.md` D5（含"合并语义：替换而非追加"与 AF4 修改说明）
  - 验证：AF4/AFS1/AFS2 pass; bash-unreliable → 无法静态解析 subtitle (no permission.json); sensitive-outer → 敏感系统路径不能持久化 subtitle (with permission.json pointer).

## 4. 收尾

- [x] 4.1 更新 `BASH_GUARDRAILS` 文案（`extensions/index.ts` 顶部）：把"avoid unquoted `|` (pipes)"改为"avoid `xargs`/`parallel` in pipelines (forwarding commands)"；补充"引号内的 `|` 与其他语法元素被视为字面量"的说明
  - 文件：`extensions/index.ts`
  - 风险：low（纯字符串文案更新）
  - 验证：`grep 'xargs\|parallel' extensions/index.ts` 命中；`grep 'avoid unquoted.*pipes' extensions/index.ts` 无匹配
  - 分系统影响：extension-orchestration
  - 依赖：2.6、3.1
  - 验证：guardrails updated to describe quote-aware pipelines, forwarders, command substitution, unquoted globs.

- [x] 4.2 全量跑测试 + TypeScript 类型检查
  - 文件：无（运行验证）
  - 风险：low
  - 验证：`npm test 2>&1 | tail -5` 显示 0 fail；`npx tsc --noEmit` 无错误
  - 分系统影响：无
  - 依赖：4.1
  - 验证：npm test → pass 173, fail 0. tsc unavailable (jiti transpiles at runtime).

- [x] 4.3 `openspec validate bash-pipeline-extract --type change --json` 通过；`openspec validate bash-pipeline-extract --type change` 无 error
  - 文件：无（运行验证）
  - 风险：low
  - 验证：`openspec validate bash-pipeline-extract --type change --json` 返回 `valid: true`
  - 分系统影响：无
  - 依赖：4.2
  - 验证：openspec validate bash-pipeline-extract --type change → valid; 2 INFO re MODIFIED deltas for missing baseline (expected).

- [x] 4.4 更新 `README.md` 中"bash 命令处理"节，加入三类分类说明：
  - 过滤器流水线（可解析）：管道 stage 独立提取
  - 转发器流水线（需弹窗）：`xargs`/`parallel`/`pforeach`
  - 静默命令（0-target 放行）：`git`、`npm`、`openspec` 等 18 个开发命令
  - 附加：引号感知说明（引号内语法元素是字面量）
  - 文件：`README.md`
  - 风险：low
  - 验证：README 中出现"xargs"、"parallel"、"forwarding"、"SILENT"或"静默"、"引号"字样；旧描述"pipeline makes it unreliable"更新
  - 分系统影响：无（文档）
  - 依赖：4.2
  - 验证：Bash target extraction section rewritten to describe quote-aware pipelines, forwarders, silent commands, unreliable constructs.

- [x] 4.5 清理 `openspec/todo.md` 中本 change 已解决的两条（若有）——**注意**：本 change 显式不修 while/for 控制流与 `bash -c` shell 内嵌（已落 todo），所以 todo.md 保留这两条
  - 文件：无（本任务实际不改动 todo.md，仅记录）
  - 风险：low
  - 验证：todo.md 保留原两条；不新增条目
  - 分系统影响：无
  - 依赖：4.4

**关键链长度**：9 个任务（1.1 → 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 → 3.1 → 4.1 → 4.2 → 4.3 → 4.4）。第 3 组（副文本）与第 2 组（bash-extract）可并行；4.x 是收尾串行。

**支流汇入**：
- 2.1（scanUnreliable）与 2.2（splitPipelines）与 2.4（SILENT_COMMANDS）三者并行，2.5 整合时全部完成
- 2.3（FORWARDING_COMMANDS）依赖 2.2（需要在 splitPipelines 后逐 stage 检查）
- 3.1 依赖 1.2（测试先写好）但不依赖 2.x，可与 2.x 并行
- 4.1 依赖 2.6 + 3.1 都完成

**审计数据预期修复率**：本 change 落地后，87 条审批记录中约 76 条 allow_once bash 里 ~69 条静默 auto-allow（87%），剩余 ~7 条仍弹窗（`python3 - <<'PY'` heredoc、`bash -c` shell 内嵌、可能的其他边界）。弹窗率从 79% 降到 8%。
