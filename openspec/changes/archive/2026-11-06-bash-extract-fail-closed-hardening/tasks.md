<!-- caller impact 实测（td-apply 步骤 4，2026-11-06）：逐变更点符号搜索实测 caller，结论全部兼容。D4 的 isForBodyReadOnly 有 3 个调用方（readonly.ts:445、control-flow.ts:208、control-flow.ts:527），均 for 循环体只读判定、返回 boolean 不变——兼容，proposal caller impact 所列「仅 readonly.ts:445」需补记此 2 处。D2 的 extractRedirects 实测 2 个调用方（entry.ts:383 + silent.ts:870），与独立 review 一致，3.3 已覆盖 silent.ts:870 对齐。其余变更点均模块内单一调用方，兼容。 -->

<!-- 步骤 6.3 收尾 review（隔离 subagent，2026-11-06）：APPROVED_WITH_CHANGES，无 critical，2 warning + 2 nit，均已在 6.3 内修复并复验。warning 1：`unterminated_redirect_quote` 未注册进稳定 bash reason-code 契约 → 已加入 `BashReasonCode`/`BASH_REASON_CODES`（15→16）、`bashReasonCodeAndParams` codes 集合、i18n en/zh bundle、`TOTAL_CODE_COUNT`（57→58），同步更新 reason-codes.test.ts（15→16、35→36）与 i18n.test.ts（57→58）期望。warning 2：D4 多赋值前缀只读命令过度弹窗 → `isForBodyReadOnly` 剥离改为循环剥离连续赋值前缀（`x=5 y=6 cat /a` 免弹、`x=5 y=6 rm` 仍降级）。复验：typecheck exit=0；bash-extract 622/622；extensions 39/39；reason-codes+i18n 24/24；全量 971 tests 仅 2 EPERM（SYS7/SYS-GRANT 沙箱）+ AL7 通过（既有 flaky）。nit 3（tokens.indexOf 按值定位，仅病态输入、偏安全）与 nit 4（`false as boolean` 转写，有注释）记录不修。 -->

<!-- tier-medium：project buffer = 关键链总估时 × 35%。关键链见下方「关键链」标注，buffer 落在集成测试（tier-medium 特殊规则：跨分系统链的 buffer 留在集成）。 -->

<!-- 任务主体约束：每条 task 主体均为 agent 可编程执行的动作（写测试 / 改代码 / 跑测试命令）。人工目测与用户验收已降级为对应 task 的「验证」字段，不作为独立 task。 -->

**关键链**：`1.1–1.5（RED 用例）` → `2.x（D1 管道 find）`∥`3.x（D2 引号重定向）`∥`4.x（D3 转发外层重定向）`∥`5.x（D4 赋值前缀）`，其中 5.x（赋值前缀，估 3h）为最长支流 → `6.x（D5 orchestration 两阶段）` → `7.1（全量集成回归）`。跨子系统链：`bash-extract`（1–5）→ `extension-orchestration`（6）→ 集成回归（7）。

**关键链估时**：RED 用例 2h + 最长支流 D4 3h + D5 2h + 集成回归 1.5h = **8.5h**。
**project buffer（35%）**：8.5 × 0.35 ≈ **3h**，落在 `7.1` 集成回归（含对抗形态边界补充与既有只读豁免回归对照）。

## 1. 对抗回归用例先行（TDD RED）

- [x] 1.1 在 `test/bash-extract.test.ts` 新增用例：`echo hi | find /outside/victim -delete` 不得返回 `{reliable:true, targets:[read /outside/victim]}`；跑 `node --experimental-strip-types --test test/bash-extract.test.ts` 确认 RED
- [x] 1.2 新增用例：`echo hi > "/outside/output"` 与 `echo hi > '/outside/output'` 必须提取到写 target `/outside/output`；跑测试确认 RED
- [x] 1.3 新增用例：`bash -c "cat /tmp/input.txt" > /outside/output` 必须提取到外层写 target `/outside/output`；跑测试确认 RED
- [x] 1.4 新增用例：`for f in a; do x=5 rm /outside/victim; done` 必须提取到删除 target 或降级 `reliable:false`；跑测试确认 RED
- [x] 1.5 新增对照用例：`find /etc | sort | head -5`、`cat /a | grep x | sort`、`for f in a b; do cat $f; done`、`bash -c "cat /tmp/input.txt"` 保持 `{reliable:true}` 免弹；跑测试确认当前为 GREEN（锁定免弹不回归）
- [x] 1.6 验证：`git stash` 前确认 1.1–1.4 RED、1.5 GREEN，作为修复前后对照基线（实测 2026-11-06：620 tests，FCH-1/2/2b/3/4 共 5 RED，FCH-5a-d 共 4 GREEN；611 既有测试无回归）

