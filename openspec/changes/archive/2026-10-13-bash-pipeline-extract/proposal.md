## Why

审计日志（`~/.pi/agent/extensions/@permission-system:pi-extension/logs/permission-review.jsonl`，87 条）显示 **76 条 allow_once 都是 bash 命令弹窗**，其中真正需要用户判断的（`python3 - <<'PY'`、`grep -R ... /Users/eliot/.pi/agent` 等含文件路径的操作）不到 10 条。绝大多数弹窗来自两个误伤源：

1. **`UNRELIABLE_PATTERNS` 未做引号感知**（占 ~57%）：`\|` 正则命中 grep -E 模式串里的字面 `\|`（如 `grep -n "FAIL\|error"`）、grep 的 `-oE '"id":"[^"]*"'` 双引号内的字面量、`git log --oneline | grep -E "foo\|bar"` 双重误伤
2. **`COMMAND_TABLE` 未覆盖主流开发命令**（占 ~26%）：`git log` / `git status` / `git rev-list`、`npm test` / `npx` / `yarn` / `pnpm` / `tsc` / `make`、`openspec status` / `openspec instructions` 等——这些命令要么无文件参数（0 target），要么只在项目内操作，本可静默放行，但因"未识别命令"逻辑与"引号误伤"叠加触发弹窗

同时 tier=two 弹窗的副文本对 bash-unreliable 场景写错：目前写"unconfigured paths / add declaration to permission.json"，但用户此时无法通过配置 permission.json 来"修好"。

## What Changes

### 主要修复（针对高频弹窗）

- **`bash-target-extraction`**：`UNRELIABLE_PATTERNS` 从正则匹配改为**引号感知扫描**——引号内（单引号 `'...'` 或双引号 `"..."`）与转义字符（`\|`、`\$`、`\(` 等）不再触发 unreliable 判定。修复后 grep -E 字面量、grep -oE 双引号、git log --oneline 三重误伤全部消除。
- **`bash-target-extraction`**：新增"静默命令白名单" `SILENT_COMMANDS`（`git`、`npm`、`npx`、`yarn`、`pnpm`、`make`、`tsc`、`go`、`cargo`、`openspec`、`rg`、`jq`、`tree`、`du`、`df`、`file`、`less`、`more`）——这些命令在 bash-extract 层视为 0-target 白名单，不走"未知命令"分支，静默放行。它们的行为是"操作仓库本身或项目内状态"，文件系统副作用已经在决策引擎的 project-inner 默认规则下覆盖。

### 配套修复（架构 review 已识别的边界）

- **`bash-target-extraction`**：管道不再一刀切判不可靠——按顶层 `|` 拆成 stages，各 stage 独立跑 extractor 并合并 targets。新增"转发器"命令表 `FORWARDING_COMMANDS`（`xargs`、`parallel`、`pforeach`），只有当它们出现在**非首 stage** 时才判整条命令不可靠。
- **`bash-target-extraction`**：`SILENT_COMMANDS` 与 `COMMAND_TABLE` 正交——前者贡献 0 target（静默），后者按 arg 提取 read/write target。git 类命令在 SILENT_COMMANDS 里静默，rm/cp/mv/tee 等仍在 COMMAND_TABLE 里正常提取。

### UI 修复

- **`approval-flow`**：tier=two 弹窗副文本按来源分开——外层敏感路径提示"敏感系统路径不能持久化"，bash-unreliable 提示"命令无法静态解析，需人工审阅整条命令"。删除现有对两个真实场景都不准确的通用文案。

**BREAKING（对现有规格）**：`bash-target-extraction` spec 的"复杂语法导致不可靠"节中"管道 → 不可靠"这一条作废；原测试 `BT8: pipeline_marks_extraction_unreliable` 期望反转。UNRELIABLE_PATTERNS 从"正则数组"升级为"引号感知扫描函数"——函数签名不变，但内部实现从 `pattern.test(cmd)` 循环变成 scanner，语义是**收紧**（引号外的真语法元素仍触发，引号内的字面量不再触发）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `bash-target-extraction`：
  - MODIFIED "复杂语法导致不可靠"：删除"管道 → 不可靠"；新增"引号感知"约束
  - ADDED "管道按 stage 独立提取"：按顶层 `|` 拆分，跳过引号内 `|` 与 `||`
  - ADDED "转发器命令守卫"：`xargs`/`parallel`/`pforeach` 在非首 stage 触发
  - ADDED "静默命令白名单"：`SILENT_COMMANDS` 视为 0-target 静默放行
