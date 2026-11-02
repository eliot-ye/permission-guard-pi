# Design: for-loop-readonly-substitution-exempt

## Context

只读 for 循环统计命令（`for f in openspec/specs/*/spec.md; do n=$(grep -c '^### Requirement:' "$f"); ...; done`）误报 `glob_expansion` 弹窗。根因两层（proposal 已详述，不重述）：

1. `isForBodyReadOnly`（`src/lib/bash-extract/silent.ts:926`）不识别 `VAR=...` 赋值形态——`n=$(grep ...)` 经 `tokenize` 后 `tokens[0]` 是 `n=$(grep`（赋值+替换是单个 token），非合法命令名 → 判 body 非只读 → `isForLoopIterationGlobExempt`（`readonly.ts:306`）失败 → 迭代集 glob 落入 `glob_expansion`。
2. 即使修了赋值层，body 内 `$(grep ...)` 仍触发 `command_substitution`——`SUBSTITUTION_READONLY_CMDS`（`scan.ts:85`）刻意不含 grep/cat/head/tail（`readonly.ts:476-490` 注释：豁免顶层 `$(grep /etc/passwd)` 会成 silent no-op，绕过授权）。

## Goals / Non-Goals

**Goals:**
- 让"for 循环迭代变量驱动的只读统计命令"自动放行，不再误报 `glob_expansion` 或 `command_substitution` 弹窗。
- 保持 fail-closed：只读替换豁免仅限 for-body 迭代变量绑定窄上下文；顶层 `$(grep /etc/passwd)` 仍拒绝。
- 不改变 `ExtractResult` 类型、不改变授权语义放宽、不触碰 policy-core / extension-orchestration / audit。

**Non-Goals:**
- 不把 grep/cat/head/tail 加进 `SUBSTITUTION_READONLY_CMDS` 白名单（顶层读替换仍是安全边界，不全局放宽）。
- 不处理 for 循环体内的 BODY glob（`"$d"/*.md` 仍判 `glob_expansion`，与既有边界一致）。
- 不处理 while/until/if/case 等其他控制流（不在本 change 范围）。

## Decisions

### D1: 赋值形态识别（第一层）

`isForBodyReadOnly`（`silent.ts`）扩展识别 `VAR=...` 赋值。判定规则：

- token 形如 `VAR=...`（`VAR` 为合法变量名，`=` 在 token 内）→ 识别为赋值。
- 赋值右侧（`=` 之后的字符）：
  - **纯字面量**（`n=5`、`s=0`）→ 视为只读。
  - **含 `$()`**（`n=$(grep -c ... "$f")`）→ 调用"for-body 迭代变量绑定替换豁免"（见 D2 的共享函数 `isForBodySubstitutionExempt`），通过才视为只读；否则判非只读。
  - **含其他构造**（未加引号 glob、反引号、子 shell、heredoc）→ 判非只读（fail-closed）。
- 赋值命令本身**不提取任何 target**（赋值是 shell 内部操作，无文件访问副作用——除非右侧替换内部命令有文件访问，那是 D2 的职责）。
- **签名扩展（本 change 新增）**：D2 的 B2/B3 需要迭代变量名、迭代集与 `projectRoot`，而 `isForBodyReadOnly` 现签名仅 `(body: string)`。本 change 将其扩展为 `(body: string, forCtx: ForLoopContext, projectRoot: string)`——`forCtx` 携带迭代变量名与迭代集区间（由调用方解析 for 结构后传入）。两处调用方（`readonly.ts` 的 `isForLoopIterationGlobExempt` 与 `control-flow.ts` 的字面量 for 豁免路径）需同步适配传参。**这是模块级内部函数签名扩展，不改变公共契约签名**（见 proposal caller impact 分析）。

**替代方案考虑**：
- 把 `=` 前缀剥离后按普通命令解析 → 拒绝。因为 `n=$(grep ...)` 剥离后是 `$(grep ...)`，不是合法命令名，且剥离会丢失替换结构信息，无法进行 D2 的绑定判定。直接在赋值 token 上做结构识别更可控。

