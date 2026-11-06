## Why

`bash-extract` 子系统的目标提取与不可靠判定存在多条可复现的绕过路径：实际含写/删除副作用的命令被判为「可靠 + 只读目标」或「可靠 + 零目标」，从而跳过弹窗与 `unread` 硬拒，静默执行。当前测试不代表安全——部分测试把漏洞行为写成预期。（基线实测：全量 959 个测试中 956 pass / 3 fail，3 个 fail 全在 `sys-integration.test.ts`，均为 `EPERM` 沙箱错误——DSH workspace-write 沙箱阻止测试沙箱在 `$HOME` 下 `mkdtemp` / 读 `~/.ssh`，属运行环境限制而非代码缺陷；`bash-extract.test.ts` 单独跑为 611 pass / 0 fail 全绿。）这不是新功能，是既有守卫承诺（敏感文件保护 / 项目外写入确认 / `unread` 硬拒）未在部分命令形态下生效。

实测复现（当前 `main`，`src/lib/bash-extract/entry.ts` 经 `extractBashTargets`）：

| 命令 | 当前输出 | 应然 |
|---|---|---|
| `echo hi \| find /outside/victim -delete` | `reliable:true, read /outside/victim` | 不可靠（write 被当 read）|
| `bash -c "cat /tmp/in" > /outside/out` | `reliable:true, read /tmp/in` | 外层写目标 `/outside/out` 漏提 |
| `for f in a; do x=5 rm /outside/victim; done` | `reliable:true, targets:[]` | `rm` 被变量赋值前缀吞掉 |
| `echo hi > "/outside/out"` | `reliable:true, targets:[]` | 带引号重定向目标漏提 |

对照组正确：`find /etc -name x -delete` → `find_write_flag`；`cat /a /b && cp /c /d` → 4 目标。

## What Changes

- **fail-closed 契约**：`ExtractResult` **语义收紧（类型形状不变，见 Impact 与 design D0）**——凡语义分类或目标提取无法自证完整，各守卫正确返回 `reliable:false` 落 `!reliable` 分支弹窗，不再「可靠 + 错误目标」放行。豁免只在「判定为可靠之后」短路，与 `entry.ts` 既有 fail-closed 兜底（`entry.ts:54` 0 目标回退）同构。
- **只读豁免升级为验证式白名单**：只读判定从「信命令名」改为「命令名 + 写 flag 校验」。真正只读命令（`cat`/`ls`/`git status` 等）保持免弹；挂只读命令名干写事的形态（如 `find -delete`）进白名单失败 → 降级不可靠。`grant-memory` 白名单（用户对同一 rawCommand 明确授权）保留，且其 unread 硬拒兜底不变。
- **逐 pipeline stage 守卫**：`find -delete` 等写 flag 守卫当前只检管道前首命令，改为对每个 stage 独立执行守卫与目标提取。
- **具体提取器修复**（作为上述机制的回归用例驱动）：`bash -c` 外层重定向目标合并、`for` 循环体内变量赋值前缀命令（`x=5 rm`）、带引号重定向目标解析。
- **多目标循环控制流**：`extensions/index.ts` 逐 target 决策中，任一 target 触发 prompt 即整体 `return`，其后 target（含 `unread`）不再检查——改为先完成全部 target 的硬拒扫描，再进入 prompt。

## Capabilities

### New Capabilities

（无——本 change 不引入新 capability，只收紧既有 capability 的判定语义。）

### Modified Capabilities

- `bash-target-extraction`：`ExtractResult` 契约增加 fail-closed 降级语义；只读豁免需写 flag 校验；管道按 stage 独立守卫；`bash -c` 外层重定向、`for` 赋值前缀命令、带引号重定向的目标提取修正。

（多 target bash 命令的 `unread` 硬拒先于 prompt——该项不属 spec 变更：`access-decision` 的「unread 权限语义」requirement 已明确每个 target `deny_hard` 且不可绕过，当前是 `extensions/index.ts` 逐 target 循环在首个 prompt target 处早退、**实现违反既有契约**，修复落在 design/tasks，不改 spec。）

## Impact

