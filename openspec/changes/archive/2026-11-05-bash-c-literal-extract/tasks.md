# Tasks: bash -c 纯字面量递归提取

> 参考：design.md（如何实现）+ specs/bash-target-extraction/spec.md（行为契约）
> 方法：TDD（RED-GREEN-REFACTOR，测试先于实现）
> 验证命令：`npm test`（`node --test "test/*.test.ts" "extensions/*.test.ts"`）+ `node --experimental-strip-types test/security-probe.mjs`

## 1. RED——先写失败测试（纯字面量精确提取）

- [x] 1.1 新增 `literal_shell_c_extracts_read_target`：`bash -c "cat ~/.ssh/id_rsa"` → `reliable:true`，targets 含 `read /Users/eliot/.ssh/id_rsa`。**验证**：`node --experimental-strip-types --test test/bash-extract.test.ts` 该测试失败（当前判 shell_forwarder）
- [x] 1.2 新增 `literal_shell_c_extracts_delete_target`：`bash -c "rm -rf /tmp/x"` → `reliable:true`，targets 含 `delete /tmp/x`。**验证**：同上失败
- [x] 1.3 新增 `literal_shell_c_composite_extracts_multi`：`bash -c "cat /etc/passwd && rm /etc/x"` → `reliable:true`，targets 含 `read /etc/passwd` + `delete /etc/x`。**验证**：同上失败
- [x] 1.4 新增 `literal_shell_c_sh_zsh_extract`：`sh -c "cat /etc/passwd"` / `zsh -c "ls /etc"` → `reliable:true` 含目标。**验证**：同上失败
- [x] 1.5 新增 `literal_shell_c_nested_quote_concat_extracts`：`bash -c "c""at ~/.ssh/id_rsa"` → `reliable:true` 含 `read ~/.ssh/id_rsa`（`tokenize` 合并相邻引号段为纯字面量，精确提取，与 bash 拼接语义一致）。**验证**：失败（当前判 shell_forwarder）

## 2. 回退测试（当前已绿，护栏落地后保持绿）

> **诚实标注**：以下回退场景**当前实现已返回** `{reliable:false, reason:"shell_forwarder"}`（因尚未实现纯字面量精确化），断言"当前"即通过——它们不是先红后绿的 RED 测试。它们的价值是**回归防护**：确保护栏落地后，非纯字面量/0目标/嵌套 `-c` 场景**保持** shell_forwarder 不可靠（不被误判为精确提取）。真正的先红后绿在 1.x。

- [x] 2.1 新增 `literal_shell_c_variable_falls_back`：`bash -c "cat $MYSECRETS"` → `reliable:false, reason:"shell_forwarder"`（含 `$` 回退）。**验证**：当前已通过；护栏落地后仍通过（确认含 `$` 被拦截）
- [x] 2.2 新增 `literal_shell_c_substitution_falls_back`：`bash -c "cat $(echo x)"` → `reliable:false, reason:"shell_forwarder"`（`$(...)` 回退）。**验证**：当前已通过；护栏落地后仍通过
- [x] 2.3 新增 `literal_shell_c_control_flow_falls_back`：`bash -c "for f in *.ts; do cat $f; done"` → `reliable:false, reason:"shell_forwarder"`（控制流回退）。**验证**：当前已通过；护栏落地后仍通过
- [x] 2.4 新增 `literal_shell_c_zero_target_falls_back`：`bash -c "echo hi"` → `reliable:false, reason:"shell_forwarder"`（0 目标回退，不更宽松）。**验证**：当前已通过；护栏落地后仍通过
- [x] 2.5 新增 `literal_shell_c_recursion_depth_limited`：`bash -c "bash -c 'cat /etc/passwd'"` → `reliable:false, reason:"shell_forwarder"`（嵌套 `-c` 递归已到深度上限 1 层，回退）。**验证**：失败（护栏需深度限制拦截嵌套 `-c`）

