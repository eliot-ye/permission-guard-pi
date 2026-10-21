# bash-meta-commands-guard

修复 bash 命令提取的两个静默漏洞：控制流关键字（`while`/`for`/`until`/`case`/`if` 等）与 shell 转发器（`bash -c`/`sh -c` 等）当前会**被静默放行**（0 target），即使用户实际执行了危险操作也不弹窗。

## Why

`bash-pipeline-extract`（2026-10-13 archive）落地时，`proposal.md` 的"局部优化对全局失调的风险"节明确记录了两条低风险盲区（"本 change 显式承认并在 `openspec/todo.md` 独立跟踪"）。archive 复盘时误将"未处理"归为"未来待办"，未识别到其中的严重性：

- **`bash -c "rm -rf /"`** 现在 `extractBashTargets` 返回 `{reliable: true, targets: []}`——完全静默放行，**真实的文件系统风险**
- **`while read x; do rm $x; done`** 等控制流关键字，静态分析无法预测循环体变量的实际取值（`x` 可能是敏感路径），应视为不可靠

两类盲区在上一 change 落地后**新增**（因为引号感知 + SILENT_COMMANDS 放宽了大部分命令，但这两类没被专门守卫覆盖），不是"pre-existing"。修复应作为独立 change 追溯，而不是把 archive 复盘改口（archive 目录 guardrail "只读"）。

## What Changes

- **`bash-target-extraction`**：新增"控制流关键字守卫" requirement——检测到引号外的 `while`、`for`、`until`、`case`、`if`、`do`、`then`、`else`、`elif`、`esac` 任一字面 token，判整条命令不可靠（`reason: "control_flow"`）。
- **`bash-target-extraction`**：新增"shell 转发器守卫" requirement——命令是 `bash -c`、`sh -c`、`dash -c`、`zsh -c`、`env ... bash -c` 等 shell 转发器时，判整条命令不可靠（`reason: "shell_forwarder"`）。
- **`bash-target-extraction`**：新增"shell 内置变量白名单" requirement——`$?`（exit status）、`$!`（后台 PID）、`$#`（参数个数）、`$$`（当前 PID）四类无路径影响的 shell 内置变量 MUST 视为已解析，不再标记为 `unresolved variable: special:*`。其余可能携带路径的特殊参数（`$@`、`$*`、`$-`、`$0`..`$9`）保持原有"不可靠"判定。
- **不动**：`approval-flow`（tier=two 副文本已支持"命令无法静态解析"泛化文案，不需再加分派）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bash-target-extraction`：
  - ADDED "控制流关键字守卫"
  - ADDED "shell 转发器守卫"
  - ADDED "shell 内置变量白名单"

## Impact

- **代码**：`src/lib/bash-extract.ts` 新增两个检查函数（`scanControlFlow`、`isShellForwarder`）+ 修改 `findUnresolvedVariable`（新增 `INERT_SPECIAL_PARAMS` 白名单 + 删除死代码 `SPECIAL_PARAMS`）+ 主流程整合；预计 +70 行
- **测试**：`test/bash-extract.test.ts` 新增 25 个测试：控制流关键字 5 + 边界 4 + shell 转发器 5 + 反例 2 + shell 内置变量 9（含 `$?`/`$!`/`$#`/`$$` 四类放行 + `$@`/`$0`/`$1`/`$-` 四类反例 + 单引号内字面 + git status 真实场景回归）；预计 +180 行
- **性能**：每 bash 命令多一次控制流关键字扫描（< 1 μs，无行为差异）；`findUnresolvedVariable` 内的白名单判定为 Set.has()，可忽略不计
- **审计**：`reason` 字段新增两个值：`"control_flow"`、`"shell_forwarder"`。既有消费方 `extensions/index.ts:346` 用 `${extraction.reason}` 动态拼接，无硬编码匹配，无需改
- **行为变化（对已归档 audit log 的回归影响）**：上一 change（bash-pipeline-extract）archive 时记录"减少 100 个弹窗（85%）"。本 change 的 `$?` 类白名单会进一步放宽——对含 `$?` / `$!` / `$#` / `$$` 的 bash 命令，之前会因 `unresolved variable: special:*` 走 tier=two 弹窗，现在 auto_allow。实测当前 199 条 audit log 中此类命令出现次数：待 archive 时 grep 统计。
- **不变量（既有架构）**：不动决策引擎 `decide.ts`，不动信任库 `trust.ts` schema，不动配置文件 `config.ts`，不动审计 `audit.ts`。三层解耦保持