- **代码**：`src/lib/bash-extract/`（`control-flow.ts` 逐 stage find 守卫 + `parse.ts` 带引号重定向 + `entry.ts` `bash -c` 外层重定向合并 + `silent.ts` `for` 赋值前缀守卫）；`extensions/index.ts`（多 target 循环控制流）。文件归属经架构 review 实测更正——`tryExtractLiteralShellC` 在 `entry.ts:34`、`isForBodyReadOnly`/`isAssignmentPart` 在 `silent.ts:932`/`:975`。
- **公共契约**：`ExtractResult` **类型形状不变**，仅语义收紧——各守卫在既有 `{ reliable: false, rawCommand, reason }` 分支内的返回分布更精确（design D0）。消费方为 `extensions/index.ts` 与 `src/lib/policy/access-decision`，两者只读 `.reliable`/`.reason`，**零适配、非跨子系统 breaking**。
- **行为面**：部分此前静默放行的命令将弹窗（安全上升、弹窗略增）；真正只读命令免弹不变（验证式白名单保留低弹窗）。
- **测试**：`test/bash-extract.test.ts` 及相关需新增对抗性回归用例；部分把漏洞行为写成预期的既有断言需更正。

## scenario→test 覆盖账本

本 change 的测试即交付物（TDD），每个 spec scenario 映射到 `tasks.md` 的具名任务（任务内定义具体测试用例）。`applyRequires` 仅含 `tasks`，账本为 archive 复盘对照提供锚点。

| Spec scenario（bash-target-extraction delta） | 映射 task | 测试意图 |
|---|---|---|
| 只读命令名携带写 flag 经管道降级 | 1.1 / 2.2 | `echo hi \| find /outside/victim -delete` 不返回 `{reliable:true, read}` |
| 真正只读命令保持可靠免弹 | 1.5 / 2.2 | `find /etc \| sort \| head -5` 保持 `{reliable:true}` |
| 可靠性判定优先于豁免短路 | 1.1 / 2.2 | 命中只读白名单 + 写形态时先判不可靠 |
| 写 flag 位于非首 stage | 1.1 / 2.2 | 守卫在 find 所在 stage 命中（非首命令） |
| 全只读 stage 保持可靠 | 1.5 / 2.2 | `cat /a \| grep x \| sort` 保持 `{reliable:true}` |
| 转发体只读但外层写重定向到项目外 | 1.3 / 4.2 | `bash -c "cat /tmp/in" > /outside/out` 提取外层写目标 |
| 转发体只读且无外层重定向 | 1.5 / 4.2 | `bash -c "cat /tmp/in"` 行为不变 |
| 循环体内赋值前缀携带删除命令 | 1.4 / 5.2 | `for f in a; do x=5 rm /outside/victim; done` 提取删除目标或降级 |
| 循环体内普通命令不受影响 | 1.5 / 5.2 | `for f in a b; do cat $f; done` 保持免弹 |
| 双引号包裹的写重定向目标 | 1.2 / 3.2 | `echo hi > "/outside/output"` 提取写目标 |
| 单引号包裹的写重定向目标 | 1.2 / 3.2 | `echo hi > '/outside/output'` 提取写目标 |
| 未闭合引号的写重定向保守降级 | 3.2 | `echo hi > "/outside/output`（未闭合）降级不可靠 |
| sed 只读豁免遇未闭合引号写重定向不成立 | 3.3 | `sed -n 's/a/b/' f > "/outside/o`（未闭合）sed 豁免不成立、降级 |

- 多 target unread 硬拒先于 prompt（access-decision 既有契约的实现修复，无 spec delta）→ 映射 task 6.2。
- 无 unmapped scenario。

## caller impact 分析

- **变更点清单**：
  - `src/lib/bash-extract/control-flow.ts` `scanFindWriteFlags`（D1）——模块内导出函数，**非跨子系统公共契约**（仅 `entry.ts` 调用）→ ④ 类内部实现变更。
  - `src/lib/bash-extract/parse.ts` `extractRedirects`（D2）——内部实现变更（④）。**两个调用方**：`entry.ts:383`（主提取路径）与 `silent.ts:870`（`isSedReadonlyForm` 收集写重定向判 sed 豁免）；D2 改其返回契约（无闭引号 → 降级信号），两处同步对齐，见 design D2 与 tasks 3.3。
  - `src/lib/bash-extract/entry.ts` `tryExtractLiteralShellC`（D3）——内部实现变更（④）。文件归属经架构 review 更正：定义在 `entry.ts:34`，非 `shell-forwarder.ts`。
  - `src/lib/bash-extract/silent.ts` `isForBodyReadOnly` / `isAssignmentPart`（D4）——内部实现变更（④）。文件归属经架构 review 更正：定义在 `silent.ts:932`/`:975`，非 `readonly.ts`（`readonly.ts:445` 仅调用点）。
  - `extensions/index.ts` 逐 target 循环控制流（D5）——集成层内部逻辑，不改 `ExtractResult` 形状 → ④ 类。
  - **无 ①（公共符号）/②（公共契约形状）/③（装配点）类变更点**：D0 决策确认 `ExtractResult` union 形状不变，仅各守卫返回值在 `reliable:false` 分支内的分布变化，消费方零适配。