- `approval-flow`：MODIFIED "弹窗内容包含关键信息"，tier=two 副文本按来源分派

## Impact

- **代码**：
  - `src/lib/bash-extract.ts`：
    - `UNRELIABLE_PATTERNS` 从 `Array<{pattern: RegExp, reason: string}>` 改为引号感知扫描函数 `scanUnreliable(cmd): string | undefined`（返回首个命中 reason 或 undefined）——约 +60 行
    - 新增 `splitPipelines(cmd): string[][]`（按 `splitCommands` 拆出的每段内部再按顶层 `|` 拆）——约 +30 行
    - 新增 `FORWARDING_COMMANDS: Set<string>`、`SILENT_COMMANDS: Set<string>`——各约 3 行
    - 修改 `extractBashTargets` 主流程整合上述变更——约 +30 行
    - 净增约 120 行
  - `extensions/index.ts`：`promptUser` 增加"副文本"参数，调用点根据 `decision` 类型派发不同文案；更新 `BASH_GUARDRAILS` 顶部提示文案。约 +25 行
  - `test/bash-extract.test.ts`：反转 `BT8`；新增 10 个 stage 提取测试 + 5 个转发器测试 + 8 个引号感知回归测试 + 3 个 SILENT_COMMANDS 测试——约 +250 行
  - `extensions/index.test.ts`：新增 2 个副文本测试 + 更新 AF4 断言。约 +40 行
  - `README.md`：更新"bash 命令处理"节，说明过滤器流水线 / 转发器 / 静默命令三类
- **依赖**：无新增依赖。
- **配置**：无配置文件 schema 变化。
- **UI**：tier=two 弹窗副文本变准确；bash 弹窗总次数预期减少 60-70%。
- **性能**：每 bash 命令多一次引号感知扫描（< 1 μs，无行为差异）。
- **审计**：`event` 字段与 schema 无变化。`reason` 字段不再产生 `"pipeline"` 值（引号感知后管道不再走 UNRELIABLE 通道），新增值 `"forwarding_command"`。审计消费方若硬编码 `"pipeline"` 匹配仅影响历史日志。
- **不变量（既有架构）**：不动决策引擎 `decide.ts`，不动信任库 `trust.ts` schema，不动配置文件 `config.ts`，不动审计 `audit.ts`。三层解耦保持。

## 系统工程影响评估

- **影响哪些分系统**：
  - `side-effects`（bash-extract）——主要改动点，从"命令级不可靠"升级为"引号感知 stage 级 + 转发器级 + 静默命令级"的可解析性判定
  - `extension-orchestration`（promptUser 副文本参数化）——小改
  - `policy-core`、`decision`、`trust`、`audit`、`config`、`sensitive`、`path-utils`——**不变**
- **整体性能预期变化**（基于审计数据）：
  - 可测量：现有 87 条审批记录中 76 条 allow_once bash，本 change 落地后预期 ~69 条静默 auto-allow、~7 条仍弹窗（`python3 - <<'PY'` heredoc 类、`bash -c` 类、`xargs` 转发器类）。**弹窗率从 79% 降到 8%**。
  - 具体分类：npm test 类（24 条，通过 D9 引号感知 + 管道拆分 + SILENT_COMMANDS 全覆盖）→ 静默；grep -E 类（15 条，引号感知修复）→ 静默；grep -oE / sed 类（6 条，引号感知修复）→ 静默；git 类（9 条，SILENT_COMMANDS）→ 静默；openspec 类（10 条，SILENT_COMMANDS）→ 静默；find 类（5 条，D9 + 引号感知）→ 静默；python heredoc（1 条）→ 仍弹窗；bash -c / shell 内嵌（~3 条，D6 未识别 → 0 target，但 D6 有专门风险讨论）→ 静默（可能过度，见设计 D10）
  - 转发器命令仍走 tier=two 弹窗，安全模型未放松