### D2: for-body 迭代变量绑定替换豁免（第二层）

新增独立判据（不并入 `SUBSTITUTION_READONLY_CMDS` 白名单），在 `scan.ts` 的 `scanUnreliable` 替换检测点触发。判据 B1-B4（对齐 spec「命令替换内只读命令豁免」requirement）：

- **B1 命令只读**：`$()` 内顶层命令名 ∈ `READ_ONLY_COMMANDS`（grep/cat/head/tail/wc/ls/stat 等）∪ `HARMLESS_BUILTINS`。`find` 需通过 find 的参数条件性只读判定（不含写 flag）。
- **B2 路径参数绑定**：`$()` 内所有**文件系统路径参数**必须静态绑定——要么是 for 迭代变量 `"$f"`（`f` 为当前 for 循环迭代变量），要么是项目内字面路径（无 `$`/glob/反引号/`..` 越界）。任一参数含未绑定用户变量、未加引号 glob、非迭代变量的 `$` 引用 → 不豁免。**B2 的实现判据（subagent Issue 5 闭合）**：提取器无命令参数语义表，无法静态区分 pattern 与路径参数（如 `grep '^#.*' "$f"` 的 `'^#.*'` 是 pattern 非路径）。实现按 **fail-closed 方向**处理：对所有非 flag 参数做绑定检查——参数含未绑定 `$` 或未加引号 glob 即拒绝（无论其语义是 pattern 还是路径），参数是迭代变量或项目内字面路径则放行；pattern 含字面量字符（`'^#.*'`）视为字面量放行（不因 pattern 含正则元字符而误拒）。该判据可能误报 pattern 含 `$`/glob 的合法命令（`grep -c "$f" '^$'` 的 `'^$'` 是 pattern 含 `$`），但方向是 fail-closed（不放宽），与本 change「减少误报」目标部分冲突——作为已知权衡记入 Risks，不阻塞。
- **B3 迭代集 bounded**：当前 for 循环迭代集是字面量词集合，或含 glob 但 glob 前缀完全位于 `<projectRoot>` 内（复用 `isBoundedGlobSafe` 条件 2 语义）。
- **B4 无其他副作用构造**：`$()` 内不含输出重定向、管道、`&&`/`;`/`&`、反引号、未引号 heredoc、子 shell（复用既有条件 3 的副作用清单）。

**实现位置与 for 上下文获取**：D2 判定需要知道"当前 `$()` 是否在 for 循环 BODY 内"以及"迭代变量名与迭代集"。`scanUnreliable` 的字符扫描是逐字符线性遍历，本身不带 for 上下文。实现方案：

- **复用既有 for 结构解析（不另写轻量边界扫描）**：`isForLoopIterationGlobExempt`（`readonly.ts:306-474`）已完整解析 for 结构（迭代变量名、迭代集区间、`do`/`done` 边界、引号语义）。本 change 将其解析出的 for 结构提取为共享的 `ForLoopContext`（`{ varName, iterStart, iterEnd, bodyStart, bodyEnd }`），供 `scanUnreliable` 与 `isForBodyReadOnly` 共用——**避免两处独立解析 for 边界/引号语义导致的漂移**（subagent Issue 4）。
- `scanUnreliable` 在替换检测点命中 `$(` 时，调用共享的 for 结构解析函数获取当前 `$()` 是否在 for BODY 区间内 + 迭代变量名；在区间内 → 走 B1-B4。
- **替代方案**：在 `scanUnreliable` 里加一个轻量 for-body 边界栈（扫描到引号外独立 `for` token 时压栈）→ 拒绝。会与 `isForLoopIterationGlobExempt` 的完整 for 解析重复，两处引号/边界处理不一致（行为漂移风险）。复用既有解析更一致。

### D3: 交互顺序

D2 的绑定豁免在 `scanUnreliable` 的替换检测点内判定（与既有白名单豁免同一位置）。判定顺序：