## 3. GREEN——实现 `isPureLiteralShellArg` + 递归提取

- [x] 3.1 在 `src/lib/bash-extract/shell-forwarder.ts` 新增 `isPureLiteralShellArg(s: string): boolean`——不含 `$`/反引号/控制流关键字/未引号 glob（`* ? [ { }`，含 brace expansion）/换行。**验证**：`node --experimental-strip-types --test test/bash-extract.test.ts` 新测试 1.x 变绿
- [x] 3.2 在 `src/lib/bash-extract/entry.ts`（`extractBashTargets` 所在，避免循环依赖）新增 `extractLiteralShellArg(rawTokens, projectRoot, env, depth)`——取 `-c` 后 token、过 `isPureLiteralShellArg` 护栏、递归调 `extractBashTargets`，深度上限 1 层（内层再嵌 `-c` 回退），0 目标/不可靠回退 `shell_forwarder`。**注**：纯谓词 `isPureLiteralShellArg` 放 shell-forwarder.ts（与 `isShellForwarderTokenStream` 同域），递归编排放 entry.ts——**不得**把含递归的函数放 shell-forwarder.ts（会 entry↔shell-forwarder 循环 import）。**验证**：新测试 1.x + 2.5 变绿
- [x] 3.3 在 `src/lib/bash-extract/entry.ts` 的 `isShellForwarder` 命中分支（`entry.ts:60-62`）插入递归提取检查——纯字面量且提取到目标 → 返回 `{ reliable:true, targets }`，否则维持 `shell_forwarder`。**验证**：新测试 1.x/2.x 全部变绿

## 4. REFACTOR + 既有测试适配（BREAKING）

- [x] 4.1 更新 `BMG8`（`bash -c "rm -rf /"`）断言为 `reliable:true` + 提取 `delete /`（纯字面量精确化）。**验证**：`npm test` 该测试通过
- [x] 4.2 更新 `BMG9`（`sh -c "cat /etc/passwd"`）断言为 `reliable:true` + 提取 `read /etc/passwd`。**验证**：同上
- [x] 4.3 更新 `BMG10`（`zsh -c "ls /etc"` → 提取 read /etc；`dash -c "echo hi"` → 0 目标回退 shell_forwarder）。**验证**：同上
- [x] 4.4 更新 `BMG12`（`env PATH=/usr/bin bash -c "cat /etc/passwd"`）断言为 `reliable:true` + 提取 read。**验证**：同上
- [x] 4.5 更新 `BMG12b`（`bash -xc "cat /etc/passwd"`）断言为 `reliable:true` + 提取 read。**验证**：同上
- [x] 4.6 更新 `BMG14`（`bash -c "ls /etc"`）断言为 `reliable:true` + 提取 read。**验证**：同上
- [x] 4.7 更新 `test/security-probe.mjs` 的 L1/L2 系列纯字面量 `bash -c 'rm -rf /'` 断言（L1: `L1_bash_posix_c`/`L1_bash_norc_c`/`L1_bash_noprofile_c`/`L1_sh_posix_c`；L2: `L2_sudo_bash_c`/`L2_timeout_5_bash_c`/`L2_timeout_1m_bash_c`/`L2_watch_bash_c`/`L2_nice_n10_bash_c`/`L2_sudo_env_bash_c`，共 ~10 条）——内层 `rm -rf /` 纯字面量精确化后改判 `reliable:true`，断言从 `{ reliable:false, reason:"shell_forwarder" }` 改为 `{ reliable:true }`（`rm` 提取 `delete /`，hasWrite 不命中 delete 故只断 reliable）。`c3_bash_script_path`/`c4_bash_input_redirect`（脚本路径/stdin 重定向，非 `-c`）不受影响。**验证**：`node --experimental-strip-types test/security-probe.mjs` 全过
- [x] 4.8 更新 `test/cross-system-boundary.mjs` Boundary 2（`sudo bash --posix -c 'rm -rf /'`）断言——纯字面量精确化后从 shell_forwarder 改为 `reliable:true`。**验证**：`node --experimental-strip-types test/cross-system-boundary.mjs` 全过

