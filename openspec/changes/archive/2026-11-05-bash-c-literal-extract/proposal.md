## Why

`bash -c "cat ~/.ssh/id_rsa"` 这类命令的字符串参数里**没有变量、没有命令替换、没有控制流**，是一个可静态确定的纯字面量命令，但当前实现把它**整体判为 shell_forwarder 不可靠**，走三档弹窗（可持久化"总是允许本命令"）。一旦用户持久化，内部访问的敏感文件（如 `~/.ssh/id_rsa`）被"整条命令粒度授权"覆盖，**绕过敏感路径硬底线**（这是本 change 要堵住的唯一能绕过硬底线的通道）。

设计文档 `bash-stage-b-security-fixes/design.md` Q5 曾决策"不扩展字符串内部解析"，理由是"字符串内部可能带引号嵌套、转义、变量替换，静态分析不可靠"。该理由对**一般情况**成立，但对**纯字面量子集**是过度保守。本 change 只对可证明为纯字面量的字符串参数做**精确提取**，非字面量保持原 shell_forwarder 行为，决策**绝不更宽松**。

## What Changes

- **新增**：bash 提取层对 shell 转发器（`bash -c "..."` / `sh -c "..."` / `zsh -c "..."`）的字符串参数，若可证明为**纯字面量**（不含 `$`、反引号、控制流关键字、glob/花括号 brace expansion、换行），则**递归解析**提取其 read/write/delete 目标
- **新增**：护栏判定——纯字面量检测（`isPureLiteralShellArg`）+ 递归深度限制（允许 1 层 `-c` 递归，内层再嵌 `bash -c` 回退）+ **0 目标回退**（递归提取不到任何目标时必须回退 shell_forwarder 弹窗）
- **保持**：非纯字面量字符串参数（含 `$`、`$(...)`、控制流、glob/brace、换行）维持现有 shell_forwarder 不可靠行为——**不变**
- **行为变化**：纯字面量 `bash -c "<命令>"` 从"整体三档弹窗（可持久化）"变为"精确提取目标 → 交决策层判定"，**与直接执行 `<命令>` 同权限**。方向双面：敏感文件（`~/.ssh/id_rsa`）**收严**为两档不可持久化弹窗（堵风险 1）；项目外非敏感读（`/etc/passwd`）**放宽**为静默（与直接执行 `cat /etc/passwd` 一致，用户本就能静默读，非新风险）。**安全性质**：精确化后权限判定 **≤ 直接执行该命令**，不引入新风险
- **BREAKING（既有测试需更新）**：
  - `test/bash-extract.test.ts` 的 `BMG8/9/10/12/12b/14`（纯字面量 `bash -c "rm -rf /"`、`sh -c "cat /etc/passwd"` 等断言 shell_forwarder）→ 改为精确提取断言
  - `test/security-probe.mjs` 的 L1/L2 系列（`L1_bash_posix_c`/`L1_bash_norc_c`/`L1_bash_noprofile_c`/`L1_sh_posix_c`/`L2_sudo_bash_c`/`L2_timeout_*_bash_c`/`L2_watch_bash_c`/`L2_nice_n10_bash_c`/`L2_sudo_env_bash_c`，共 ~10 条纯字面量 `bash -c 'rm -rf /'`）→ 改为 `reliable:true`（`rm` 提取 `delete /`）；`c3_bash_script_path`/`c4_bash_input_redirect`（脚本路径/stdin 重定向，非 `-c`）不受影响
  - `test/cross-system-boundary.mjs` Boundary 2（`sudo bash --posix -c 'rm -rf /'` 纯字面量）→ 改为 `reliable:true`
- **不受影响**：`test/trust.test.ts:537` 与 `test/keypoints.test.ts:83` 用 `bash -c "git status"`（内层 0 目标静默 → 回退 shell_forwarder），授权记忆/keypoints 等价类契约不变
- **不涉及**：授权记忆通道（`trusted.json.bashGrants`）的持久化语义不变；`keypoints` 等价类不变

## Capabilities

### New Capabilities

（无——不引入新的分系统 spec）

