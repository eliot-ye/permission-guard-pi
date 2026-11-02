# Tasks: for-loop-readonly-substitution-exempt

> 关键链标注：T1 → T2 → T3 → T4 → T5（TDD 红→实现→协同→测试绿→验证，串行关键路径）。
> project buffer：关键链总估时 × 35%（tier-medium，表 1 critical-buffer 行）。

## 1. TDD 红：写失败测试（正反例）

- [x] 1.1 在 `test/bash-extract.test.ts` 新增正例测试：`for f in openspec/specs/*/spec.md; do n=$(grep -c '^### Requirement:' "$f"); echo "$n"; done`（projectRoot 内）→ `reliable: true`；及 `for f in openspec/specs/*/spec.md; do n=5; echo "$n"; done` → `reliable: true`。当前实现失败（RED），预期为 `glob_expansion`。
  - 验证：`node --experimental-strip-types --test --test-name-pattern "BT-FSUB" test/bash-extract.test.ts` 初始 RED——BT-FSUB-1/2/3 失败（`glob_expansion`），反例 6 个通过
- [x] 1.2 新增反例测试（fail-closed，必须保持失败/拒绝）——**用字面量迭代集**（`for f in a b c`）而非 glob 迭代集，因为 glob 迭代集的 glob 分支会在 `$()` 之前拦截（reason 为 glob_expansion），测试不到 B1-B4；字面量迭代集让 `$()` 分支真正执行，能测 B1-B4 判据（实证 V1-V4）：
  - `for f in a b c; do n=$(rm "$f"); echo "$n"; done` → `reliable: false, reason: "command_substitution"`（B1 写命令不满足）
  - `for f in a b c; do n=$(grep -c '^###' "$f" /etc/passwd); echo "$n"; done` → `reliable: false, reason: "command_substitution"`（B2 非绑定路径）
  - `for f in a b c; do n=$(grep -c '^###' "$f" $OTHER); echo "$n"; done` → `reliable: false, reason: "command_substitution"`（B2 未绑定变量）
  - `for f in /etc/passwd /etc/shadow; do n=$(grep -c '^#' "$f"); echo "$n"; done` → `reliable: false, reason: "command_substitution"`（B3 迭代集出界，用绝对路径字面量迭代）
  - `echo "$(grep -c '^#' /etc/passwd)"`（无 for 上下文）→ `reliable: false, reason: "command_substitution"`（顶层安全边界不变）
  - 验证：以上反例在 RED 阶段已全部判 `command_substitution`（当前实现已满足，回归保护——反例不被本 change 放行）

## 2. 第一层实现：赋值形态识别

- [x] 2.1 `isForBodyReadOnly`（`src/lib/bash-extract/silent.ts`）扩展识别 `VAR=...` 赋值形态——token 形如 `VAR=...`（合法变量名 + `=`）：右侧纯字面量（`n=5`）→ 只读；右侧含 `$()` → 调共享 B1-B4 判定（见任务 3.1），通过才只读；右侧含其他构造（glob/反引号/子 shell/heredoc）→ 非只读（fail-closed）。**签名扩展**：`(body: string)` → `(body: string, forCtx?: ForLoopContext | null, projectRoot?: string)`——`forCtx` 携带迭代变量名与迭代集 bounded 状态（调用方解析 for 结构后传入），三处调用方（`readonly.ts` + `control-flow.ts` ×2）同步适配。**实现说明**：签名参数设为可选（`?`）保持向后兼容——既有调用方不传时沿用原字面量行为（纯字面量赋值仍只读，无 for 上下文的 `$(...)` 不豁免），模块级内部函数不改变公共契约签名
  - 验证：`node --experimental-strip-types --test --test-name-pattern "BT-FSUB" test/bash-extract.test.ts` 中 BT-FSUB-1/2/3 转绿（赋值识别 + for 上下文传入后正例生效）；`npx tsc --noEmit` 通过
- [x] 2.2 赋值命令本身不提取任何 target（纯 shell 内部操作，无文件访问副作用）；若赋值右侧替换内部命令含文件访问（如 `$(grep "$f")`），由正常提取流程处理（`$f` 迭代变量在字面量迭代集内时视为已解析）
  - 验证：BT-FSUB-1 提取结果 `reliable: true`，targets 无异常（赋值命令不产生 target）

## 3. 第二层实现：for-body 迭代变量绑定豁免

- [x] 3.1 独立纯函数导出 `isForBodySubstitutionExempt`（B1-B4 判据，放 `readonly.ts`——利用既有可接受环 `readonly ↔ silent`，不新增依赖环）：B1 命令只读（`$()` 内顶层命令 ∈ READ_ONLY_COMMANDS ∪ HARMLESS_BUILTINS，`find` 走 find 参数条件性只读判定）；B2 路径参数绑定（`"$f"` 迭代变量或项目内字面路径，无未绑定变量/glob/`..`；对所有非 flag 参数做绑定检查，pattern 含 `$`/glob 按 fail-closed 拒绝）；B3 迭代集 bounded（字面量或 glob 前缀在 projectRoot 内）；B4 无副作用构造（重定向/管道/`&&`/`;`/`&`/反引号/heredoc/子 shell）
  - 验证：B1-B4 判据正反例矩阵 10/10 通过（grep/cat 绑定豁免、rm/curl 拒绝、/etc/passwd 非绑定拒绝、$OTHER 未绑定拒绝、迭代集出界拒绝、无 for 上下文拒绝、重定向/管道拒绝）——`.tmp-b1b4.mjs` 探针全过