1. `$()` 检测命中 → 先走既有白名单条件 1-4（`basename`/`dirname`/`echo`/`printf`/`pwd`/`test`）。
2. 白名单不满足（如 `grep`/`cat`）→ 检查 for-body 绑定豁免 B1-B4。
3. 两者都不满足 → 回退原 `command_substitution` 判定。

这保证既有白名单语义不变（条件 1-4 优先），绑定豁免是**平行补充分支**，只在白名单外且 for-body 上下文内生效。

### D4: 第一层与第二层的协同

`isForBodyReadOnly`（silent.ts）是条件 3c 的 BODY 只读判定。D1 让它识别赋值形态。赋值右侧含 `$()` 时，D2 的绑定豁免判定**独立于** `isForBodyReadOnly` 内的替换检查——即 `isForBodyReadOnly` 对赋值右侧的 `$()` 调用同一 B1-B4 判定函数。**避免重复实现**：B1-B4 判定函数作为独立纯函数导出（如 `isForBodySubstitutionExempt(cmd, globPos, forCtx, projectRoot)`），`isForBodyReadOnly` 与 `scanUnreliable` 共用。

**共享函数放置点（subagent Issue 3 闭合）**：`isForBodySubstitutionExempt` 放 **`readonly.ts`**（与 `isForLoopIterationGlobExempt`、`isBoundedGlobSafe` 同模块）——利用既有可接受环 `readonly ↔ silent`（2026-10-27 bash-extract-split 已记录），**不新增依赖环**。若放 `scan.ts` 会新增 `silent → scan` 边，叠加既有 `scan → readonly → silent` 形成新环，拒绝。`ForLoopContext` 类型与共享 for 结构解析函数也放 `readonly.ts`（同模块内聚）。

**替代方案考虑**：
- 把 B1-B4 判定逻辑直接内联在 `isForBodyReadOnly` 里 → 拒绝。会与 `scanUnreliable` 的判定重复，两处行为漂移风险。独立导出函数共享是更一致的选择。

### D5: 顶层安全边界

无 for 上下文时（顶层 `$(grep /etc/passwd)`），D2 的 B3 检查"当前无 for 上下文"→ 不满足 → 维持原 `command_substitution` 判定。这保持 `readonly.ts:476-490` 的安全边界：顶层读替换不豁免（silent no-op 绕过授权）。

## Risks / Trade-offs

- **豁免面写太宽**：D2 的 B1-B4 是窄条件，但若 B2 路径绑定判定漏判（如未识别某变量形态为未绑定），可能放行 `$(grep "$f" $OTHER)`。缓解：B2 显式枚举"迭代变量 + 项目内字面路径"两类绑定，其余一律 fail-closed；测试覆盖未绑定变量反例。
- **B2 pattern 含 `$`/glob 的误报权衡（subagent Issue 5）**：B2 对所有非 flag 参数做绑定检查，pattern 含未绑定 `$` 或未加引号 glob（如 `grep -c "$f" '^$'`）会判拒绝——方向 fail-closed（不放宽），与本 change「减少误报」目标部分冲突。作为已知权衡记录：不阻塞，若实测发现高频误报可后续加 pattern 白名单（非本 change 范围）。
- **for 结构解析复用**：共享 for 结构解析（`ForLoopContext`）可能被复杂嵌套 for/引号内的 `for` 干扰。缓解：引号感知（复用既有 `isForLoopIterationGlobExempt` 的引号语义）+ 只识别引号外独立 `for` token；嵌套 for 用栈处理。测试覆盖嵌套 for。
- **性能**：纯静态分析，无运行时性能影响（只减少弹窗，不改提取集）。
- **回归**：既有 700+ 测试中，`command_substitution` 反例（`$(cat /etc/passwd)` 等）必须保持失败——D2 只在 for-body 上下文内放行，不改变顶层行为。测试全绿验证。

## 与既有架构/风格的遵循关系

遵循既有架构：纯函数模块（无 UI/IO）、fail-closed 保守判定、窄条件豁免（对齐既有 `isForLoopIterationGlobExempt` 的窄豁免风格）。不偏离既有架构或风格，无重构。