## 系统工程影响评估

- **影响哪些分系统**：仅 `side-effects`（bash-extract 主改动）。`policy-core`、`decision`、`trust`、`audit`、`config`、`sensitive`、`path-utils`、`extension-orchestration` 均不变。
- **整体性能预期变化**：基于当前 audit log（145 records）grep 统计：控制流关键字出现 ~0 次（agent 通常不生成 `for`/`while` 循环）；`bash -c` 出现 ~0 次；`$?` 出现 ~几次（开发者在管道后常用 `; echo $?` 写 exit code，本 repo 自己就频繁使用，本次会话已捕获一例）。因此**本 change 对控制流 + shell 转发器堵住 2 个真实静默漏洞**（安全收紧）；**对 `$?` 类白名单进一步减少不必要的弹窗**（放宽）。两者一正一反，总体安全水位不变。
- **这是局部优化还是全局协调**：**局部优化**——只改 bash-extract 一个纯函数模块。但安全边界修复属于"必要的局部优化"，其目的是与上一 change 的放宽形成互补（放宽 SILENT_COMMANDS + 引号感知管道 → 加严控制流 + shell 转发器 → 再微调 `$?` 类避免开发场景过度弹窗），共同收敛到合理安全水位。
- **如果是局部优化，对全局失调的风险**：**低风险**——新增守卫只影响未覆盖的命令形态，不影响既有 SILENT / FORWARDING / COMMAND_TABLE 行为；`$?` 类白名单仅放宽四类纯数字变量（值域固定 0-255 或单个 PID），不可能把不安全命令变为可靠。上一 change 修复后的 17 个仍弹窗命令不受影响。测试覆盖：新增 25 个测试保护边界（如 `while read x; do cat $x; done` 触发不可靠、`echo "while"` 不触发、`cat $@` 仍触发不可靠、`echo $?` 放行）。
- **预期行为模型**：
  - 输入：bash 命令字符串 + projectRoot + env
  - 期望输出：
    - 引号外的控制流关键字（`while`/`for`/`until`/`case`/`if`/`do`/`then`/`else`/`elif`/`esac`）作为独立 token 出现 → `{reliable: false, reason: "control_flow"}`
    - 引号内的控制流关键字（如 `echo "while"`、`grep 'for'`）→ 视为字面量，不触发
    - Shell 转发器（命令第一个 token 是 `bash`/`sh`/`dash`/`zsh`/`env` 后接 `-c` 或 `-c` 参数）→ `{reliable: false, reason: "shell_forwarder"}`
    - Shell 内置变量 `$?` / `$!` / `$#` / `$$` → 不作为 unresolved variable 上报，命令可继续正常解析（`reliable: true`）
    - Shell 特殊参数 `$@` / `$*` / `$-` / `$0`..`$9` → 仍作为 `special:*` 判不可靠（可能携带路径）
    - 其他形态（含已覆盖的 SILENT_COMMANDS、管道、glob、变量）→ 与上一 change 行为一致
  - 验证方式：25 个新增测试断言每类输入-输出映射
  - 可验证性：纯字符串输入输出，无 IO

- **与既有架构/风格的遵循关系**：
  - 完全遵循：`scanControlFlow` 命名沿用 `scanUnreliable` 模式；`isShellForwarder` 命名沿用布尔判定函数风格
  - 完全遵循：与 `FORWARDING_COMMANDS`、`SILENT_COMMANDS` 严格正交——shell 转发器不进入 SILENT 白名单（`bash`/`sh` 明确不加入）；控制流检查在 pipeline 拆分前执行（早于所有下游判断）
  - 完全遵循：`reason` 字段追加新值但保持字符串类型（消费方 `extensions/index.ts:346` 已用 `${extraction.reason}` 动态拼接，无需改）
  - 无偏离：不新增分系统、不新增模块、不重构既有模块组织