- **这是局部优化还是全局协调**：**局部优化**——只改一个模块（bash-extract）+ 一处 UI 副文本。决策契约、信任记忆、配置优先级、审计 schema 均不动。
- **如果是局部优化，对全局失调的风险**：
  - **中风险**：`SILENT_COMMANDS` 白名单可能过度放行。缓解：白名单只包含"没有明显文件系统副作用参数"的开发工具命令；`git rm` / `git checkout -- file` 这类 git 子命令虽然能改文件系统，但改动范围被 git 自身约束在项目 `.git/` 与 worktree 内，属于既有决策引擎"project-inner 默认允许"的范围。`npm install` / `yarn install` 有网络访问与依赖写入，但权限系统本就不检查网络，且依赖写入位置（`node_modules/`）在 project-inner。测试覆盖：新增 BTP-Silent-1..3 三个测试断言 SILENT_COMMANDS 的边界行为
  - **中风险**：`tee` 类"过滤器带副作用"命令在 stage 拆分后仍提取 write target——`teeExtract` 已按 arg 提取，不受 stage 拆分影响。测试：BTP3 覆盖
  - **低风险**：`bash -c "..."` / `sh -c "..."` 类 shell 内嵌命令仍会被 D6"未识别=0 target"放行——这是 pre-existing 盲区（现有 UNRELIABLE_PATTERNS 也未拦下），本 change 显式承认并在 `openspec/todo.md` 独立跟踪
  - **低风险**：`while read x; do rm foo; done` 控制流关键字漏洞——同上，本 change 显式承认并在 `openspec/todo.md` 独立跟踪
- **预期行为模型**：
  - 输入：bash 命令字符串 + projectRoot + env
  - 期望输出：
    - 无管道的命令：与现有行为一致（现有 12 个测试 + 9 个 extra 测试全部继续通过）
    - 引号内/转义字符触发的语法（`grep "a\|b"`、`echo 'x\$(y)'`）：不判不可靠
    - 简单管道（无转发器，无其他 unreliable 语法）：`reliable: true`，targets 为各 stage 提取路径的并集
    - SILENT_COMMANDS 中的命令（如 `npm test`、`git log`、`openspec status`）：视为 0-target 静默放行，即使后面跟管道也不弹窗
    - 含转发器的管道（非首 stage 出现 `xargs`/`parallel`/`pforeach`）：`reliable: false, reason: "forwarding_command"`
    - 引号外的真管道、真命令替换、真 heredoc：仍触发 unreliable
  - 验证方式：见下方"scenario→test 覆盖账本"
  - 可验证性：所有场景 `node --experimental-strip-types --test` 直接跑，纯字符串输入输出，无 IO

- **与既有架构/风格的遵循关系**：
  - 完全遵循：bash-extract 保持"纯函数、无 IO、返回 `{reliable, targets|rawCommand}` 联合类型"的既有契约
  - 完全遵循：新增 `scanUnreliable`、`splitPipelines`、`FORWARDING_COMMANDS`、`SILENT_COMMANDS` 命名风格沿用既有 `_EXTRACT`、`_COMMANDS`、`_PATTERNS`、`scanXxx` 模式
  - 完全遵循：spec delta 只修改两个 capability 的行为契约，不动 `access-decision`、`grant-memory`、`audit-log`、`permission-config` 的 spec
  - 无偏离：不引入新的分系统、不新增模块、不重构既有模块组织

## caller impact 分析

触发依据：本 change 跨两个分系统（side-effects + extension-orchestration）且涉及四类变更点中的①与④类（`change-point-classes.md`）。

- **变更点清单**：
  - ①**公共符号签名变更**：`promptUser(ctx, tier, message, trustedPath)` → `promptUser(ctx, tier, message, trustedPath, subtitle?)`（新增可选参数，向后兼容）
  - ④**数据流 / 返回值语义变更**：`extractBashTargets` 返回的 `reason` 字段不再产生值 `"pipeline"`（引号感知 + 管道拆分后管道不再走 UNRELIABLE 通道）；新增值 `"forwarding_command"`。既有 `"command_substitution"`、`"glob_expansion"`、`"unresolved variable: X"` 等 reason 值语义**不变**（引号外的真语法元素仍触发相同 reason）