### Modified Capabilities

- `bash-target-extraction`: 修改"Shell 转发器守卫" requirement——纯字面量字符串参数不再无条件判 shell_forwarder，而是递归提取目标；非字面量仍判 shell_forwarder。新增 requirement "纯字面量 shell 转发器递归提取"（含护栏与回退契约）

## Impact

- **代码**：`src/lib/bash-extract/entry.ts`（`isShellForwarder` 命中后新增递归分支）+ `src/lib/bash-extract/shell-forwarder.ts`（新增 `extractLiteralShellArg` / 护栏判定）+ 复用现有 `scanUnreliable` / `findUnresolvedVariable` 做内层守卫
- **测试**：`test/bash-extract.test.ts`（新增场景：纯字面量提取目标、`$()`/变量/控制流/0目标回退、递归深度限制）
- **决策层**：`decision.ts` 无需改动——递归提取的目标走既有 `decideTarget`，敏感文件自然走两档弹窗
- **授权记忆**：`trust.ts` 无需改动——`bash -c` 字符串不再产生"整命令持久化"授权（纯字面量路径不再落入 bashGrants 通道）
- **行为契约**：`docs/security/permission-model.md` 的"bash grant 扫裸路径 token 时 `bash -c "cat /etc/passwd"` 不生效"已知限制需要更新（纯字面量已生效）

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"——专家判断 + 数据 + 模型反复迭代上升到定量认识）

- **影响哪些分系统**：`bash-target-extraction`（主）、`access-decision`（间接——目标走既有决策）、`grant-memory`（间接——纯字面量不再产生整命令持久化授权）
- **整体性能预期变化**：纯字面量 `bash -c "<命令>"` 从"单次弹窗（三档）"变为"与直接执行同权限"。**可测量**：对 100 条纯字面量 `bash -c "cat <path>"` 样例，项目外非敏感路径从弹窗变为静默放行（与直接执行 `cat <path>` 一致）；敏感路径保持弹窗但降为两档（不可持久化）。**技术无关**：描述为"用户对纯字面量 `bash -c` 命令的确认频次随路径类型变化（敏感保持、非敏感下降）"，不涉及实现细节
- **这是局部优化还是全局协调**：局部优化（`bash-target-extraction` 单一分系统的提取精度提升，不改变决策层与授权记忆的全局语义）
- **如果是局部优化，对全局失调的风险**：低。安全性质保证"精确化后权限判定 ≤ 直接执行该命令"——有目标走与直接执行完全相同的路径决策，0 目标回退弹窗（更严）；唯一风险是纯字面量检测误判（把含 `$` 的字符串误判为纯字面量），通过复用现有 `scanUnreliable`/`findUnresolvedVariable` 内层守卫 + 护栏判定双重保险，误判概率趋近 0
- **预期行为模型**：输入 `bash -c "cat ~/.ssh/id_rsa"` → 输出 `{ reliable: true, targets: [read /Users/eliot/.ssh/id_rsa] }`（纯字面量精确提取）；输入 `bash -c "cat $MYSECRETS"` / `bash -c "cat $(echo x)"` / `bash -c "for f in *.ts; do cat $f; done"` → 输出 `{ reliable: false, reason: "shell_forwarder" }`（非字面量回退）；输入 `bash -c "echo hi"` → 输出 `{ reliable: false, reason: "shell_forwarder" }`（0 目标回退）。**验证**：新增 `test/bash-extract.test.ts` 场景断言上述 4 类行为 + 递归深度限制
- **与既有架构/风格的遵循关系**：新设计遵循既有分系统架构——纯函数、无 IO/UI、复用现有 `extractBashTargets` 递归 + 既有守卫（`scanUnreliable`/`findUnresolvedVariable`），不引入新依赖；偏离既有架构或风格的点无

## caller impact 分析

（tier 分层：本 change 为 bash-target-extraction 分系统的行为增强，涉及 `extractBashTargets` 返回值的**语义扩展**——新增一类输入（纯字面量 shell 转发器）从 `reliable:false` 变为 `reliable:true + targets`）