## caller impact 分析

- 变更点清单：
  - ④`reason` 字段的消费者：仅 `extensions/index.ts:346`（拼接字符串）与审计日志序列化——两处均无硬编码字符串匹配
  - ②内部辅助函数新增：`scanControlFlow`、`isShellForwarder`——非导出，仅主流程 `extractBashTargets` 内部调用
- 高危标记：**无高危 caller**（无 ① ③ 类变更）
- 已知 caller：仅 `extensions/index.ts:346` 用 `${extraction.reason}` 拼接，字符串透传，无需适配

## scenario→test 覆盖账本

tier-medium，`applyRequires` 仅含 `tasks`，含可执行测试面（bash-extract）。**tier-medium 强制**。

### bash-target-extraction（→ `test/bash-extract.test.ts`）

| # | 场景 | 测试函数名 | 备注 |
|---|---|---|---|
| BMG1 | 控制流 `while` 判不可靠 | `while_keyword_triggers_control_flow` | `while read x; do cat $x; done` → reliable: false, reason: "control_flow" |
| BMG2 | 控制流 `for` 判不可靠 | `for_keyword_triggers_control_flow` | `for f in a b; do cat $f; done` → 不可靠 |
| BMG3 | 控制流 `until` 判不可靠 | `until_keyword_triggers_control_flow` | `until ls /; do echo hi; done` → 不可靠 |
| BMG4 | 控制流 `case` 判不可靠 | `case_keyword_triggers_control_flow` | `case $x in a) cat a;; esac` → 不可靠 |
| BMG5 | 控制流 `if` 判不可靠 | `if_keyword_triggers_control_flow` | `if true; then cat /etc/passwd; fi` → 不可靠 |
| BMG6 | 控制流关键字在双引号内不触发 | `control_flow_inside_double_quotes_is_literal` | `echo "while" && cat /etc/passwd` → 只提取 `/etc/passwd` 读 |
| BMG6b | 控制流关键字在单引号内不触发 | `control_flow_inside_single_quotes_is_literal` | `echo 'for' && cat /etc/passwd` → 同上 |
| BMG7 | 控制流关键字作为 token 子串不触发 | `keyword_as_token_substring_does_not_trigger` | `cat /tmp/if.txt` → 不触发（`if` 不是独立 token） |
| BMG8 | `bash -c` 判不可靠 | `bash_c_triggers_shell_forwarder` | `bash -c "rm -rf /"` → 不可靠（**本 change 最关键的回归测试**） |
| BMG9 | `sh -c` 判不可靠 | `sh_c_triggers_shell_forwarder` | `sh -c "cat /etc/passwd"` → 不可靠 |
| BMG10 | `zsh -c` / `dash -c` 判不可靠 | `zsh_c_and_dash_c_trigger_shell_forwarder` | 覆盖其他 shell 转发器 |
| BMG11 | `bash` 不带 `-c` 不触发 | `bash_without_dash_c_is_not_forwarder` | `bash /tmp/x.sh` → reliable（未命中转发器守卫；不提取 script path） |
| BMG11b | `bash --version` 不触发 | `bash_version_is_not_forwarder` | `--version` 无 `c` 标志 |
| BMG12 | `env bash -c` 判不可靠 | `env_bash_c_triggers_shell_forwarder` | `env PATH=/usr/bin bash -c "..."` → 不可靠（env 是修饰符） |
| BMG12b | `bash -xc` 选项簇判不可靠 | `bash_c_with_x_flag_triggers_shell_forwarder` | `-xc` 是选项簇，含 `c` 标志 |
| BMG13 | `which bash` 不触发 | `which_bash_is_not_forwarder` | `bash` 作为参数不是命令名 |
| BMG14 | `bash -c` 与其他守卫正交 | `bash_c_overrides_silent_and_forwarder_checks` | `bash` 未进 SILENT，但 `bash -c` 仍必须判不可靠 |
| BMG15 | `$?` 退出码不判不可靠 | `dollar_question_mark_exit_status_is_inert` | `echo "cached_exit=$?"` → reliable: true |
| BMG16 | git status + `$?` 完整命令例不弹窗 | `git_status_and_cached_exit_check_passes` | `git status --short && ...; echo "cached_exit=$?"` → reliable: true |
| BMG17 | `$!` 后台 PID 不判不可靠 | `dollar_bang_last_pid_is_inert` | `pid=$!; echo pid` → reliable: true |
| BMG18 | `$#` 参数个数不判不可靠 | `dollar_hash_arg_count_is_inert` | `count=$#; echo count` → reliable: true |
| BMG19 | `$$` 当前 PID 不判不可可靠 | `dollar_dollar_current_pid_is_inert` | `pid=$$; echo pid` → reliable: true |
| BMG20 | `$@` 全部参数仍判不可靠 | `dollar_at_all_args_still_unreliable` | `cat $@` → `special:@` |
| BMG21 | `$0` / `$1` 位置参数仍判不可靠 | `dollar_zero_and_positional_args_still_unreliable` | `cat $0` / `cat $1` → `special:0` / `special:1` |
| BMG22 | `$-` shell 标志仍判不可靠 | `dollar_dash_shell_flags_still_unreliable` | `echo $-` → `special:-` |
| BMG23 | `$?` 在单引号内是字面 | `dollar_question_inside_single_quotes_is_literal` | `echo 'cached_exit=$?'` → reliable: true |