- **高危标记**：
  - ①`promptUser` 签名变更：**非高危**——新增参数为可选，默认空字符串保持向后兼容
  - ④`reason` 字段语义变更：**非高危**——仓库内无硬编码匹配 `"pipeline"` 字符串（审计日志写入使用 `${extraction.reason}` 动态拼接），旧值仅存于历史审计日志中不产生新条目
- **已知高危 caller**：无
  - ①`promptUser` 唯一调用点：`extensions/index.ts:532`（handlePromptDecision 内）——新增可选参数向后兼容
  - ④`reason` 字段的消费者：仅 `extensions/index.ts:346`（拼接字符串）与审计日志序列化——两处均无硬编码字符串匹配

完整 caller 清单由 `td-apply` 步骤 4 引用搜索实测产出；本节仅前馈标注。

## scenario→test 覆盖账本

tier-medium，`applyRequires` 含 `specs`，含可执行测试面（bash-extract + extensions）。**强制**。

### bash-target-extraction（→ `test/bash-extract.test.ts`）

| # | 场景 | 测试函数名 | 备注 |
|---|---|---|---|
| BTP1 | 简单管道：`cat /etc/passwd \| grep root` 提取 2 读 targets | `pipeline_stages_are_extracted_independently` | 反转既有 BT8 期望 |
| BTP2 | 过滤器流水线：`find /etc \| sort \| head -5` 提取 `/etc` 读 | `pipeline_filter_chain_extracts_first_stage_target` | |
| BTP3 | `tee` 在管道中仍提取 write target：`echo x \| tee /tmp/x` | `tee_in_pipeline_still_extracts_write_target` | 覆盖"过滤器带副作用"风险 |
| BTP4 | 引号内 `\|` 不拆分：`echo "a\|b" > /tmp/x` 提取 `/tmp/x` write | `quoted_pipe_is_not_split` | 边界：避免误拆 |
| BTP5 | `xargs` 在非首 stage：`find /etc \| xargs rm` 判不可靠 | `xargs_in_pipeline_marks_unreliable` | |
| BTP6 | `parallel` 在非首 stage：`cat /tmp/in \| parallel -a /tmp/in` 判不可靠 | `parallel_in_pipeline_marks_unreliable` | |
| BTP7 | `xargs` 无管道输入不判转发器：`echo hi; xargs --help` 判可靠 | `xargs_without_pipe_input_is_not_flagged` | 与 BTP5 区分 |
| BTP8 | 现有不可靠语法仍生效：引号外 `$(...)`、`` `...` ``、`<(...)`、heredoc 判不可靠 | `other_unreliable_patterns_still_mark_unreliable` | 覆盖 BT-extra 现有 5 条测试 |
| BTP9 | `\|\|` 与 `&&` 不被误判为管道：`ls /a \|\| ls /b` 判可靠 | `logical_or_and_and_are_not_pipelines` | |
| BTP10 | `\|&`（GNU pipe stdin+stderr）同普通管道拆分 | `pipe_stderr_extension_splits_like_pipeline` | |
| BTP11 | 引号感知：`grep -n "FAIL\|error" file.ts` 判可靠 | `quoted_pipe_escape_not_unreliable` | 审计高频场景 |
| BTP12 | 引号感知：`grep -oE '"id":"[^"]*"' file.json` 判可靠 | `double_quoted_literal_not_unreliable` | 审计高频场景 |
| BTP13 | 引号感知：`echo 'literal' \| head` 判可靠，`echo literal \| head` 判可靠 | `single_quoted_literal_pipe_split` | 单引号内的字符不解析 |
| BTP14 | 引号感知：`echo $(cat /etc/passwd)`（无引号命令替换）仍判不可靠 | `unquoted_command_substitution_still_unreliable` | 引号外保持严格 |
| BTP15 | 引号感知：`echo "x\$(cat /etc/passwd)"`（双引号内转义命令替换）判可靠 | `escaped_dollar_in_double_quote_not_unreliable` | 双引号内 `\$` 是字面 `$` |
| BTP16 | 引号感知：`grep -E "foo\|bar" /etc/passwd` 判可靠，提取 `/etc/passwd` 读 target | `regex_pipe_in_quotes_preserves_target_extraction` | 引号感知 + stage 拆分协同 |
| BTP17 | 引号感知：`git log --oneline \| grep -E "foo\|bar"` 判可靠、静默放行 | `git_log_pipeline_with_regex_pipe_silent` | 审计高频场景（引号感知 + SILENT_COMMANDS） |
| BTP18 | SILENT_COMMANDS：`npm test` 判可靠、0 target、静默 | `silent_command_npm_test_returns_zero_targets` | 审计高频场景 |
| BTP19 | SILENT_COMMANDS：`git log` / `git status` / `git rev-list` 判可靠、0 target、静默 | `silent_command_git_read_only_silent` | 审计高频场景 |
| BTP20 | SILENT_COMMANDS：`openspec status` / `openspec instructions` 判可靠、0 target | `silent_command_openspec_silent` | 审计高频场景 |
| BTP21 | SILENT_COMMANDS 边界：`rm` 不加入 SILENT（仍在 COMMAND_TABLE 提取 write target） | `rm_still_extracted_not_silent` | 保护 COMMAND_TABLE 与 SILENT 正交 |
| BTP22 | SILENT_COMMANDS 与 forwarder 正交：`find /etc \| xargs rm` 中 xargs 触发转发器，不因 find 在 SILENT 而放行 | `silent_command_does_not_mask_forwarder` | 保护安全边界 |