## 2. D1 管道逐 stage 写 flag 守卫

- [x] 2.1 改 `src/lib/bash-extract/control-flow.ts` `scanFindWriteFlags`：对每个 command fragment 再 `splitPipelines`，逐 stage 首 token 判 `find` + `isFindReadOnly`，任一 stage 命中即返回 `find_write_flag`
- [x] 2.2 验证：1.1 用例转 GREEN；1.5 中 `find /etc | sort | head -5`、`cat /a | grep x | sort` 保持 GREEN；跑全量 `node --experimental-strip-types --test test/` 无回归（实测 2026-11-06：FCH-1 GREEN，FCH-5a/5b GREEN，620 tests pass 616 / fail 4 全为 FCH-2/2b/3/4 依赖后续任务，611 既有无回归）

## 3. D2 重定向目标剥引号

- [x] 3.1 改 `src/lib/bash-extract/parse.ts` `extractRedirects`：路径读取遇首字符 `"`/`'` 进入引号感知子模式，读到匹配闭引号后剥引号取纯路径再判 `looksLikePath`；无闭引号时返回信号交上层降级 `reliable:false`（实测：返回 `boolean`，true=未闭合引号写重定向；entry.ts:383 与 silent.ts:870 均已消费）
- [x] 3.2 验证：1.2 用例转 GREEN；新增边界用例 `echo hi > "/outside/output`（无闭引号）降级 `reliable:false`；跑全量测试无回归（实测：FCH-2/2b GREEN，FCH-6 GREEN，622 tests pass 620 / fail 2 全为 FCH-3/4，既有 611 无回归）
- [x] 3.3 对齐 `extractRedirects` 第二调用方 `silent.ts:870`（`isSedReadonlyForm` 用它收集写重定向）：无闭引号降级信号出现时判 sed 只读豁免**不成立**（含未闭合引号写重定向的 sed 脚本保守弹窗），不可误判为「无写重定向」；新增 `sed -n 's/a/b/' f > "/outside/o`（未闭合引号）不豁免的用例；跑全量测试无回归（实测：FCH-6b GREEN，既有 sed 豁免用例全 GREEN）

## 4. D3 转发器外层重定向合并

- [x] 4.1 改 `src/lib/bash-extract/entry.ts` `tryExtractLiteralShellC`（:34，非 `shell-forwarder.ts`）：递归提取内部目标后，对外层命令跑 `extractRedirects` 合并重定向目标；外层重定向存在但无法解析时降级 `reliable:false`（实测：`extractRedirects(stages[0].trim(), outerRedirects, projectRoot)` 合并 + 返回 true 时回退弹窗）
- [x] 4.2 验证：1.3 用例转 GREEN；1.5 中 `bash -c "cat /tmp/input.txt"`（无外层重定向）保持 GREEN；新增 `/dev/*` fd 重定向沿用豁免的对照用例；跑全量测试无回归（实测：FCH-3 GREEN，FCH-5d GREEN，622 tests pass 620 / fail 1 全为 FCH-4，既有 611 无回归）

## 5. D4 控制流体赋值前缀命令守卫