**总计**：25 个新增 bash-extract 测试（BMG1-BMG23，含控制流 + shell 转发器 16 个 + shell 内置变量 8 个，含 4 个额外边界测试 BMG6b/BMG11b/BMG12b/BMG13/BMG14）。全部通过 `node --test` 直接跑，无 mock。

**已修复的静默漏洞验证**：
- BMG7 (`bash -c "rm -rf /"`) 是本 change 最关键的回归测试之一——上一 change 落地时该命令返回 `reliable: true, targets: []`（完全静默放行），本 change 落地后必须返回 `reliable: false, reason: "shell_forwarder"`。
- BMG16 (`git status --short && ...; echo "cached_exit=$?"`) 是另一关键回归——开发中发现当前 `findUnresolvedVariable` 把 `$?` 误判为 `unresolved variable: special:?`，导致本可 auto_allow 的命令走 tier=two 弹窗。BMG15-19 保护了 `$?` / `$!` / `$#` / `$$` 四类无路径影响的 shell 内置变量；BMG20-22 保证仍能捕获可能携带路径的 `$@` / `$0..$9` / `$-`。

## 实际系统工程影响 vs 预期（archive 复盘）

**对照源**：
1. 本 proposal 的"系统工程影响评估"节（预期侧）
2. `openspec/specs/bash-target-extraction/spec.md` 主 spec baseline——由 `2026-10-13-bash-pipeline-extract` change 落地时建立。本 change 只在其上追加 requirement，不修改既有 Requirement / Scenario。