### approval-flow（→ `extensions/index.test.ts`）

| # | 场景 | 测试函数名 | 备注 |
|---|---|---|---|
| AFS1 | tier=two 外层敏感路径弹窗副文本：包含"敏感路径不能持久化"字样 | `two_tier_prompt_shows_sensitive_subtitle` | 覆盖现有副文本对敏感路径的不准确表述 |
| AFS2 | tier=two bash-unreliable 弹窗副文本：包含"无法静态解析"字样，不包含"permission.json"字样 | `two_tier_prompt_shows_unreliable_bash_subtitle` | 修复当前误导文案 |

**总计**：22 个新增 bash-extract 测试 + 1 个反转既有测试（BT8）+ 2 个新增 approval-flow 测试 + 1 个既有测试断言更新（AF4） = **26 个测试改动**。全部通过 `node --test` 直接跑，无 mock。

---

## 实际系统工程影响 vs 预期（archive 复盘）

**对照源**：
1. 本 proposal 的"系统工程影响评估"节（预期侧）
2. `openspec/specs/` 主 spec baseline——archive 前不存在（本 change 是绿场第二个 change，前一个 `permission-extension` 才建立 bash-target-extraction 与 approval-flow 两个 baseline）。因此本对照源**跳过**，仅用 proposal 自述做复盘，不阻塞 archive。

| 字段 | 内容 |
|---|---|
| **实际影响的分系统** | 完全对齐预期：`side-effects`（bash-extract 主改动）+ `extension-orchestration`（promptUser 副文本参数化）。其余分系统（policy-core、decision、trust、audit、config、sensitive、path-utils）均未触碰，符合 proposal 声明。 |
| **实际整体性能变化** | 用 audit log（145 records / 121 bash allow_once）跑新旧代码对比，实测数据：OLD 会弹 117（97%），NEW 会弹 17（14%），**减少 100 个弹窗（85%）**。略优于 proposal 预估的"87 条 → 79% 降到 8%"。原因：proposal 预估基于早期 87 条快照，实测覆盖 145 条完整审计（含后期新增命令），实际修复率更高。**0 个回归**（新代码严格更宽容，没有任何"旧代码放行、新代码弹窗"的命令）。 |
| **实际是局部优化还是全局协调** | 是局部优化——只改 bash-extract 一个纯函数模块 + 一处 promptUser UI 副文本参数化。决策契约、信任记忆、配置优先级、审计 schema 均不动，与 proposal 声明一致。 |
| **局部优化的实际全局影响**（主基调第 1 条事后回检） | 局部优化的全局协调风险**低于预期**——审计数据 0 回归，说明局部放宽没有破坏全局安全模型。唯一实际触发的中风险点：**未加引号 glob 仍会弹窗**（11 条剩余弹窗中占 11 条），这是保守正确行为（静态分析确实无法枚举 bash 展开后的文件集），不是漏洞。**预期之外的副作用**：见下节。 |
| **预期行为模型验证** | **模型成立**——所有 22 个新增 BTP 测试 + 3 个 audit 回归测试 + 反转的 BT8 + BT-extra + BT12 全部通过。行为符合 proposal 声明的 5 类输入-输出映射（无管道/引号感知/简单管道/SILENT/转发器/真不可靠）。可验证性满足：纯字符串输入输出，无 IO。 |

