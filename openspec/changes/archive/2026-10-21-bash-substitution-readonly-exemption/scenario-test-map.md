# Scenario→Test 覆盖账本

**范围**：`openspec/changes/bash-substitution-readonly-exemption/specs/bash-target-extraction/spec.md` 的 11 个 `#### Scenario:`。

**测试文件路径存在性**：`test/bash-extract.test.ts` 已确认存在（2994 → 3234 行，新增 22 个 substitution_ 测试）。所有具名测试已在 task 1.1-1.4 与 review T1-T4 补测阶段创建完毕。

**tier**：`tier-medium`（本 change 属 `bash-target-extraction` 分系统，profile-brownfield）。强制要求，无 `N/A` 豁免空间。

## 账本

| # | Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|---|
| 1 | 命令替换内只读命令豁免 | `$(basename ...)` 在 read-only for 循环内自动放行 | `test/bash-extract.test.ts` | `substitution_basename_in_for_loop_reliable: basename_in_for_loop_auto_exempt` | 🟢 已实现（task 1.1） |
| 2 | 命令替换内只读命令豁免 | 嵌套 basename+dirname 自动放行 | `test/bash-extract.test.ts` | `substitution_nested_basename_dirname_reliable: nested_basename_dirname_auto_exempt` | 🟢 已实现（task 1.1） |
| 3 | 命令替换内只读命令豁免 | 白名单外命令替换仍判不可靠 | `test/bash-extract.test.ts` | `substitution_cat_still_unreliable: cat_not_in_whitelist_still_prompts` | 🟢 已实现（task 1.2） |
| 4 | 命令替换内只读命令豁免 | `realpath`（含 `-m`）暂不豁免 | `test/bash-extract.test.ts` | `substitution_realpath_still_unreliable: realpath_not_in_whitelist_still_prompts` | 🟢 已实现（task 1.2） |
| 5 | 命令替换内只读命令豁免 | 白名单命令含未加引号 glob 参数仍判不可靠 | `test/bash-extract.test.ts` | `substitution_glob_arg_still_unreliable: basename_with_unquoted_glob_arg_still_prompts` | 🟢 已实现（task 1.2） |
| 6 | 命令替换内只读命令豁免 | 嵌套深度超过 3 层判不可靠 | `test/bash-extract.test.ts` | `substitution_depth_over_3_still_unreliable: nesting_depth_over_3_still_prompts` | 🟢 已实现（task 1.2） |
| 7 | 命令替换内只读命令豁免 | 白名单命令参数中嵌套替换含写操作仍判不可靠 | `test/bash-extract.test.ts` | `substitution_nested_rm_still_unreliable: nested_rm_still_prompts` | 🟢 已实现（task 1.2） |
| 8 | 命令替换内只读命令豁免 | 白名单命令参数含用户变量仍豁免但走变量判定 | `test/bash-extract.test.ts` | `substitution_with_user_var_still_unreliable: user_var_inside_substitution_still_prompts` | 🟢 已实现（task 1.2） |
| 9 | 命令替换内只读命令豁免 | 白名单命令 + 后续命令含真实写操作仍提取 write target | `test/bash-extract.test.ts` | `substitution_echo_then_rm_writes_target: exempt_substitution_still_extracts_downstream_write` | 🟢 已实现（task 1.3） |
| 10 | 命令替换内只读命令豁免 | `$(dirname ...)` 单独出现自动放行 | `test/bash-extract.test.ts` | `substitution_dirname_reliable: dirname_alone_auto_exempt` | 🟢 已实现（task 1.1） |
| 11 | 命令替换内只读命令豁免 | `$(pwd)` 自动放行 | `test/bash-extract.test.ts` | `substitution_pwd_reliable: pwd_auto_exempt` | 🟢 已实现（task 1.1） |

**额外的回归测试**（超出 11 个 scenario 覆盖下限）：

| # | 类型 | 测试名 | 目的 |
|---|---|---|---|
| R1 | 既有审计回归 | `substitution_btp_audit_97_still_triggers_prompt: audit_97_pattern_still_prompts` | 确认既有 `BTP-audit-97`（`$(grep -c 'X' file.md)`）在豁免实现后仍判 `command_substitution`，防止豁免过宽 |
| R2 | 安全不变量回归（review #1） | `substitution_redirect_still_unreliable: echo_redirect_still_prompts` | 确认 `$(echo hi > /tmp/x)` 内部的重定向不会绕过 `command_substitution` 门禁静默写入 |
| R3 | 安全不变量回归（review #1） | `substitution_pipeline_still_unreliable: echo_pipeline_still_prompts` | 确认 `$(echo hi \| tee /tmp/x)` 内部的管道不会绕过 `command_substitution` 门禁 |
| T1 | 边界行为回归（review T1） | `substitution_test_builtin_reliable: test_with_query_flag_auto_exempt` | 确认 `$(test -n x)` 是白名单路径（`test` 单独调用通过豁免，与 `[` 别名区分） |
| T2 | 边界行为回归（review I1） | `substitution_bracket_builtin_unreliable: bracket_not_in_whitelist_still_prompts` | 确认 `$( [ -n x ] )` 仍判不可靠——`[` 已从白名单移除（避免死条目：`[` 在白名单中但 `[` 字符本身被 glob 分支拒绝） |
| T3 | 边界行为回归（review T2） | `substitution_arith_unreliable: arith_substitution_still_prompts` | 确认 `$((x))` 算术 substitution 仍判不可靠——顶层命令提取会把 `(x` 当作命令名，白名单外自动拒 |
| T4 | 边界行为回归（review T3） | `substitution_basename_no_args_reliable: basename_no_args_still_exempt` | 确认 `$(basename)` 无参仍豁免——豁免判定只看顶层命令名，不检查是否有参数（bash 本身会报错，extractor 不感知） |
| T5 | 边界行为回归（review T4/I3） | `substitution_backtick_nested_still_unreliable: backtick_nested_still_prompts` | 确认 `$(echo \`ls\`)` 反引号嵌套仍判不可靠——反引号是命令替换的旧形式，豁免拒绝 |

## 状态说明

- 11 条 scenario 全部 🟢（GREEN 完成）
- 8 条额外回归测试（R1-R3 + T1-T5）全部 🟢
- 无 unmapped scenario，无 `N/A` 条目
- 验证证据：`npm test` 全量 `ℹ pass 539` `ℹ fail 0`；`test/bash-extract.test.ts` 单文件 `ℹ pass 396` `ℹ fail 0`（新增 22 个 substitution_ 测试全部通过）；手动复现用户报告原始命令 `for f in ...; do echo "=== $(basename $(dirname $f)) ==="; ...` → `reliable: true, targets: []`

## 与 tasks.md 的交叉引用

- task 1.1（正向豁免）覆盖 #1、#2、#10、#11
- task 1.2（反例）覆盖 #3、#4、#5、#6、#7、#8
- task 1.3（交互）覆盖 #9
- task 1.4（审计回归）覆盖 R1
- code_review finding #1（安全不变量）覆盖 R2、R3
- code_review finding T1-T5（边界行为）覆盖 T1、T2、T3、T4、T5