- [x] 3.2 `scan.ts` `scanUnreliable` 集成：复用共享 for 结构解析（`ForLoopContext`，提取自 `isForLoopIterationGlobExempt` 既有解析，不另写轻量边界栈）；替换检测点命中 `$(` 且当前 `$()` 在 for BODY 区间内 → 走 B1-B4；否则维持既有白名单条件 1-4 判定
  - 验证：反例 `echo "$(cat /etc/passwd)"`（无 for 上下文）仍 `command_substitution`；`echo "$(basename $f)"` 白名单优先。**实现说明**：for 上下文用 `parseGlobForLoop`（control-flow.ts，新增 `doPos`/`doneStart`/`iterWords` 返回字段，向后兼容）判定 `$()` 是否在 body 区间内——比另写轻量边界栈更复用既有解析

## 4. 协同：isForBodyReadOnly 与 scanUnreliable 共用判定

- [x] 4.1 确认 `isForBodyReadOnly`（silent.ts）与 `scanUnreliable`（scan.ts）共用同一 `isForBodySubstitutionExempt` 实现（从共享模块导入，不重复内联）；`for` 迭代集 glob 豁免（`isForLoopIterationGlobExempt`，readonly.ts）与 D2 的 B3 复用同一 bounded 判定
  - 验证：`grep -rn "isForBodySubstitutionExempt" src/` 显示 silent.ts 与 scan.ts 均从 readonly.ts 导入同一导出（不重复内联）；`findForBodyCtx`（scan.ts）与 `isForLoopIterationGlobExempt`（readonly.ts）共用 `parseGlobForLoop` 的 `iterWords`/`globPrefixes` bounded 判定

## 5. 测试绿 + 回归

- [x] 5.1 全部新增正反例测试转绿（任务 1 的用例），`node --experimental-strip-types --test test/bash-extract.test.ts` 通过
  - 验证：BT-FSUB-1..12 全绿（12/12），bash-extract 全量 574/574 绿
- [x] 5.2 全量回归：项目定义的 `node --test "test/*.test.ts" "extensions/*.test.ts"` 全部通过（920/920，含 `command_substitution` 反例如 `$(cat /etc/passwd)` 保持失败）
  - 验证：`node --test "test/*.test.ts" "extensions/*.test.ts"` → 920/920 pass；`npx tsc --noEmit` 通过

## 6. 验证

- [x] 6.1 `openspec validate for-loop-readonly-substitution-exempt --type change --json` 无 ERROR
  - 验证：`valid: True`，0 issues
- [x] 6.2 系统级验证：用实际用户命令形态跑 `extractBashTargets`（真实 projectRoot），确认 `reliable: true`；用顶层 `$(grep /etc/passwd)` 确认仍 `reliable: false, reason: "command_substitution"`（安全边界不破）
  - 验证：完整用户命令（`&&` 链 + for + 赋值 $(grep) + $(basename $(dirname))）→ `reliable: true`；顶层 `$(grep /etc/passwd)`、`$(cat /etc/passwd)`、for 写 body、glob 出界均保持拒绝。**实现说明**：系统级验证暴露既有 off-by-one（`done` 后有尾随 `&&` 时 `parseGlobForLoop`/`isLiteralForLoop` 的 `doneEnd` 偏 +1，body 多含 `done` 首字符）——已修复（`doneEnd = i` 统一语义），固化 BT-FSUB-10；另修复双引号内 for-body 绑定 `$()` 语义缺口（引号内外 B1-B4 一致），固化 BT-FSUB-11/12

## 7. 收尾 review（6.3）

- [x] 7.1 change 级收尾 code review（subagent 隔离评审，MUST_FIX_CRITICAL → 修复后 APPROVED）：
  - **Issue 1（critical，已修）**：`isForBodySubstitutionExempt` B2 的 `..` 越界逃逸——路径绑定检查仅当 `looksLikePath(arg)` 为 true 时调用 bounded 检查，`x/../../etc/passwd`（不以 `/`、`~`、`./`、`../` 开头且无点扩展名 → looksLikePath=false）会跳过 bounded 检查导致逃逸（静默读 /etc/passwd）。修复：B2 无条件检查 `hasDotDotSegment(arg)`（fail-closed，不因 looksLikePath 门控漏判）。固化 BT-FSUB-13。
  - **Issue 2（warning，已修）**：B2 反例测试缺口——未覆盖 `..` 越界形态。修复：新增 BT-FSUB-13（字面量迭代集 + `x/../../etc/passwd` → `reliable: false, reason: "command_substitution"`）。
  - **Issue 3（nit，已修）**：字面量迭代路径与 glob 迭代路径的 body 赋值变量处理不一致——字面量豁免路径（`isLiteralForLoop` 调用 `isForBodyReadOnly(body)`）未传 for 上下文，导致字面量迭代 + `$(grep "$f")` 绑定形态判 `control_flow`（与 glob 路径不一致，fail-closed 仍拒绝但属 design D1「两处调用方同步适配」未完全落实）。修复：`isLiteralForLoop` 加 `projectRoot?` 参数，字面量词 `isBoundedPrefix` 判定后构造 forCtx 传 `isForBodyReadOnly`；`scanControlFlow` 两处调用传 `projectRoot`；字面量豁免分支推送 `collectBodyAssignments(body)`。
  - 验证：BT-FSUB-1..13 全绿（13/13）；`node --test "test/*.test.ts" "extensions/*.test.ts"` → 921/921 pass（3 次重跑稳定）；`npx tsc --noEmit` 通过；`openspec validate` → `valid: True`。
  - **说明**：全量回归偶发出现一次 `audit.test.ts` AL7（`actual:82 expected:100`）失败，已确认与本 change 无因果——`audit.test.ts` 无 bash-extract import，该测试是审计日志并发刷盘 + `setTimeout(100ms)` 的既有时序竞态；本 change 只改 `src/lib/bash-extract/*`。3 次全量重跑全绿，非本 change 引入。
