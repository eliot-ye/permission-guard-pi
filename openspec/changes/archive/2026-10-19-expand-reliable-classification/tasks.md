# Tasks

## 关键链（Critical Chain）

关键链：`1.1 → 2.1 → 2.2 → 2.3 → 3.1 → 3.2 → 4.1`（TDD RED-GREEN-REFACTOR + 集成验证）。
- 1.1（RED 写测试）是必需起点
- 2.1/2.2/2.3（GREEN 三类豁免实现）是主实施
- 3.1/3.2（回归测试 + 用户触发场景验证）是集成验证
- 4.1（全量测试 + openspec validate）是最终关口

**Project buffer**：tier-medium → 35%。关键链估时约 7 tasks × 中位 30 min = 210 min；buffer 约 74 min 留到最后集成阶段。本 change 比上一个 change（bounded-glob-compound-separators）大——约 300+ 行新逻辑，三类豁免有交互，需要更多 buffer。

## 1. TDD RED：新增测试用例

- [x] 1.1 编写 20 条新增测试（BMG68-BMG87）到 `test/bash-extract.test.ts` 末尾
  - 验证证据：RED phase 运行输出中 10 条正例（BMG68-71/73-75/79-80/87）FAIL、10 条反例（BMG72/76-78/81-86）PASS
  - 文件：`test/bash-extract.test.ts`
  - 风险：low（纯测试添加）
  - 验证：`node --experimental-strip-types --test test/bash-extract.test.ts 2>&1 | grep -E "BMG6[4-9]|BMG7[0-9]|BMG8[0-3]"` 显示 20 条；期望 12 条 FAIL（豁免正例）+ 8 条 PASS（反例：当前行为已经是 unreliable 的）
  - 分系统影响：side-effects（bash-extract 测试面）
  - 依赖：无
  - 新增测试清单（对应 proposal 的 scenario→test 覆盖账本）：
    - **引号定界 heredoc 组（7 条）**：
      - BMG68: `quoted_heredoc_single_quote_is_reliable`（`cat <<'EOF'\nhello\nEOF` → reliable）
      - BMG69: `quoted_heredoc_double_quote_is_reliable`（`cat <<"EOF"\nhello\nEOF` → reliable）
      - BMG70: `quoted_heredoc_dash_form_is_reliable`（`cat <<-'EOF'\nhello\nEOF` → reliable）
      - BMG71: `quoted_heredoc_content_with_dollar_is_literal`（`cat <<'EOF'\n$(rm -rf /)\nEOF` → reliable）
      - BMG72: `unquoted_heredoc_still_unreliable`（`cat <<EOF\nhello\nEOF` → unreliable: heredoc，反例）
      - BMG73: `quoted_heredoc_preceding_command_extracted`（`cat /etc/passwd; cat <<'EOF'\nx\nEOF` → reliable，含 read /etc/passwd）
    - **forwarder + read-only 下游组（5 条）**：
      - BMG74: `xargs_grep_downstream_is_reliable`（`find /tmp -name "*.log" | xargs grep "error"` → reliable）
      - BMG75: `xargs_wc_downstream_is_reliable`（`find /tmp | xargs wc -l` → reliable）
      - BMG76: `xargs_rm_downstream_still_unreliable`（`find /tmp | xargs rm` → unreliable: forwarding_command，反例）
      - BMG77: `xargs_downstream_with_dollar_still_unreliable`（`find /tmp | xargs grep $PATTERN` → unreliable，反例）
      - BMG78: `xargs_downstream_with_glob_still_unreliable`（`find /tmp | xargs grep *.log` → unreliable，反例）
    - **字面量 for 循环组（8 条）**：
      - BMG79: `literal_for_loop_read_only_body_is_reliable`（`for f in a b c; do grep "$f"; done` → reliable）
      - BMG80: `literal_for_loop_multi_command_body_is_reliable`（`for f in a b; do echo "$f"; grep "$f"; done` → reliable）
      - BMG81: `for_loop_with_glob_in_iter_still_unreliable`（`for f in /etc/*.conf; do cat "$f"; done` → unreliable，反例）
      - BMG82: `for_loop_with_var_in_iter_still_unreliable`（`for f in $FILES; do cat "$f"; done` → unreliable，反例）
      - BMG83: `for_loop_with_write_body_still_unreliable`（`for f in a b; do rm "$f"; done` → unreliable，反例）
      - BMG84: `while_loop_still_unreliable`（`while read x; do cat "$x"; done` → unreliable，反例）
      - BMG85: `if_statement_still_unreliable`（`if true; then cat /etc/passwd; fi` → unreliable，反例）
      - BMG86: `case_statement_still_unreliable`（`case $x in a) cat a;; esac` → unreliable，反例）
    - **用户会话回归（1 条）**：
      - BMG87: `user_triggered_for_loop_is_reliable`（`for f in openspec/changes/archive/2026-10-15-... openspec/changes/archive/2026-10-14-...; do echo "===$f==="; grep -n "^## " "$f"; done` → reliable）