## 5. 回归验证 + 文档

- [x] 5.1 跑全量测试：`npm test` 全绿（含 1.x-4.x 全部 + 既有 809 测试）。**验证**：`npm test` 退出码 0
- [x] 5.2 跑安全探针：`node --experimental-strip-types test/security-probe.mjs` 全过（确认非纯字面量 shell_forwarder 场景仍拦截）。**验证**：退出码 0
- [x] 5.3 跑 typecheck：`npm run typecheck`（`tsc --noEmit`）通过。**验证**：退出码 0
- [x] 5.4 更新 `docs/security/permission-model.md` 的 Known Limitations——"bash grant 扫裸路径 token 时 `bash -c "cat /etc/passwd"` 不生效"改为"纯字面量已生效；非纯字面量（含变量/控制流）仍不生效"。**验证**：文档文本更新
- [x] 5.5 更新 `docs/security/global-audit-findings.md`——风险 1（不可靠 bash 可持久化授权绕过敏感底线）标记"已由本 change 部分缓解（纯字面量子集）"。**验证**：文档文本更新

## 依赖顺序说明

- 1.x / 2.x 是 RED（先写），独立可并行
- 3.x 是实现（GREEN），依赖 1.x/2.x 全部先存在
- 4.x 是既有测试适配（BREAKING），依赖 3.x 完成（否则会失败）
- 5.x 是回归 + 文档，依赖 4.x 完成

## 关键链 + Project Buffer（critical-buffer 约束，propose 漏项 apply 补）

**关键链**（最紧依赖路径，决定整体工期）：`1.1 RED` → `3.1 isPureLiteralShellArg` → `3.2 递归编排（extractShellCArg + tryExtractLiteralShellC）` → `3.3 集成点（depth 加宽）` → `4.1-4.8 既有测试适配` → `5.1 全量回归`。其中 3.2 是最关键单点（安全性质"≤ 直接执行"的实现载体 + 外层形态限制防丢目标安全洞的决策处）。

**Project buffer**：tier-medium，buffer 比例取表 1 当前 tier 行 ~20%。已消耗 buffer 的主要不确定性（均来自架构 review 返工）：(a) 发现嵌套引号拼接假契约 + security-probe L1/L2 BREAKING 清单遗漏（各返工 spec/tasks/design 一次）；(b) typecheck 暴露 ExtractResult reliable:true 形态不含 rawCommand。剩余 buffer 充裕——3.x 实现任务一次通过，4.x BREAKING 全部按实测结果更新。

**风险字段**：整体**风险 medium**（公共符号 `extractBashTargets` 返回语义变更 + 安全敏感路径，但方向收敛、0 目标回退不放宽）。收尾 review 按 medium 深度（Spec compliance + Code quality + Code consistency 三维度，安全维度查红线）。

## 验证证据（5.x 完成记录）

- **5.1 全量测试**：`npm test` → 940/943 通过，3 fail。3 个失败**非本 change 引入**（基线 git stash 验证）：
  - `SYS7` / `SYS-GRANT`：`EPERM: open '/Users/eliot/.ssh/test-id_rsa'` — 沙箱无法创建 `~/.ssh` 夹具，环境限制
  - `AL7`：并发时序敏感 flaky（单独跑 `pass 1`）
- **5.2 安全探针**：`55 passed, 0 failed`（L1/L2 纯字面量改判 delete / 后全过；脚本路径/stdin 仍 shell_forwarder）
- **5.3 typecheck**：`tsc --noEmit` exit 0
- **literal + BMG 定向**：228 pass / 0 fail
- **5.4 / 5.5 文档**：permission-model.md 第 3 条 Known Limitation + global-audit-findings.md 风险 1 缓解状态 已更新

## caller impact 实测结论（tier-medium 强制实测，步骤 4 闸门）

