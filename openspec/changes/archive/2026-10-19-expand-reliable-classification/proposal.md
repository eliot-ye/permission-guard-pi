## Why

当前 bash 命令提取器对三类**实际安全**的命令形态误判为"不可靠"，触发不必要的 tier=two 弹窗。这三类形态在 AI 辅助开发会话中高频出现：

1. **引号定界 heredoc**（`<<'EOF' ... EOF`）：bash 语义下引号定界的 heredoc 内容**不做任何展开**（`$`、反引号、`$(...)` 全是字面量），等价于单引号字符串。当前 `scanUnreliable` 看到 `<<` 就判 `heredoc` 不可靠，导致 `node --input-type=module <<'EOF' ... EOF`（内联测试脚本）、`cat > /tmp/x.ts <<'EOF' ... EOF`（写 scratch 文件）等场景全部弹窗。
2. **转发器 + read-only 下游**（`find ... | xargs grep ...`）：`xargs` 是 FORWARDING_COMMANDS，当前不管下游是什么命令都判不可靠。但 `xargs grep`/`xargs wc`/`xargs ls` 等下游是 read-only 命令时，实际行为是"对上游输出的文件列表做只读操作"——安全包络等价于直接枚举文件后跑 read-only 命令。
3. **字面量 `for` 循环**（`for f in a b c; do grep "$f"; done`）：当前 `scanControlFlow` 看到 `for` 关键字就判 `control_flow` 不可靠。但当迭代集是**全字面量词**（不含 `$`/反引号/未引号 glob）且循环体只含 read-only 命令、循环变量在体内作为路径参数使用时，实际访问的文件集是静态可确定的。

本 change 把这三类从"不可靠"放宽为"可靠"，目标：减少 AI 探索场景的假阳性弹窗，**不降低安全水位**（每类豁免都有明确的静态可判定条件，不满足条件时维持原"不可靠"判定）。

## What Changes

- **`bash-target-extraction`**：MODIFIED "复杂语法导致不可靠" requirement——引号定界 heredoc（`<<'DELIM'`/`<<"DELIM"`/`<<-DELIM`）的内容 MUST 视为字面数据，不触发 `heredoc` 不可靠标记；未引号定界 heredoc（`<<DELIM`）保持原行为（内容会展开 `$`/反引号，仍判不可靠）。
- **`bash-target-extraction`**：MODIFIED "转发器命令守卫" requirement——当转发器（`xargs`/`parallel`/`pforeach`）出现在非首 stage，且其**下游命令**（转发器后的第一个 token）属于 READ_ONLY_COMMANDS 且下游参数可静态判定（无 `$`/反引号/未引号 glob/未引号 heredoc）时，MUST NOT 判 `forwarding_command`；改为按下游命令的 read target 提取规则处理上游输出的文件列表。
- **`bash-target-extraction`**：MODIFIED "控制流关键字守卫" requirement——`for` 关键字作为独立 token 出现时，若满足"字面量迭代豁免"条件（迭代集全字面量 + 循环体可静态判定），MUST NOT 判 `control_flow`；`while`/`until`/`if`/`case` 等其他控制流关键字不受豁免影响，维持原行为。
- **`bash-target-extraction`**：ADDED "字面量 for 循环豁免" requirement——定义字面量迭代集的静态判定条件与豁免边界。
- **`bash-target-extraction`**：ADDED "引号定界 heredoc 内容处理" requirement——定义引号定界 heredoc 的识别规则与内容跳过语义。
- **不动**：`approval-flow`（tier=two 副文本已支持泛化文案）、`grant-memory`、`audit`（`reason` 字段值域不变，本 change 只减少 `heredoc`/`forwarding_command`/`control_flow` 的触发，不新增 reason 值）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bash-target-extraction`：
  - MODIFIED "复杂语法导致不可靠"——引号定界 heredoc 不再触发不可靠
  - MODIFIED "转发器命令守卫"——forwarder + read-only 下游豁免
  - MODIFIED "控制流关键字守卫"——`for` 字面量迭代豁免
  - ADDED "引号定界 heredoc 内容处理"
  - ADDED "字面量 for 循环豁免"

## Impact

**Modified code**

- `src/lib/bash-extract.ts`：
  - `scanUnreliable`：新增引号定界 heredoc 识别（`<<'`/`<<"`/`<<-` 后跟引号），命中时跳过 heredoc 内容直到结束定界符，不返回 `"heredoc"`；未引号定界 heredoc 保持原 `return "heredoc"` 行为
  - 新增 `isQuotedHeredoc(cmd, startPos)` 辅助函数：判断 `<<` 后是否紧跟引号定界符，返回 `{ quoted: boolean, delimiter: string, contentEnd: number }`
  - `extractBashTargets` 主流程：转发器守卫命中时，新增下游命令分析——若下游命令属于 READ_ONLY_COMMANDS 且参数可静态判定，放行并按下游命令提取 read targets；否则维持 `forwarding_command`
  - 新增 `isForwarderDownstreamReadOnly(stage)` 辅助函数：分析转发器 stage 的下游命令
  - `scanControlFlow`：`for` 关键字命中时，新增字面量迭代豁免检查——若满足豁免条件，不返回 `true`；其他控制流关键字维持原行为
  - 新增 `isLiteralForLoop(cmd, forKeywordPos)` 辅助函数：分析 `for` 循环的迭代集与循环体是否满足字面量豁免条件
  - 预计净增 ~200 行

