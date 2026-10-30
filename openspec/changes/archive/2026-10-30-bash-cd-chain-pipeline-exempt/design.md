# Design: bash-cd-chain-pipeline-exempt

## Context

cd 跟踪豁免（`analyzeCd`，`src/lib/bash-extract/shell-forwarder.ts:720`）条件 3「每个片段 `splitPipelines` 结果恰好 1 stage」对管道一刀切：`cd <绝对> && npm test 2>&1 | tail -25` 判 `cd_chdir` 弹窗，而语义等价的无管道命令静默放行。实测确认（2026-10-29）：

- `cd <abs> && npm test` → `reliable:true`（D2a 豁免，SILENT 0 target）
- `cd <abs> && npm test 2>&1 | tail -25` → `reliable:false, reason:"cd_chdir"`（仅卡条件 3）
- `cd /etc && cat passwd | head -5`、`cd /etc && sort sub | wc -l` → `cd_chdir`（相对引用/裸词，无论有无管道都该拦）

entry 层顺序（`entry.ts`）：cd 守卫（step 2b）**仅在命中时 return**；豁免后继续走 shell-forwarder 守卫 → 转发器守卫 → 管道 stage 提取。即 cd 豁免不短路任何后续安全扫描。

## Goals / Non-Goals

**Goals**

- 条件 3 从「片段无管道」放宽为「管道逐 stage 通过条件 4~11 的同等内容检查」。
- 纯 stdin 管道（零路径引用 stage）在 cd 链下静默放行；含相对引用 / 裸词 / cwd 锚点 / glob 的管道维持 `cd_chdir`。

**Non-Goals**

- 不改全绝对下游豁免（D2b）的 `anyAbsRef` 要求（其防空转语义独立成立，动机案例经 D2a 放宽即已覆盖）。
- 不改 ExtractResult 结构、decision.ts 分派、其他 reason code。
- 不做 cd 与管道交互的完整 shell 语义建模（非 Goal「不做完整 shell 解析」）。

## Decisions

### D1：下游片段降维为「stage 粒度」判定，而非新增管道专用检查

**选择**：`analyzeCd` 内把 `downstreamFragments`（片段全文）改为 `downstreamStages`——每个下游片段先 `splitPipelines` 拆 stage，展平后作为条件 4~11 的判定单元；条件 4~11 的**检查逻辑体**不改，但**遍历结构必改**——条件 7/10/11 当前以 `tokenize(frag)[0]` 取首命令（shell-forwarder.ts:833/:865/:901），展平后必须对每个 stage 重新 `tokenize(stage)` 取首命令（实施时列为独立 checklist 项，防只删条件 3 而漏改遍历）。stage 是片段的子串，raw 扫描 `containsUnquotedGlob` / `containsCwdAnchor` / `$PWD` 检查在 stage 上语义等价（glob/锚点/变量不可能跨 `|` 出现）。

**放弃的备选**：为管道 stage 写一套独立的平行检查。否——条件 4~11 已经是「片段内路径引用」的完整判定，复制一份必然漂移（F2 三波补漏的教训：同类规则分散会漏）。

**cd 片段约束保留**：cd 片段自身 `splitPipelines` 结果仍须恰好 1 stage（`cd a | b` 不可静态确定），该检查从条件 3 拆出为独立前置检查。

### D2：转发器不在条件 3 排除，由既有转发器守卫兜底

`cd /etc && cat /etc/passwd | xargs rm` 在 cd 守卫层豁免，随后 entry 层转发器守卫判 `forwarding_command`（下游 rm 是 write，不满足 read-only 下游豁免）。**理由**：转发器守卫本就覆盖所有 stage（含首 stage），cd 守卫提前拦截只会把 reason 从更具体的 `forwarding_command` 变成 `cd_chdir`，损失诊断精度。既有 reason 报告优先级原则（`cd_chdir` 比 `shell_forwarder` 更具体时才前置，见 entry.ts 注释）与此一致。**风险**：既有安全探针若有「cd 链 + 管道 → cd_chdir」断言，reason 会变为 `forwarding_command`——apply 阶段全量跑探针，按预期行为变化更新断言（同前序 change 对 `cd /etc && ls` 的处理先例）。

### D3：cwd 模拟解析不改

条件 3 放宽只影响**豁免判定**；豁免成立后 entry step 5 的逐片段提取本就先拆管道再逐 stage 用 `resolveBase(simulatedCwd)` 解析——管道 stage 的相对路径已按跟踪 cwd 解析，无需改动。

### D4：i18n 文案同步

`cd_chdir` 中英文文案（i18n.ts:66/:172）的「无 ;/||/&/管道」边界描述改为「管道各 stage 通过路径安全检查时自动解析」，与实际行为一致（同 bash-bounded-glob-readonly-silent 的「文案与实际一致」先例）。

## Risks / Trade-offs

- [豁免面扩大引入误放行] → 条件 4~11 逐 stage 化后仍全覆盖相对引用/裸词/锚点/glob/git 写子命令；新增 6 个反例 scenario 断言锁死；全量 701+ 用例 + security-probe 回归。
- [既有断言 reason 变化（cd_chdir → forwarding_command / reliable）] → apply 阶段先跑全量测试与探针，逐一核对为预期行为变化后更新断言，非预期回归则回滚条件 3 改动。
- [逐 stage 检查遗漏跨 stage 形态（如 stage 间组合语义）] → bash 管道 stage 间仅有数据流（stdin/stdout），无共享文件路径语义；组合不产生新的 cwd 依赖。残留风险记入 tasks 已知边界。**已知边界**：`|&`（stdout+stderr 管道）因条件 1 pureAnd 扫描将 `&` 判非纯 `&&` 链而维持 `cd_chdir`——这是条件 1 与条件 3 的交互副作用而非设计意图，结果保守正确；后续若修改条件 1 扫描，不得顺带放开 `|&`。
- [条件 9/10 的 `collectStagePathRefs` 对含管道片段的收集范围] → 实现时验证其按 stage 拆分后的收集完整性（stage 是子串，收集范围只会更窄不会更宽）；如发现片段级收集含 stage 外内容，以 stage 级为准。

## Migration Plan

纯函数内部判定放宽，无配置/数据迁移。回滚 = revert `shell-forwarder.ts` 条件 3 改动 + i18n 文案 + 测试断言，单 commit 可整体回退。

## Open Questions

（无——动机案例、反例边界、转发器兜底行为均已实测确认。）