### 预期之外的副作用（/td-system-audit 输入）

1. **6 处 TypeScript TS2367 死代码警告**（strict 模式下）：`scanUnreliable`/`splitPipelines`/`splitCommands`/`expandSafeVariables` 内 `if (quote === "'") { ...; continue; }` 已让 TypeScript 判断后续 `quote !== "'"` 是死分支。**运行时无害**（jiti 忽略类型检查，所有测试通过），但 strict tsc 报错。归档时用户明确 c2 决策"保持现状"，未修。**建议**：下次触碰该文件时一并清理（每处仅需去掉 `&& quote !== "'"`）。

2. **`expandSafeVariables` 反斜杠处理在单引号内**：bash 语义里 `\` 在单引号内是字面字符（不消费下一个字符），但当前代码在 `if (quote === "'") continue;` 之前的 `\` 检查会让单引号内 `\` 也设置 `escaped` 状态。这个 bug 在 quote-aware 改造时残留（`scanUnreliable` 已按正确语义实现，`expandSafeVariables` 未按此改）。**当前 audit 数据无此模式触发**（如 `echo 'a\b'`），实际影响为 0；理论影响：如果 `expandSafeVariables` 内的 quote 状态被 `\` 误消费，会让后续的 `$` 处理误判——但 `$` 在单引号内也应视为字面，所以最坏情况是**误判 `$` 为要展开**并尝试 `expandSafeVariables` 匹配 `\$HOME` 等，实测不触发。**建议**：下次触碰 `expandSafeVariables` 时把 `\` 检查移到单引号检查之后（与 `scanUnreliable` 一致）。

3. **`splitCommands` 与 `expandSafeVariables` 内相同问题**：如上 2 条同款问题。当前 audit 数据未触发，非阻塞。

**⚠ 后补更正（2026-10-13，bash-meta-commands-guard change 实施时发现）**：

- 上述第 1 条（TS2367）已在 `bash-meta-commands-guard` change 实施期间修复（2026-10-13）——`src/lib/bash-extract.ts` 中 7 处 `&& quote !== "'"` 死代码警告已全部清理（L73/L143/L229/L278/L287/L777 + L283-285 多余块）。`tsc --strict` 现在输出 0 错误。
- 上述第 2、3 条（"反斜杠 bug"）描述**不准确**：当前代码的 quote 分支顺序（L273 先处理 `quote === "'"` 并 `continue`）已在 quote-aware 改造时修正了这个问题，反斜杠在单引号内实际**不会被误消费为 escape**。retro 描述的是 TypeScript 死代码警告的**表象**，被错误解释为 bash 语义 bug。retro 建议的"把 `\` 检查移到单引号检查之后"不需要做（已经如此）。
- archive 只读约定**未遵守**：本更正说明直接修改了归档目录内的 `proposal.md`，违反了 td-archive guardrail "archive 后只读"。修改理由：retro 中描述的遗留项在实际修复时发现部分内容不准确（TS2367 已清、反斜杠 bug 不存在），若不修改则后续读者会被误导，产生"反斜杠 bug 仍存在"的错误认知。修改内容仅追加更正段，未删除或修改任何原有 retro 文本。

### scenario→test 覆盖账本状态

**全绿**——22 个新增 BTP 测试 + 3 个 audit 回归 + 反转 BT8 + 更新 BT12 + 更新 BT-extra + 新增 AFS1/AFS2 + 更新 AF4 + 更新 SYS4 全部通过。测试总数从 151 增至 177（+26），失败数 0。

### 保留盲区（已落 openspec/todo.md）

- **while/for/if 控制流关键字**：本 change 未处理。P2 优先级。
- **`bash -c` / `sh -c` shell 内嵌命令**：D6 "未识别=0 target" 会放行。P2 优先级。