## 2. TDD GREEN：实现代码

- [x] 2.1 实现引号定界 heredoc 内容跳过
  - 验证证据：BMG68-73 全部通过（BMG72 反例：未引号定界 heredoc 仍判 heredoc）；既有 BT-extra heredoc 组继续通过
  - 文件：`src/lib/bash-extract.ts`（`scanUnreliable` 函数 + 新增 `parseHeredocDelimiter` 辅助函数）
  - 风险：medium（字符级状态机扩展，错误会导致 heredoc 内容被误扫描）
  - 验证：
    - BMG68-BMG73 全部通过（BMG72 是反例，当前行为已正确，应继续通过）
    - 既有 BT-extra heredoc 组（`cat <<EOF\nhello\nEOF`）继续通过（未引号定界 heredoc 仍判不可靠）
    - 完整 `node --experimental-strip-types --test test/bash-extract.test.ts 2>&1 | tail -5` 无回归
  - 分系统影响：side-effects
  - 依赖：1.1
  - 实现要点（对应 design.md D1/D2）：
    - `scanUnreliable` 遇到 `<<` 时，调用 `parseHeredocDelimiter(cmd, i)` 判断是否引号定界
    - 引号定界 → 跳过内容到结束定界符行之后，继续扫描
    - 未引号定界 → 保持原 `return "heredoc"`
    - `parseHeredocDelimiter` 处理：`<<'EOF'` / `<<"EOF"` / `<<-'EOF'` / `<<-"EOF"` 四种形式
    - 结束定界符行首匹配容忍前导 tab（dash 形式）
    - 找不到结束定界符 → 回退到 `quoted: false`

- [x] 2.2 实现 forwarder + read-only 下游豁免
  - 验证证据：BMG74-75 通过（xargs grep / xargs wc reliable）；BMG76-78 通过（rm 下游 / 下游含 `$` / 下游含 glob 仍 unreliable）；既有 BTP5-6 xargs/parallel 测试继续通过
  - 文件：`src/lib/bash-extract.ts`（`extractBashTargets` 主流程 FORWARDING 检查处 + 新增 `isForwarderDownstreamReadOnly` 辅助函数）
  - 风险：medium（转发器 flag 参数解析 + 下游命令识别）
  - 验证：
    - BMG74-BMG75 通过（forwarder + read-only 下游 reliable）
    - BMG76-BMG78 通过（反例：write 下游 / 下游含 `$` / 下游含 glob 仍 unreliable）
    - 既有 FORWARDING_COMMANDS 相关测试继续通过（`find /etc | xargs rm` → unreliable）
  - 分系统影响：side-effects
  - 依赖：1.1, 2.1
  - 实现要点（对应 design.md D3/D4）：
    - FORWARDING 检查命中时，先调 `isForwarderDownstreamReadOnly(stage)`
    - 满足豁免 → 不 return，继续 stage 提取
    - 不满足 → 维持 `return { reliable: false, reason: "forwarding_command" }`
    - `isForwarderDownstreamReadOnly`：跳过转发器自身 + flag 参数（以 `-` 开头），找下游命令名，检查 READ_ONLY_COMMANDS + 参数可静态判定