**Added tests**

- bash-extract 测试（新增 ~20 条，编号 BMG64-BMG83）：
  - 引号定界 heredoc（单引号/双引号/dash 形式）→ reliable
  - 未引号定界 heredoc → 仍 unreliable
  - 引号定界 heredoc 内含 `$`/反引号 → reliable（字面量）
  - `xargs grep`/`xargs wc`/`xargs ls` → reliable（read-only 下游）
  - `xargs rm`/`xargs cp` → 仍 unreliable（write 下游）
  - `xargs` 下游含 `$` → 仍 unreliable
  - 字面量 `for f in a b c; do grep "$f"; done` → reliable
  - `for f in /etc/*.conf; do cat "$f"; done` → 仍 unreliable（迭代集含 glob）
  - `for f in $FILES; do cat "$f"; done` → 仍 unreliable（迭代集含变量）
  - `while`/`until`/`if`/`case` → 仍 unreliable（不受豁免影响）

**User-facing changes**

- AI 探索场景的三类高频命令不再误触 tier=two 弹窗：
  - `node --input-type=module <<'EOF' ... EOF`（内联测试脚本）
  - `find ... | xargs grep ...`（只读管道链）
  - `for f in a b c; do grep "$f"; done`（字面量迭代）

**Audit & Docs**

- `reason` 字段值域不变（本 change 只减少 `heredoc`/`forwarding_command`/`control_flow` 的触发频率，不新增 reason 值）
- 已归档 audit log 保持原样（历史记录不回填）

## 系统工程影响评估

- **影响哪些分系统**：仅 `side-effects`（`bash-extract.ts` 一个纯函数模块）。`policy-core`（config / decision / trust / path-utils）、`extension-orchestration`、`audit`、`approval-flow` 均不变。
- **整体性能预期变化**：安全水位**定向放宽**——只对三类有明确静态判定条件的命令形态放宽，不满足条件的命令维持原"不可靠"判定。基于本次会话 audit log（10 条弹窗）实测：5 条 heredoc 中 4 条是引号定界（`<<'EOF'`）→ 放宽；1 条 `xargs grep` → 放宽；1 条字面量 `for` → 放宽；**净减少 6/10 条弹窗**。不构成安全降级——每类豁免都有反例保护（未引号 heredoc 仍判不可靠、write 下游仍判不可靠、非字面量迭代仍判不可靠）。
- **这是局部优化还是全局协调**：**局部优化**——只改 bash-extract 一个纯函数模块。决策引擎、信任记忆、配置优先级、审计 schema、UI 交互均不动。
- **如果是局部优化，对全局失调的风险**：**中风险**（比 fragment-level 那个 change 高一档）。理由：
  1. 三类豁免各自的判定条件有交互——引号定界 heredoc 的内容跳过必须与 `scanUnreliable`/`scanControlFlow`/`isBoundedGlobSafe` 三个扫描器协同（内容跳过后这些扫描器看不到 heredoc 内的字符）；forwarder 下游分析与既有 FORWARDING_COMMANDS 守卫有优先级关系；`for` 豁免与 `scanControlFlow` 有优先级关系。
  2. 引号定界 heredoc 的内容跳过是**字符级状态机扩展**——需要正确处理 `<<-'EOF'`（dash + 单引号）、`<<"EOF"`（双引号）、`<<EOF`（无引号）三种形式，以及结束定界符的行首匹配（bash 允许行首空白对齐 dash 形式）。状态机错误会导致 heredoc 内容被误解析为命令，产生静默漏洞。
  3. forwarder 下游分析需要**穿透 `xargs` 的参数**——`xargs grep -l "pattern"` 的下游命令是 `grep`，但 `xargs -I {} grep {} /etc` 的下游命令也是 `grep`（`-I {}` 是 xargs 自己的参数）。需要正确区分 xargs 自身参数与下游命令。
  4. `for` 字面量迭代豁免需要**分析循环体**——循环体可能含多个命令（`do cmd1; cmd2; done`），每个命令都要判 read-only + 无 unresolved variable + 无 command substitution。循环变量（如 `$f`）在体内出现时需要视为已解析的"迭代集字面量"之一。
  5. **缓解措施**：~20 条新增测试覆盖每类豁免的正例 + 反例 + 边界 case；既有 250+ 测试零回归（特别是 BMG1-BMG14 控制流组、BMG24-BMG32 fd-redirect 组、BT-extra heredoc 组）。