- **高危标记**：无（无 ①③ 类变更点）。
- **已知 caller**：`extractBashTargets` 的调用方 `extensions/index.ts:622`（`extractBashTargets(command, state.projectRoot)`）——预判**兼容**，返回类型形状不变；该调用方同时是 D5 的改动点，自身在 tasks 6.1 内适配。

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条「从定性到定量的综合集成」）

- **影响哪些分系统**：`bash-extract`（tier-medium，主战场）、`policy-core/access-decision`（消费 `ExtractResult`）、`extension-orchestration`（`extensions/index.ts` 多 target 循环与弹窗）。
- **整体性能预期变化**：安全性上升——上述 4 类命令 + 多 target unread 绕过不再静默通过；可用性微降——部分形态改为弹窗，真正只读命令经验证式白名单保持免弹。预期量化见「预期行为模型」。
- **这是局部优化还是全局协调**：全局协调。把安全性保障从「逐个提取器各自写对」上移到「解析器自证完整，否则 fail-closed」，是单一机制覆盖多类绕过，而非逐洞打补丁。
- **局部优化对全局失调的风险**：若只做提取器逐个修补（本 change 拒绝的替代方案），每个新 shell 语法都可能再出洞，属主基调第 1 条「局部更优、全局失调」。本 change 通过 fail-closed 契约统一兜底避免该失调。
- **预期行为模型**：对上述 4 条命令 + 1 条多 target unread 命令，改后必须不再出现「`reliable:true` 且目标是 read 或空」的放行结果——具体为：`find -delete` 经管道 → 不可靠弹窗；`bash -c` 外层重定向 → 提取到外层写目标；`for` 赋值前缀 `rm` → 提取到删除目标或降级不可靠；带引号重定向 → 提取到写目标；多 target 中含 unread 时 → unread 硬拒先于 prompt 触发。**验证数据/测试**：`node --experimental-strip-types --test test/` 新增上述对抗用例全绿；对照组（`cat /etc/passwd | grep root` 等 7 条）行为不回归。
- **与既有架构/风格的遵循关系**：遵循既有分层（`src/lib` 纯函数 + `extensions` 集成层）、fail-closed 兜底惯例（`entry.ts:54`）、`grant-memory` + unread 硬拒机制（`extensions/index.ts:630`）与 TDD 开发约定。**偏离点**：只读白名单从「命令名匹配」改为「命令名 + 写 flag 校验」，是既有只读判定（`silent.ts` `isForBodyReadOnly` / `isAssignmentPart`）粒度的收紧——属老代码行为变更（`ExtractResult` 类型形状不变，非公共契约变更，见 Impact 与 design D0），已按 brownfield × tier-medium human-in-loop 触发确认（本 change 经 `/td-explore` 用户拍板 b2-A：fail-closed 优先，豁免升级为验证式）。
- **需求权衡处置**：本 change 承载「安全 fail-closed」与「低弹窗可用性」的权衡。设计侧处置为**两全**：fail-closed 作默认，验证式白名单保留低弹窗（真正只读免弹，仅挂只读名干写事的形态降级）。最近 5 个「减弹窗」提交（`30b57ac`/`1a73290`/`6ad543e`/`ab50566`/`84d345a`）建立的只读豁免**不被整体回退**，只把豁免判据从信命令名改为验形态——豁免数量基本保持，判据收紧。该权衡已在 explore 阶段由用户拍板（b2-A），非 agent 低置信度推测。

## 架构 review

> **隔离说明**：本节 Verdict 来自独立 fresh-context subagent 评审（`reviewed-by: subagent`），其报告原文已逐字回传到本上下文。此前 lead 曾做过一次同上下文自评（APPROVED），被本次独立评审**推翻**——查出 3 个 warning（D3/D4 根因文件归属错误、Impact 与 D0 矛盾、D2 第二调用方遗漏），均已修复。这是隔离评审相对自评的实证价值。