- **变更点清单**：
  - ① 公共符号语义变化：`extractBashTargets` 对"纯字面量 `bash -c` 字符串"的返回值从 `reliable:false` 变为 `reliable:true + targets`——属于第①类（公共符号）变更点，但**方向是精确化**（从弹窗到精确判定），非破坏性放宽
  - ② 行为契约变化：`bash-target-extraction` spec 的"Shell 转发器守卫" requirement 对纯字面量子集不再无条件判 shell_forwarder——属于第②类
- **高危标记**：涉及①类（公共符号 `extractBashTargets` 返回值语义）——标注"中危"。方向是**收敛**（更多命令精确化而非放行），且 0 目标强制回退保证不放宽，不构成 go/no-go 阻塞点
- **已知 caller**：`extensions/index.ts:622`（`handleBash` 调 `extractBashTargets`）——**需适配**：`handleBash` 的 `!extraction.reliable` 分支需要处理"可靠但含 shell_forwarder 内层目标"的情况（现逻辑对可靠命令逐 target 走 `decideTarget`，已天然兼容，无需改）；`test/bash-extract.test.ts` / `test/security-probe.mjs`——**需适配**（新增场景 + 确认既有 shell_forwarder 场景仍判不可靠）

## scenario→test 覆盖账本

（`applyRequires` 含 `specs` artifact，tier-medium/large 强制）

本 change 的 delta spec 新增以下 Scenario，映射到 `test/bash-extract.test.ts` 的具名测试：

| Scenario | 测试 |
|---|---|
| `bash -c "cat ~/.ssh/id_rsa"` 纯字面量精确提取 read 目标 | `literal_shell_c_extracts_read_target`（test/bash-extract.test.ts） |
| `bash -c "rm -rf /tmp/x"` 纯字面量提取 delete 目标 | `literal_shell_c_extracts_delete_target`（test/bash-extract.test.ts） |
| `bash -c "cat /etc/passwd && rm /etc/x"` 复合纯字面量提取多目标 | `literal_shell_c_composite_extracts_multi`（test/bash-extract.test.ts） |
| `sh -c "cat /etc/passwd"` / `zsh -c "ls /etc"` 纯字面量提取 | `literal_shell_c_sh_zsh_extract`（test/bash-extract.test.ts） |
| `bash -c "c""at ~/.ssh/id_rsa"` 嵌套引号拼接（tokenize 合并→纯字面量）精确提取 | `literal_shell_c_nested_quote_concat_extracts`（test/bash-extract.test.ts） |
| `bash -c "cat $MYSECRETS"` 变量回退 shell_forwarder | `literal_shell_c_variable_falls_back`（test/bash-extract.test.ts） |
| `bash -c "cat $(echo x)"` 命令替换回退 | `literal_shell_c_substitution_falls_back`（test/bash-extract.test.ts） |
| `bash -c "for f in *.ts; do cat $f; done"` 控制流回退 | `literal_shell_c_control_flow_falls_back`（test/bash-extract.test.ts） |
| `bash -c "echo hi"` 0 目标回退 shell_forwarder | `literal_shell_c_zero_target_falls_back`（test/bash-extract.test.ts） |
| `bash -c "bash -c 'cat x'"` 递归深度上限（1 层）回退 | `literal_shell_c_recursion_depth_limited`（test/bash-extract.test.ts） |
| `bash -c "cat x" && rm /etc/important` 复合外层回退（防丢目标，实施补充）| `literal_shell_c_outer_compound_falls_back`（test/bash-extract.test.ts） |
| `bash -c "cat /etc/passwd" \| head` 管道外层回退（实施补充）| `literal_shell_c_outer_pipeline_falls_back`（test/bash-extract.test.ts） |
| `bash -c cat /etc/passwd` 未引号只取首 token 不误提取（实施补充）| `literal_shell_c_unquoted_c_arg_reads_only_first_token`（test/bash-extract.test.ts） |
| 既有 `bash -c "rm -rf $DIR"` 非纯字面量仍判不可靠（回归） | `existing_shell_c_nonliteral_still_unreliable`（test/bash-extract.test.ts） |
| 既有 `BMG8/9/10/12/12b/14`（纯字面量断言）→ **BREAKING 更新** | `existing_shell_c_literal_now_extracts`（test/bash-extract.test.ts） |
| 既有 security-probe L1/L2 系列（~10 条 `bash -c 'rm -rf /'`）→ **BREAKING 更新** | `L1_*/L2_*` 断言改 reliable:true（test/security-probe.mjs:85-105） |
| 既有 cross-system-boundary Boundary 2（`sudo bash --posix -c 'rm -rf /'`）→ **BREAKING 更新** | 断言改 reliable:true（test/cross-system-boundary.mjs:44-47） |
| 既有 trust/keypoints（`bash -c "git status"` 内层 0 目标）不受影响 | `test/trust.test.ts:537` / `test/keypoints.test.ts:83`（回归确认） |