- **预期行为模型**：
  - 输入：bash 命令字符串 + projectRoot + env
  - 期望输出：
    - 引号定界 heredoc（`<<'EOF'`/`<<"EOF"`/`<<-EOF`）→ heredoc 内容视为字面数据，不触发 `heredoc` 不可靠标记；heredoc 前后的命令正常提取
    - 未引号定界 heredoc（`<<EOF`）→ 仍触发 `heredoc` 不可靠标记（内容会展开 `$`/反引号）
    - `find ... | xargs grep ...`（下游 read-only + 参数可静态判定）→ reliable，按下游命令提取 read targets
    - `find ... | xargs rm ...`（下游 write）→ 仍 `forwarding_command`
    - `for f in a b c; do grep "$f"; done`（字面量迭代 + read-only 体）→ reliable，按循环体命令对每个迭代词提取 read targets
    - `for f in $FILES; do cat "$f"; done`（非字面量迭代）→ 仍 `control_flow`
    - `while`/`until`/`if`/`case` → 仍 `control_flow`（不受豁免影响）
  - 验证方式：~20 条新增测试断言每类输入-输出映射
  - 可验证性：纯字符串输入输出，无 IO

- **与既有架构/风格的遵循关系**：
  - 完全遵循：`scanUnreliable`/`scanControlFlow` 的字符级状态机扩展沿用现有 quote/escaped 模式
  - 完全遵循：新增辅助函数（`isQuotedHeredoc`/`isForwarderDownstreamReadOnly`/`isLiteralForLoop`）命名沿用 `isXxx` 布尔判定风格
  - 完全遵循：`reason` 字段值域不变，无新增值
  - 完全遵循：READ_ONLY_COMMANDS 集合复用（forwarder 下游分析与 bounded-glob 共用同一集合）
  - 无偏离：不新增分系统、不新增模块、不重构既有模块组织、不动主流程调用顺序（`scanUnreliable` → `scanControlFlow` → `isShellForwarder` → `findUnresolvedVariable` → `expandSafeVariables` → `splitCommands` + `splitPipelines` + FORWARDING 检查 → SILENT 分支）

## caller impact 分析

- **变更点清单**：
  - ②`scanUnreliable`（非导出）——新增引号定界 heredoc 内容跳过逻辑
  - ②`scanControlFlow`（非导出）——新增 `for` 字面量迭代豁免
  - ②`extractBashTargets` 主流程——转发器守卫命中处新增下游命令分析分支
  - ②新增辅助函数 `isQuotedHeredoc`/`isForwarderDownstreamReadOnly`/`isLiteralForLoop`（非导出）
  - ①`extractBashTargets`（公共导出，被 `extensions/index.ts:346` 消费）——**返回值形状不变**，但内部对三类命令的 reliable 判定更宽松
- **高危标记**：
  - **②scanUnreliable 扩展**：非导出，仅 `extractBashTargets` 内部消费。heredoc 内容跳过是字符级状态机扩展，错误会导致内容被误解析。**中风险**（非高危）——需要严格的引号定界符识别 + 结束定界符行首匹配。
  - **②scanControlFlow 扩展**：非导出。`for` 豁免需要分析循环体，错误会导致非字面量 `for` 被误放行。**中风险**——需要严格的字面量迭代集判定 + 循环体静态分析。
  - **②extractBashTargets 转发器分支**：返回值形状不变，caller 兼容。**无高危**。
- **已知 caller**：
  - `extensions/index.ts:346`：使用 `extraction.reliable` 与 `extraction.targets`，形状不变，无需适配
  - `test/bash-extract.test.ts`：现有所有测试继续通过（BMG1-BMG14 控制流组、BMG24-BMG32 fd-redirect 组、BT-extra heredoc 组重点回归）

## scenario→test 覆盖账本

tier-medium，`applyRequires` 含 `specs`，含可执行测试面（bash-extract）。**tier-medium 强制**。

### bash-target-extraction（→ `test/bash-extract.test.ts`）