### 高内聚
- 子系统边界单一：D1–D4 全落 `bash-extract`（提取/可靠性判定），D5 落 extension 编排层（多 target 循环），无越界；未把 policy 语义渗入提取层，`ExtractResult` 仍是唯一跨界数据载体。**OK**
- 数据所有权清晰，D0（不改 `ExtractResult`）强化了降级语义在提取层闭环；职责无重复，D1 复用 `splitPipelines`、D3 复用 `extractRedirects`、D2 否决在 `looksLikePath` 剥引号，Alternatives 逐条记录拒绝重复造轮子。**OK**

### 低耦合
- 无新增循环依赖：`control-flow.ts:4` 本就 import `parse.ts`（D1 加 `splitPipelines` 不新增边）；`entry.ts:5` 本就 import `extractRedirects`（D3 不新增边）。**OK**
- **既有循环依赖**（非本 change 引入，独立评审实测记录）：`parse.ts:6 ↔ readonly.ts:6`、`readonly.ts:7 ↔ silent.ts:6`、`control-flow.ts:6 → silent.ts:8 → shell-forwarder.ts:5 → control-flow.ts:5`。ESM 函数提升维持运行时成立，本 change 不加深不修复。**OK（既有，出范围）**
- D5 否决「改 `decideTarget` 签名携带后续 target」，未把循环序关系泄漏进决策函数签名。**OK**

### Caller Impact
- 分析节存在；变更点类别标注齐备（5 处均 ④ 类）；高危标记齐备（无 ①③ 类）；已知高危 caller `extensions/index.ts:622` 已核实确为 `extractBashTargets` 调用。**结构合规**
- 独立评审指出原稿不足（已修复）：变更点 2/5 文件归属错（D3 标 shell-forwarder.ts、D4 标 readonly.ts），D2 的 `extractRedirects` 实际 2 个调用方（`entry.ts:383` + `silent.ts:870`）而非单一内部调用。**已更正**

### 关键陈述验证（独立评审直接跑 `extractBashTargets` 复现，非仅读码）
- 管道 find：`control-flow.ts:9-18` `scanFindWriteFlags` 只调 `splitCommands`、循环内无 `splitPipelines`，首 token `echo`≠`find` 守卫不进入。实测 `{"reliable":true,"targets":[{"read /outside/victim"}]}`。**属实**
- 带引号重定向：`parse.ts:504` 排除集不含引号 → path=`'"/outside/output"'`；`looksLikePath`(`parse.ts:429-440`) 不命中 `startsWith("/")`、末尾 `"` 使 `/\.\w+$/` 不匹配 → `parse.ts:510 continue` 丢目标。实测 `{"reliable":true,"targets":[]}`。**属实**
- bash -c 外层重定向：行为属实，实测 `{"reliable":true,"targets":[{"read /tmp/in"}]}`；`tryExtractLiteralShellC` 实际定义在 `entry.ts:34`（`entry.ts:55` 直接 return 内层目标），**原 design/tasks 标 shell-forwarder.ts 错**——已更正。**属实（文件归属已修）**
- for 赋值前缀：行为属实，实测 `{"reliable":true,"targets":[]}`；`isForBodyReadOnly` 定义在 `silent.ts:932`，真正豁免根因 `isAssignmentPart` 在 `silent.ts:975-982`，**原标 readonly.ts 错**——已更正。**属实（文件归属已修）**
- 对照组同样验证通过（`find /etc -name x -delete`→find_write_flag；`cat /a /b && cp /c /d`→4 targets）。
- D0 类型不变说法：`parse.ts:22-24` `ExtractResult` 为 `{reliable:true;targets} | {reliable:false;rawCommand;reason?}`，消费方只读 `.reliable`/`.reason`，零适配成立。原 Impact 段「类型形状扩展…跨子系统契约变更」与 D0 及源码矛盾——**已更正为「语义收紧，非类型变更」**。
- 多 target unread 判断站得住：`access-decision/spec.md:83-103` unread requirement 明确 MUST deny_hard 且不弹窗；`decideTarget`(`extensions/index.ts:944-953`) 对 unread 无条件 deny_hard；而 `extensions/index.ts:754` 循环在首个 prompt target 处 `return handlePromptDecision`(`:787-789`)，其后 target 的 unread 永不被判定。**「实现违反既有 MUST、非契约缺失」判断成立**

### Issues
独立评审原报 4 条（3 warning + 1 nit），**全部已处理**：