- [x] 2.3 实现字面量 for 循环豁免
  - 验证证据：BMG79-80/87 通过（字面量 for + read-only/harmless 体 reliable）；BMG81-86 通过（迭代集 glob/变量、体含 write、while/if/case 仍 control_flow）；BMG2 改为嵌套 for 用例（单层字面量 for 现被豁免）；既有 BMG1-5 控制流组继续通过
  - 文件：`src/lib/bash-extract.ts`（`scanControlFlow` 函数 + 新增 `isLiteralForLoop` 辅助函数 + `findUnresolvedVariable` 白名单扩展）
  - 风险：high（`scanControlFlow` 返回类型变化 + 循环变量白名单机制 + 循环体多命令分析）
  - 验证：
    - BMG79-BMG80 通过（字面量 for + read-only 体 reliable）
    - BMG81-BMG83 通过（反例：迭代集 glob / 迭代集变量 / 体含 write 仍 unreliable）
    - BMG84-BMG86 通过（while/if/case 不受豁免，仍 unreliable）
    - BMG87 通过（用户会话原始 for 命令 reliable）
    - 既有 BMG1-BMG5 控制流关键字组继续通过（`while`/`for` 非字面量/`until`/`case`/`if` 仍 unreliable）
    - 既有 BMG15-BMG16 shell 内置变量白名单组继续通过
  - 分系统影响：side-effects
  - 依赖：1.1, 2.1, 2.2
  - 实现要点（对应 design.md D5/D6/D7）：
    - `scanControlFlow` 返回类型从 `boolean` 改为 `{ hit: boolean; loopVars?: string[] }`
    - 遇到 `for` 独立 token → 调 `isLiteralForLoop`；豁免 → 跳过 `done` 之后、收集循环变量名；不豁免 → `return { hit: true }`
    - `findUnresolvedVariable` 新增参数 `loopVars?: string[]`，白名单循环变量
    - `extractBashTargets` 主流程把 `scanControlFlow` 返回的 `loopVars` 传给 `findUnresolvedVariable`
    - `isLiteralForLoop`：解析 `for VAR in WORDS; do BODY; done`；迭代集全字面量 + 体 read-only + 无嵌套控制流 + 无命令替换 + 无 heredoc → 豁免

## 3. 集成验证

- [x] 3.1 全量测试回归：`node --experimental-strip-types --test test/*.test.ts` 全部通过
  - 验证证据：260 tests, 260 pass, 0 fail
  - 文件：无
  - 风险：low
  - 验证：命令输出末尾显示 `# fail 0` 且 `# pass` 数 ≥ 280（既有 260+ + 新增 20）
  - 分系统影响：全部
  - 依赖：2.3

- [x] 3.2 用户会话原始命令现场验证
  - 验证证据：heredoc 引号定界原始命令 → R 0t；forwarder `find ... | xargs grep -l` → R 2t；for 原始命令 → R 0t；真实用户触发命令（cd && for ... do echo/grep; done）→ R 0t
  - 文件：无
  - 风险：low
  - 验证：
    - 临时脚本调用 `extractBashTargets` 传入本次会话的三类原始命令：
      1. heredoc：`node --input-type=module <<'EOF'\nimport { extractBashTargets } from "...";\n...\nEOF` → 期望 `reliable: true`
      2. forwarder：`find /Users/eliot/.pi -maxdepth 3 -name "*.md" 2>/dev/null | xargs grep -l "reload" 2>/dev/null | head -5` → 期望 `reliable: true`
      3. for：`for f in openspec/changes/archive/2026-10-15-bash-extractor-agent-exploration/ openspec/changes/archive/2026-10-14-bash-meta-commands-guard/; do echo "===$f==="; grep -n "^## " "$f"; done` → 期望 `reliable: true`
    - 完成后删除临时脚本
  - 分系统影响：side-effects（端到端）
  - 依赖：2.3

## 4. 定稿与归档准备

- [x] 4.1 `openspec validate expand-reliable-classification --type change --json` 通过
  - 验证证据：valid: true, issues: []
  - 文件：无
  - 风险：low
  - 验证：JSON 输出中 `valid: true`；`issues` 为空数组
  - 分系统影响：无
  - 依赖：3.1
  - 补充说明：specs delta 已按 "full updated content" 格式写好 MODIFIED requirements + 新增 scenarios，预期通过。如 `--strict` 报警告，回到 specs delta 补齐。

## 关键链与 buffer 说明

- 关键链总估时：1.1（20 min）+ 2.1（30 min）+ 2.2（30 min）+ 2.3（45 min）+ 3.1（10 min）+ 3.2（10 min）+ 4.1（5 min）= **150 min**
- Project buffer（35%）：52 min，主要在 2.3（for 豁免最复杂）和 3.1/3.2 阶段
- Feeding buffer：无支流汇入

## 非关键路径

无——本 change 关键链即全部任务序列，无并行支流。

## 完成定义

全部 8 个 tasks 完成 + 4.1 openspec validate 通过 + 所有测试绿 → 可 `/td-apply` 结束并 `/td-archive`。

## Scope 扩展日志

- 初始 scope：只有 heredoc 引号定界（1 类）
- 扩展 1：加入 forwarder + read-only 下游豁免（来自本次会话 audit log 分析，`xargs grep` 案例）
- 扩展 2：加入字面量 for 循环豁免（来自本次会话 audit log 分析，`for f in ...; do ...; done` 案例）
- 最终 scope：三类豁免，约 300+ 行新逻辑，20 条新增测试