| # | 场景 | 测试函数名 | 备注 |
|---|---|---|---|
| BMG64 | 单引号定界 heredoc reliable | `quoted_heredoc_single_quote_is_reliable` | `cat <<'EOF'\nhello\nEOF` → reliable |
| BMG65 | 双引号定界 heredoc reliable | `quoted_heredoc_double_quote_is_reliable` | `cat <<"EOF"\nhello\nEOF` → reliable |
| BMG66 | dash + 引号定界 heredoc reliable | `quoted_heredoc_dash_form_is_reliable` | `cat <<-'EOF'\nhello\nEOF` → reliable |
| BMG67 | 引号定界 heredoc 内含 `$`/反引号 reliable | `quoted_heredoc_content_with_dollar_is_literal` | `cat <<'EOF'\n$(rm -rf /)\nEOF` → reliable（内容字面） |
| BMG68 | 未引号定界 heredoc 仍 unreliable | `unquoted_heredoc_still_unreliable` | `cat <<EOF\nhello\nEOF` → unreliable: heredoc |
| BMG69 | 引号定界 heredoc 前命令正常提取 | `quoted_heredoc_preceding_command_extracted` | `cat /etc/passwd; cat <<'EOF'\nx\nEOF` → reliable，含 read /etc/passwd |
| BMG70 | `xargs grep` read-only 下游 reliable | `xargs_grep_downstream_is_reliable` | `find /tmp -name "*.log" \| xargs grep "error"` → reliable |
| BMG71 | `xargs wc` read-only 下游 reliable | `xargs_wc_downstream_is_reliable` | `find /tmp \| xargs wc -l` → reliable |
| BMG72 | `xargs rm` write 下游仍 unreliable | `xargs_rm_downstream_still_unreliable` | `find /tmp \| xargs rm` → unreliable: forwarding_command |
| BMG73 | `xargs` 下游含 `$` 仍 unreliable | `xargs_downstream_with_dollar_still_unreliable` | `find /tmp \| xargs grep $PATTERN` → unreliable |
| BMG74 | `xargs` 下游含未引号 glob 仍 unreliable | `xargs_downstream_with_glob_still_unreliable` | `find /tmp \| xargs grep *.log` → unreliable |
| BMG75 | 字面量 `for` + read-only 体 reliable | `literal_for_loop_read_only_body_is_reliable` | `for f in a b c; do grep "$f"; done` → reliable |
| BMG76 | 字面量 `for` + 多命令体 reliable | `literal_for_loop_multi_command_body_is_reliable` | `for f in a b; do echo "$f"; grep "$f"; done` → reliable |
| BMG77 | `for` 迭代集含 glob 仍 unreliable | `for_loop_with_glob_in_iter_still_unreliable` | `for f in /etc/*.conf; do cat "$f"; done` → unreliable: glob_expansion |
| BMG78 | `for` 迭代集含变量仍 unreliable | `for_loop_with_var_in_iter_still_unreliable` | `for f in $FILES; do cat "$f"; done` → unreliable: control_flow |
| BMG79 | `for` 体含 write 命令仍 unreliable | `for_loop_with_write_body_still_unreliable` | `for f in a b; do rm "$f"; done` → unreliable: control_flow |
| BMG80 | `while` 循环仍 unreliable（不受豁免） | `while_loop_still_unreliable` | `while read x; do cat "$x"; done` → unreliable: control_flow |
| BMG81 | `if` 仍 unreliable（不受豁免） | `if_statement_still_unreliable` | `if true; then cat /etc/passwd; fi` → unreliable: control_flow |
| BMG82 | `case` 仍 unreliable（不受豁免） | `case_statement_still_unreliable` | `case $x in a) cat a;; esac` → unreliable: control_flow |
| BMG83 | 用户会话原始 `for` 命令 reliable | `user_triggered_for_loop_is_reliable` | `for f in openspec/changes/archive/2026-10-15-... openspec/changes/archive/2026-10-14-...; do echo "===$f==="; grep -n "^## " "$f"; done` → reliable |

**总计**：20 条新增测试（BMG64-BMG83），覆盖三类豁免的正例（11 条）+ 反例（9 条）。

**已修复的假阳性验证**（本 change 的关键回归）：
- **BMG64-BMG69**：引号定界 heredoc——本 change 之前 `unreliable: heredoc`，本 change 之后 `reliable`
- **BMG70-BMG71**：forwarder + read-only 下游——本 change 之前 `unreliable: forwarding_command`，本 change 之后 `reliable`
- **BMG75-BMG76/BMG83**：字面量 `for`——本 change 之前 `unreliable: control_flow`，本 change 之后 `reliable`

**关键反例保护**：
- **BMG68**：未引号定界 heredoc 仍判不可靠（内容会展开 `$`/反引号）
- **BMG72-BMG74**：forwarder + write 下游 / 下游含 `$` / 下游含 glob 仍判不可靠
- **BMG77-BMG79**：`for` 迭代集含 glob / 变量 / 体含 write 命令仍判不可靠
- **BMG80-BMG82**：`while`/`if`/`case` 不受豁免影响，仍判不可靠
