## 1. RED — 新增测试

- [x] 1.1 在 test/bash-extract.test.ts 新增 BT-S21..BT-S24 测试：`for x in *.log; do wc -l "$x"; done` → `reliable: true`（BT-S21，空 prefix + 只读 body 自动放行）；`for x in *.log; do rm "$x"; done` → `reliable: false, reason: "glob_expansion"`（BT-S22，写 body 仍拒绝）；`for f in /etc/*.conf; do cat "$f"; done` → `reliable: false, reason: "glob_expansion"`（BT-S23，绝对路径仍拒绝）；`for f in ~/*.conf; do cat "$f"; done` → `reliable: false, reason: "glob_expansion"`（BT-S24，home 路径仍拒绝）。验证：`npx vitest run test/bash-extract.test.ts -t "BT-S2"` 显示 4 个新测试全部失败（RED 阶段预期）。

- [x] 1.2 跑既有 BMG88-96 测试确认当前全部通过（建立回归基线）：`npx vitest run test/bash-extract.test.ts -t "BMG" --reporter=verbose`，记录通过数。验证：输出 `BMG88`..`BMG96` 全部 PASS，无失败。

## 2. GREEN — 实现空 prefix 放宽

- [x] 2.1 在 src/lib/bash-extract.ts 的 `isForLoopIterationGlobExempt` 函数内（约 line 605-608 处，现有代码 `const prefix = cmd.slice(tokenStart, globPos); if (!isBoundedPrefix(prefix, projectRoot)) return false; return true;`）插入空 prefix 分支：当 `prefix === ""` 时 `return true`（空 prefix 意味着 tokenStart === globPos，cmd[tokenStart] 必然是 glob 元字符本身，不会是 `/`/`~`/`C:`——绝对路径走非空 prefix 分支由 isBoundedPrefix 拒绝）。同时放宽 `isGlobForLoopExempt`（line 2532）的 `globPrefixes.every` 检查，使空 prefix 在 scanControlFlow 路径也通过。保持非空 prefix 走原有 `isBoundedPrefix` 判定不变。不改 `isBoundedPrefix` 函数本身、不改 `isBoundedGlobSafe`、不改非 for-loop 路径。验证：`npm test` 显示新增 BT-S21..BT-S25 全部通过；既有 BMG88-96 全部仍通过（回归不变）。

**实施记录**：tasks.md 写于 RED 阶段，原计划"检查 cmd[tokenStart] 三重拒绝"。实施发现该三重检查是死代码（tokenStart === globPos 时 cmd[tokenStart] 必然是 glob 元字符，不会是 `/`/`~`/`C:`），绝对路径实际走非空 prefix 分支由 isBoundedPrefix 拒绝。已删除死代码并更新 design.md D1/D2 反映实际实现。BT-S25（Windows 盘符）补测覆盖该路径。

## 3. BASH_GUARDRAILS 文案同步

- [x] 3.1 在 extensions/index.ts 的 BASH_GUARDRAILS Layer 2（约 line 348-350 处的 "In-project read-only glob (auto-allowed)" 条目）追加 `for x in *.log; do wc -l "$x"; done` 为静默示例（保持与既有示例 `ls openspec/*`、`find . -name '*.ts'` 等并列的格式）。验证：`grep -n "for x in \*\.log; do wc" extensions/index.ts` 返回 1 行命中，位置在 Layer 2 区段内（line 348-355 之间）。

- [x] 3.2 修改 extensions/index.ts 的 BASH_GUARDRAILS Layer 3（约 line 364-365 处）的 "Control-flow as standalone tokens" 条目，把 `(esp. for x in *.log; do ...)` 限定为"写 body 或非相对 prefix 的 for-loop"——具体改为 `Control-flow as standalone tokens: while, for, until, if, case (esp. for x in /etc/*.conf; do ... with absolute prefix, or for x in *.log; do rm "$x"; done with write body) → replace with grep/find/rg for read-only relative-prefix loops`。验证：`grep -n "for x in \*\.log" extensions/index.ts` 返回的行里，Layer 3 区段（line 355-382）内的命中必须含 "write body" 或 "absolute prefix" 限定词；Layer 2 区段内的命中无该限定词。

## 4. 全文档回归与提交

> **工作树范围说明**：`openspec/specs/permission-config/spec.md` 在本 change 的 working tree 中显示为 modified，但**不属本 change**。该修改来自 a5 reverse-spec（permission-config baseline 刷新），是独立的后续工作，应在 a5 propose/archive 时单独处理。本 change 的提交范围仅限 `src/lib/bash-extract.ts`、`extensions/index.ts`、`test/bash-extract.test.ts`、`openspec/changes/bash-bounded-glob-readonly-silent/` 和 `openspec/todo.md`。

- [x] 4.1 跑全量测试套件确认无回归：`npm test`（或 `npx vitest run`）。验证：退出码 0，全部测试通过（包括新增 BT-S21..BT-S25、既有 BMG88-96、以及其他所有测试）。

- [x] 4.2 校验 openspec 变更集结构完整：`npx openspec validate bash-bounded-glob-readonly-silent --strict`。验证：退出码 0，输出无 ERROR（INFO 警告可接受）。

- [x] 4.3 回写 openspec/todo.md 的 b1 条目（line 13-15）措辞以反映实测校准：把"文案与实际不符"改为"实测一致；诉求是改行为收窄判定（空 prefix 相对 for-loop glob）+ 同步文案挪到 Layer 2"，并在该条目下追加 change 子项引用本 change 名 `bash-bounded-glob-readonly-silent`。**不勾选主条目**（勾选是 td-archive 的职责）。验证：`grep -n "bash-bounded-glob-readonly-silent" openspec/todo.md` 返回 1 行；`grep -n "\[x\].*静默 bash 只读循环" openspec/todo.md` 返回 0 行（主条目未勾选）。

## 关键链（Critical Chain）

T1.1（RED）→ T2.1（GREEN）→ T3.1 → T3.2 → T4.1（全量回归）。

关键链总估时：T1.1 (~10min) + T2.1 (~15min) + T3.1 (~3min) + T3.2 (~3min) + T4.1 (~5min) = **~36min**。

T1.2（回归基线）、T4.2（validate）、T4.3（todo 回写）为非关键链任务，可并行或穿插执行。

## Project Buffer

按 tier-medium 比例（35%）计算：36min × 35% = **~13min**。Buffer 留在 T2.1（实现）上——空 prefix 分支的 tokenStart 边界判断可能需要微调（如迭代词含空格、引号包裹 glob 等边界情形），若 RED 阶段发现的边界情形超出预期，先调整 design.md 的 D1/D2 再实施。

## Task 主体约束（合规声明）

所有 7 个 task 的主体均为 agent 可编程性执行的动作（写代码 / 改配置 / 跑测试 / 跑 CLI / 改 todo.md）。**无**非编程性动作（人工目测、用户验收、第三方审批）作为独立 task。验证字段均为可执行的 CLI 命令或可观察的文件状态（grep 命中、退出码），不依赖人工判断。

## 与 design.md 的一致性

- D1（放宽点放在 `isForLoopIterationGlobExempt` 内部）→ T2.1
- D2（不放宽绝对路径标志）→ T2.1 的 `/`、`~`、`[A-Za-z]:[\\/]` 检查
- D3（不放宽 BODY 内 glob）→ 无对应 task（设计决策，无实施动作）
- D4（BASH_GUARDRAILS 文案同步）→ T3.1 + T3.2
- D5（测试策略 RED-GREEN-REFACTOR）→ T1.1（RED）+ T2.1（GREEN）