1. **[warning·已修复]** D3/D4 变更点文件归属错误 → design.md Context/D3/D4、proposal Impact/caller impact/遵循关系/关键陈述验证、tasks 4.1/5.1 共 8 处路径改 `entry.ts` / `silent.ts`。
2. **[warning·已修复]** proposal Impact 与 design D0 自相矛盾 → Impact 段 + What Changes 首条改为「类型形状不变，仅语义收紧」。
3. **[warning·已修复]** D2 返回契约改动漏第二调用方 → design D2 补「多调用方契约对齐」+ caller impact 补 `silent.ts:870` + 新增 tasks 3.3。
4. **[nit·已修复]** D5 两阶段对 prompt target 调 `decideTarget` 两次 → design D5 补性能注记 + tasks 6.1 改为阶段一缓存 decision、阶段二复用。

### Verdict
APPROVED_WITH_CHANGES（3 warning + 1 nit 均已在 artifact 层修复，修复后回读一致）
reviewed-by: subagent
四条根因经实测全部属实、D0 与源码一致、多 target unread 判断成立、切分高内聚低耦合无新增循环依赖——架构决策可进 apply；原报 3 warning（D3/D4 文件错标、Impact 与 D0 矛盾、D2 第二调用方遗漏）已全部改到 artifact。
---

## 实际系统工程影响 vs 预期（archive 复盘，2026-11-06）

对照「系统工程影响评估」节逐字段复盘：

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：bash-extract（主战场）、policy-core/access-decision（消费 ExtractResult）、extension-orchestration（多 target 循环与弹窗） | 实际影响分系统相同：bash-extract（D1-D4）、extension-orchestration（D5 两阶段）、policy-core/access-decision（消费方零适配，`ExtractResult` 形状未变）；另触及 `reason-codes` 契约（新增 `unterminated_redirect_quote` 码，15→16）——预期未列出但为必要新增（新 reason 码必须入稳定契约才能正确显示弹窗副标题） |
| 整体性能预期变化：安全性上升、可用性微降（部分形态弹窗，真正只读命令白名单免弹） | 实际整体性能变化一致：4 类命令 + 多 target unread 不再静默通过（fail-closed）；对照组（7 条）行为不回归；D5 两阶段对单 target 路径多一次 `decideTarget` 调用的性能影响可忽略（两阶段仅在多 target 时才有二次遍历，且缓存复用避免重复计算，见 design D5 性能注记） |
| 这是局部优化还是全局协调：全局协调（fail-closed 契约统一兜底） | 实际是全局协调：fail-closed 契约（解析器自证完整）统一覆盖 5 类绕过，非逐洞打补丁 |
| 局部优化对全局失调的风险：逐洞修补会出更多洞 | 局部优化的实际全局影响：无失调。收尾 review 的 2 warning（多赋值前缀过度弹窗 = 局部过度收紧）已修复；D4 保留纯赋值豁免、D5 保留单 target 语义，均未放行方向失调 |
| 预期行为模型：5 类命令改后不得出现「reliable:true 且目标是 read 或空」放行；对照组不回归 | 模型验证：**预期行为模型已验证**。实测：`find -delete` 经管道 → unreliable(find_write_flag)；`bash -c` 外层重定向 → read+write 双目标；`for` 赋值前缀 `rm` → unreliable(control_flow)；带引号重定向 → write 目标；多 target unread → hard-deny 先于 prompt（promptCount=0）。对照组（7 条）实测不回归。 |

### 预期之外的副作用
- `bash -c "cat /a > /b"`（无外层重定向）的内层写 `/b` 由内层递归提取（非外层误抓）——D3 修复前曾把引号内 `/b` 误当外层写，已修复（`tokens.indexOf(cArg)` 之后的 token 尾部才跑 extractRedirects）。
- reason-codes 契约从 15 码扩到 16 码（`unterminated_redirect_quote`），i18n 双 bundle + TOTAL_CODE_COUNT 同步更新——非破坏性新增。

### scenario→test 覆盖账本状态
- proposal「Spec scenario 账本」13 条：全部 GREEN（FCH-1/2/2b/3/4/5a-d/6/6b 对应 12 条 + FCH-D5-1 对应多 target unread 修复条目），无 N/A 条目。

### 需求权衡处置
- 无留待 archive 对照的矛盾项（架构 review 的 4 条 warning/nit 已在 apply 前 artifact 层解决；收尾 review 的 2 warning 在 6.3 内修复并复验）。