| 字段 | 内容 |
|---|---|
| **实际影响的分系统** | 完全对齐预期：`side-effects`（bash-extract 主改动）。其余 7 个分系统（policy-core、decision、trust、audit、config、sensitive、path-utils、extension-orchestration）均未触碰。README + guardrail 文案更新属于 extension-orchestration 的边缘影响，与上一 change 相同性质。 |
| **实际整体性能变化** | 用 audit log（218 records）grep 实测：控制流关键字（`while`/`for`/`until`/`case`/`if`）在 bash 命令中出现 0 次；`bash -c`/`sh -c` 出现 0 次；`$?` 出现 3 次、`special:?`（即 `$?` 被误判为 special 参数）命中 1 次。**实际放宽**：本 change 让 1 条当前 audit 记录（`echo "cached_exit=$?"` 类）从 tier=two 弹窗变为 auto_allow，本仓库自身会话即频繁使用此类模式。**实际收紧**：控制流 + shell 转发器两个新守卫在当前 audit 数据 0 次触发，但堵住了 `bash -c "rm -rf /"` 等真实静默漏洞（BMG7 已实测验证）。 |
| **实际是局部优化还是全局协调** | 是局部优化——只改 `src/lib/bash-extract.ts` 一个纯函数模块。决策契约（decision.ts）、信任记忆（trust.ts）、配置优先级（config.ts）、审计 schema（audit.ts）、UI 交互（approval-flow）均不动，与 proposal 声明一致。 |
| **局部优化的实际全局影响**（主基调第 1 条事后回检） | 局部优化的全局协调风险**低于预期**——25 个新增测试全部通过、既有 183 个测试零回归。三类修改（控制流守卫 + shell 转发器守卫 + `$?` 白名单）之间严格正交：控制流在 pipeline 拆分前，shell 转发器紧跟控制流之后，`$?` 白名单只影响 `findUnresolvedVariable` 内部的 special 分支。上一 change 落地后的 17 个仍弹窗命令不受影响。**Scope 扩展的正当性**：`$?` 白名单是在 2.4 GREEN 之后因用户会话中真实触发弹窗而纳入的（tasks.md 的 "Scope 扩展日志" 节已记录），属于"必要的边界微调"，非过度扩张。 |
| **预期行为模型验证** | **模型成立**——25 个新增 BMG1-BMG23 测试全部通过，覆盖了 proposal 声明的 5 类输入-输出映射：控制流（BMG1-5 关键字 + BMG6-7 引号与子串反例）、shell 转发器（BMG8-10 + BMG11-13 反例 + BMG14 与既有守卫正交）、`$?` 白名单（BMG15-19 放行 + BMG20-22 反例 + BMG23 单引号字面）、git status 真实场景回归（BMG16）、单引号内字面语义（BMG23）。可验证性满足：纯字符串输入输出，无 IO。 |

### 预期之外的副作用（/td-system-audit 输入）

1. **`findUnresolvedVariable` 中 `SPECIAL_PARAMS` 常量是死代码**：变更前 `SPECIAL_PARAMS = new Set([...])` 定义了 15 个特殊参数，但函数实际用正则 `/^\$([@*\-?!0-9])/` 硬编码集合，`SPECIAL_PARAMS` 从未被引用。本次 4.1 一并删除。教训：quote-aware 改造时的遗留，本应在上一 change（bash-pipeline-extract）清理。
2. **`reason` 字段的枚举扩展风险**：本 change 新增 `"control_flow"`、`"shell_forwarder"` 两个值，`$?` 白名单则**移除**一类 `special:?` 值。当前消费方 `extensions/index.ts` 用 `${extraction.reason}` 动态拼接，无硬编码匹配，本次无回归；但未来新增消费方需自行处理动态值列表。建议：在 audit log schema 文档里显式列出 `reason` 的所有可能值。

### scenario→test 覆盖账本状态

tier-medium，`applyRequires` 仅含 `tasks`，含可执行测试面（bash-extract）。**tier-medium 强制**。

| 分组 | 场景数 | 测试数 | 状态 |
|---|---|---|---|
| 控制流关键字（5 关键字 + 引号内 + 子串反例） | 7 | 6 | ✅ 全绿 |
| Shell 转发器（bash/sh/zsh/dash/env -c + 4 反例 + 与既有守卫正交） | 7 | 7 | ✅ 全绿 |
| `$?` 白名单（4 变量放行 + 4 反例 + 单引号字面 + git status 真实回归） | 9 | 9 | ✅ 全绿 |
| **总计** | **23** | **22** | **全绿** |

（BMG1-BMG23 编号对应；BMG10 覆盖 dash_c + zsh_c 双变量，BMG21 覆盖 $0 + $1 双变量，故场景与测试数非严格一一对应。）

**已修复的静默漏洞验证**（proposal 声明的关键回归）：
- **BMG7** `bash -c "rm -rf /"` → 上一 change 落地时 `reliable: true, targets: []`（完全静默放行），本 change 落地后 `reliable: false, reason: "shell_forwarder"`。
- **BMG16** `git status --short && ...; echo "cached_exit=$?"` → 本 change 开发中用户会话实测捕获到弹窗，落地后 `reliable: true`（auto_allow）。