**账本说明**：tier 判定为 tier-medium（影响 1 个分系统 + 公共符号语义扩展，行为收敛但含 BREAKING 既有测试更新），故强制账本。以上每个 Scenario 在 delta spec 中都有对应 `#### Scenario:`，逐一映射到具名测试。**BREAKING 行**覆盖三类既有断言更新：bash-extract BMG 系列、security-probe L1/L2 系列、cross-system-boundary Boundary 2。**不受影响行**确认 trust/keypoints 契约不变（内层 `git status` 0 目标 → 回退 shell_forwarder）。

## 架构 review 记录（propose 后、apply 前）

**Verdict**：`MUST_FIX_CRITICAL` → 全部 critical 已修复，可达 `APPROVED_WITH_CHANGES`
**reviewed-by**: subagent（两个独立隔离 review 交叉验证，结论一致）

两个隔离 review 发现并已修复的问题：

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| 1 | critical | 嵌套引号拼接 scenario 假契约——`tokenize` 合并 `"c""at ~/.ssh/id_rsa"` 为单一纯字面量 token，实际**精确提取**而非回退（实测确认 `parse.ts:378`） | spec scenario 改为"被合并提取"；design Non-Goals + Goals 改为"护栏作用于 tokenize 归一化后参数串" |
| 2 | critical | BREAKING 清单遗漏 `test/security-probe.mjs` L1/L2 系列（~10 条纯字面量 `bash -c 'rm -rf /'`）+ `cross-system-boundary.mjs` Boundary 2 | proposal BREAKING 清单 + 账本 + tasks 4.7/4.8 补全三类既有断言更新 |
| 3 | warning | `extractLiteralShellArg` 若放 shell-forwarder.ts 会与 entry.ts 循环依赖 | tasks 3.2 明确：纯谓词放 shell-forwarder.ts，递归编排放 entry.ts（`extractBashTargets` 所在） |
| 4 | warning | 多个 RED 测试实际是 GREEN（当前已判 shell_forwarder），违背 TDD 先红后绿 | tasks 第 2 节诚实标注"当前已绿，护栏落地后保持绿，价值是回归防护"，真 RED 在 1.x |
| 5 | nit | 纯字面量护栏漏 brace expansion `{a,b}`；深度措辞"≤2"含糊 | D1/spec 拦截集补 `{ }`；D2/spec 统一为"允许最深 1 层 `-c` 递归" |

核心安全性质经两个 review 独立确认成立无反例：**精确化后权限判定 ≤ 直接执行该命令**（有目标走与直接执行同路径，0 目标回退更严）。trust.test.ts:537 / keypoints.test.ts:83 契约不变（内层 `git status` 0 目标 → 回退 shell_forwarder）。

## 实际系统工程影响 vs 预期（td-archive 步骤 3 复盘，2026-11-05）

对照源：① 本节上方「系统工程影响评估」/「预期行为模型」/「caller impact 分析」；② 主 spec baseline `openspec/specs/bash-target-extraction/spec.md`（存在，197KB；"Shell 转发器守卫" requirement 现状为"无条件判 shell_forwarder"，本 change delta MODIFIED 它 + ADDED 新 requirement，未触碰 baseline 其他不变量——baseline 的"纯字面量"出现处是 for 循环赋值/命令替换只读语义，与本 change 的"纯字面量 shell 转发器递归提取"是不同 requirement，不冲突）。