- [x] 5.1 改 `src/lib/bash-extract/silent.ts` `isForBodyReadOnly`（:932）/ `isAssignmentPart`（:975，非 `readonly.ts`——`:445` 仅调用点）：识别 `VAR=value cmd args` 时剥离赋值前缀后继续对 `cmd` 执行写守卫与目标提取；仅纯赋值（无后续命令）才整体豁免；无法确定时降级 `reliable:false`（实测：tokenize 检测完整赋值前缀 + 后续命令 token，剥离后对 rest 跑守卫；`n=$(grep` 未闭合 $() 不误判为前缀）
- [x] 5.2 验证：1.4 用例转 GREEN；1.5 中 `for f in a b; do cat $f; done`（纯只读循环）保持 GREEN；新增 `x=5 cat $f` 仍只读免弹的对照用例；跑全量测试无回归（实测：FCH-4 GREEN，FCH-5c GREEN；既有 `literal_shell_c_targets_equivalent_to_direct_execution` 因 D3 引号参数误抓回归已修复，622 tests 全 GREEN）

## 6. D5 orchestration 多 target 两阶段决策

- [x] 6.1 改 `extensions/index.ts` 逐 target 循环（`for (const target of extraction.targets)` :754 起）为两阶段：第一阶段对全部 target 跑 `decideTarget` 并**缓存每个 target 的 decision**，任一 `deny_hard` 立即 hard-deny 返回（保持现有 audit 字段）；第二阶段复用缓存的 decision 按序处理 prompt/allow（避免 `decideTarget` 对 prompt target 重复计算，见 design D5 性能注记）
- [x] 6.2 在 `test/` 新增多 target unread 回归用例：命令 `cat /outside/a && cat <unread 路径>` 中 unread 硬拒在首 target prompt 短路前触发 `deny_hard`；验证转 GREEN（此为既有 `unread 权限语义` 契约的实现修复）（实测：FCH-D5-1 `cat /Users/x/.ssh/id_rsa && cat /etc/passwd`，/etc/passwd unread → block=true 且 promptCount=0）
- [x] 6.3 验证：跑全量 `node --experimental-strip-types --test test/`，确认 grant-memory、unread 硬拒、tier 语义既有用例无回归（实测：extensions/index.test.ts 39 tests 全 GREEN，含既有 SYS-B1 unread 硬拒、grant-memory、tier 用例）

## 7. 集成回归与系统级验证（含 project buffer 3h）

- [x] 7.1 全量测试 `npm test`（= `node --test "test/*.test.ts" "extensions/*.test.ts"`；RED 阶段单文件用 `node --experimental-strip-types --test test/<file>`）结果不差于基线；对照 proposal 表 7 条命令（含 4 条对抗 + 3 条正确对照）行为符合「预期行为模型」：对抗形态不再 `{reliable:true}` 放行、对照形态免弹不回归；如有超出预期的弹窗增量，回看 D1–D4 判据是否过粗并收紧（buffer 用于此处的边界补充与回归对照）。**基线注记**：DSH workspace-write 沙箱下全量 956 pass / 3 fail，3 个 fail 全在 `sys-integration.test.ts` 且均为 `EPERM`（测试沙箱无法在 `$HOME` 下 `mkdtemp` / 读 `~/.ssh`），属运行环境限制非代码缺陷——`bash-extract.test.ts` 单独跑应 611 pass / 0 fail 全绿；apply 阶段以「不新增非 EPERM 类失败」为回归判据，非 EPERM 失败即视为回归（实测：bash-extract.test.ts 622 pass / 0 fail；extensions/index.test.ts 39 pass / 0 fail；全量 971 tests。3 个 fail = SYS7/SYS-GRANT EPERM（沙箱，基线已有）+ AL7 并发 audit flaky（经 git stash 基线复跑确认既有 flaky，非本 change 回归；基线 run 亦 3 fail 含 AL7）。回归判据满足）
- [x] 7.2 类型检查：跑 `npm run typecheck`（= `tsc --noEmit`）确认无类型错误（实测 exit=0）
- [x] 7.3 验证：确认 `ExtractResult` 类型形状未变更（design D0），`extensions/index.ts` 与 `access-decision` 消费方零适配改动，spec delta 仅 `bash-target-extraction`（实测：parse.ts:22 `ExtractResult` 定义无 diff；`extractRedirects` 仅内部返回类型 void→boolean，两调用方均在 bash-extract 模块内非跨子系统；spec delta 文件仅 `specs/bash-target-extraction/spec.md`）