**触发**：变更点① 公共符号 `extractBashTargets` 返回值语义（纯字面量 `bash -c` 从 `reliable:false` → `reliable:true+targets`）+ ② 行为契约（spec Shell 转发器守卫）。跨分系统（bash 提取层 → 集成层）→ 强制实测。

**caller 清单**（grep 实测 `extractBashTargets` 全部引用）：
| caller | 类型 | 兼容结论 |
|---|---|---|
| `extensions/index.ts:622`（handleBash） | 生产代码 | ✅ 天然兼容——`reliable:true` 时跳过 `!extraction.reliable` 分支（:687-724），走 targets 逐 target 决策（既有逻辑），纯字面量返回标准 targets 无新 shape |
| `extensions/index.ts:627-685`（不可靠 grant 路径 + C5 unread 兜底） | 生产代码 | ✅ 纯字面量不再落入 `!reliable` 分支，grant/兜底逻辑不变；C5 已知边界注释（:635）描述的场景收窄（纯字面量已提取） |
| `test/bash-extract.test.ts`（483 处） | 测试 | ✅ BMG8/9/10/12/12b/14 已更新为提取断言；其余 483 处非 `bash -c` 不受影响 |
| `test/security-probe.mjs:133` | 测试 | ✅ L1/L2 纯字面量已更新（hasDelete /）；c3/c4 脚本路径/stdin 不受影响 |
| `test/cross-system-boundary.mjs:43` | 测试 | ✅ Boundary 2 已更新 |
| `test/probe-v3-bash-symlink-grant.mjs:83` | 测试 | ✅ 测 symlink 目标决策，非纯字面量 `-c`，不受影响 |
| `src/lib/reason-codes.ts`、`control-flow.ts`、`parse.ts`、`scan.ts` | 注释/类型 | ✅ 仅注释引用，无行为依赖 |

**未标注但实测发现的 caller**：无——所有引用均已在 proposal CHANGEPOINTS 清单或上述表中。无超出 scope 的静默 caller。

**结论**：所有 caller 兼容，无需改代码；唯一生产 caller（handleBash）天然兼容。跨分系统边界验证（6.2）全绿：trust/keypoints/grant-memory/reason-codes/audit 全绿 + cross-system-boundary 6/6（含 decideTarget 硬底线）。

## 6.4 实际 vs 预期 对照（current-change audit，tier-medium）

对照 proposal「预期行为模型」逐条实测，**全部符合**：

| 预期输入 | 预期输出 | 实测 | 一致 |
|---|---|---|---|
| `bash -c "cat ~/.ssh/id_rsa"` | `reliable:true [read ~/.ssh/id_rsa]` | ✅ 同（BMG8/test） | ✅ |
| `bash -c "cat $MYSECRETS"` | `reliable:false shell_forwarder` | ✅ 同 | ✅ |
| `bash -c "cat $(echo x)"` | `reliable:false shell_forwarder` | ✅ 同 | ✅ |
| `bash -c "for f in *.ts; do cat $f; done"` | `reliable:false shell_forwarder` | ✅ 同 | ✅ |
| `bash -c "echo hi"` | `reliable:false shell_forwarder`（0目标回退）| ✅ 同 | ✅ |
| `bash -c "cat /etc/passwd > /dev/tcp/..."` | 内层提取 write 目标，决策层硬底线拦 | ✅ 同（cross-system 7.1d decideTarget tier=two）| ✅ |

**实际 vs 预期偏离**：无功能性偏离。**实施增强**（非偏离）：实施中发现并新增"外层限单 fragment 单 stage"安全限制（防丢复合/管道外层其余 stage 目标的安全洞），回写 design D4 + spec 2 scenario + 3 测试——方向更保守、不改变对外契约、使"≤ 直接执行"无反例。**分系统影响评估准确性**：proposal 列的 bash-target-extraction（主）+ access-decision/grant-memory（间接）完整，决策层/trust.ts 确实无需改动（实测确认）。