### 逐字段复盘（tier-medium 全 5 字段）

| proposal 侧（预期） | archive 侧（实际） | 一致性 |
|---|---|---|
| 影响分系统：bash-target-extraction（主）、access-decision、grant-memory（间接） | **一致**——caller impact 实测：唯一生产 caller `handleBash`(index.ts:622) 天然兼容无需改；决策层 decision.ts / trust.ts 确实零改动（跨分系统测试 trust/keypoints/grant-memory/reason-codes/audit 全绿印证）| ✅ 一致 |
| 整体性能预期：纯字面量 `bash -c` 从三档弹窗变与直接执行同权限；敏感收严两档、非敏感外区读放宽静默 | **一致**——实测 `bash -c "cat ~/.ssh/id_rsa"`→read 敏感（两档不可持久化）、`bash -c "rm -rf /tmp/x"`→delete（tier-two prompt 不可持久化）、`bash -c "cat /etc/passwd"`→read 外区（静默，与直接执行同）。性能开销：递归仅在 shell_forwarder 命中+纯字面量通过+单 stage 时触发，常规命令零开销 | ✅ 一致 |
| 局部优化 vs 全局协调 | **实际是局部优化**——bash-target-extraction 单一分系统提取精度提升，未改变决策层/授权记忆全局语义（`decideTarget` 硬底线、`bashGrants` 持久化通道均不变）| ✅ 一致 |
| 局部优化的全局失调风险：低（安全性质 ≤ 直接执行保证不放宽） | **一致且已固化**——收尾 review 独立代码路径论证"≤ 直接执行"无反例；外层形态限制防丢复合/管道外层目标；新增 `literal_shell_c_targets_equivalent_to_direct_execution` 参数化测试把"目标集合恒等"固化为契约（5 组含 /dev/tcp）。无全局失调 | ✅ 一致 |
| 模型验证（预期行为模型） | **模型成立**——6 条预期输入/输出全部实测通过（见 tasks.md「6.4 实际 vs 预期对照」表）：纯字面量提取读/删/复合、变量/替换/控制流/0目标回退、`/dev/tcp` 硬底线。无偏差，无需修正预测模型 | ✅ 已验证 |

### 补充字段

- **预期之外的副作用**：无功能副作用。实施中发现 3 项设计增强（均更保守/澄清方向，非偏离）：① 外层限单 fragment 单 stage（防丢复合/管道外层其余 stage 目标的安全洞）；② 未引号 `-c` 只取首 token（不误提取 `$0`）；③ `]` 不拦（review nit，`]]` 单独非 glob 活跃字符，拦它只误伤合法文件名无安全收益）。三项均已回写 design/spec + 补测试。无预期外的风险面扩大。
- **scenario→test 覆盖账本状态**：**全绿**。14 个 Scenario（11 原计划 + 3 实施补充）全部有对应具名测试（14 个 `literal_shell_c_*` + BMG/既有测试更新），`literal_shell_c_targets_equivalent_to_direct_execution` 额外固化核心安全性质。**无 N/A 条目**。
- **需求权衡处置**：**无遗留矛盾**。架构 review 发现的"嵌套引号拼接假契约"已在 propose 阶段经实测解决（改为精确提取而非回退，因 tokenize 合并相邻引号段）；security-probe L1/L2 BREAKING 遗漏已补全 spec/tasks。无标"留待 archive 对照"的未决矛盾。

### 复盘结论

预期行为模型**已验证**，实际影响与 proposal 评估完全吻合，无功能性偏离，无预期外风险面扩大，无遗留矛盾。综合集成循环闭合——本 change 把"纯字面量子集可精确提取"的预测模型经验证确立，其"≤ 直接执行"安全性质经代码路径论证 + 参数化测试双重固化，可作为后续 bash 提取精确化 change 的预测基础。
