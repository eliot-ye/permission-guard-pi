# Limited Scope: Fix glob_expansion false-positive for for-loop iteration sets

## Why

`isBoundedGlobSafe` misclassifies for-loop iteration-set globs as unreliable.

**Scenario**: `for d in openspec/specs/*/; do echo "=== $d ==="; ls "$d"; done`

The glob `openspec/specs/*/` is bounded-safe: its prefix resolves inside projectRoot, and the loop body only runs read-only commands (`echo`, `ls`). But `isBoundedGlobSafe` fails because:

1. The fragment's first command name is `for` (not `ls`)
2. `for` is not in READ_ONLY_COMMANDS
3. The glob check inside `isBoundedGlobSafe` requires the stage command to be read-only
4. `scanUnreliable` returns `"glob_expansion"` before `scanControlFlow` (which has Change 2's for-loop exemption) ever runs

**Impact**: Any for loop that iterates over project-internal glob patterns triggers a tier=two permission prompt, even when the loop body is purely read-only. This is a high-frequency pattern in AI-assisted development (listing files in spec/change directories, iterating over archive entries, etc.).

**Preceding changes**: Change 1 (`bounded-glob-compound-separators`) fixed compound-separator handling in `isBoundedGlobSafe`. Change 2 (`expand-reliable-classification`) added for-loop iteration exemption in `scanControlFlow`. This change closes the gap where Change 2's exemption is unreachable because `scanUnreliable` (which calls `isBoundedGlobSafe`) fires first.

**Depends on `bash-stage-a-security-fixes` (must apply first)**: This change reuses `isForBodyReadOnly` from Change 2. The Stage A security fix (`bash-stage-a-security-fixes`) modifies `isForBodyReadOnly` internally to use `isReadOnlyWithArgs` (so `find -name` inside a for-loop body is still recognized as read-only after `find` is removed from `READ_ONLY_COMMANDS`). Apply `bash-stage-a-security-fixes` BEFORE this change — the D2 "Reuse `isForBodyReadOnly`" decision depends on the Stage A internal change being in place. Parallel apply is safe (the touched lines don't overlap), but sequential is preferred for a clean audit trail.

## What Changes

**Modified capability: `bash-target-extraction`**

MODIFIED "bounded-glob safe context" — when a for loop's iteration set contains a glob metacharacter and the loop body consists only of read-only commands, the glob MUST be classified as bounded-safe (the loop variable is passed to read-only commands, so the actual file access set is statically determinable).

## Design Decisions

- **D1**: Fix in `isBoundedGlobSafe` (not in `scanUnreliable`): the glob safety check belongs in the function that evaluates glob safety, not the scanner that triggers it.
- **D2**: Reuse `isForBodyReadOnly` from Change 2: the body-read-only check is the same predicate used by `isLiteralForLoop`. Extract into a shared helper or import directly.
- **D3**: Only apply when `stageCmd` is `for`: this is a targeted fix. Other command names in the stage are already handled by the existing READ_ONLY_COMMANDS check.
- **D4**: Iteration-set glob prefix must still pass `isBoundedPrefix`: the prefix (e.g., `openspec/specs/`) must resolve inside projectRoot. This is the same check as for command-argument globs.
- **D5**: No new reason value: the fix only reduces `glob_expansion` false-positives. No new reason string is added.

## Capabilities

### Modified Capabilities

- `bash-target-extraction`:
  - MODIFIED "bounded-glob safe context" — for-loop iteration-set globs with read-only bodies are bounded-safe

## Impact

**Modified code**

- `src/lib/bash-extract.ts`:
  - `isBoundedGlobSafe`: when `stageCmd` is `for`, parse the loop and check if body is read-only; if so, allow the glob
  - Potentially extract `isForBodyReadOnly` to a shared location if it's currently inside `isLiteralForLoop`

**Not modified**

- `extractBashTargets` main flow, `scanUnreliable`, `scanControlFlow`, `isLiteralForLoop`
- `decide.ts`, `trust.ts`, `config.ts`, `audit.ts`, `sensitive.ts`, `path-utils.ts`, `extensions/index.ts`
- Return shape and reason values unchanged

## 实际 vs 预期复盘

### 影响分系统

- **预期**：仅 `bash-target-extraction`（`src/lib/bash-extract.ts`）
- **实际**：`bash-target-extraction`（`src/lib/bash-extract.ts`）+ `bash-extract.test.ts`（测试）+ `security-probe.mjs`（安全回归）+ 主 spec delta（`specs/bash-target-extraction/spec.md`）。未触及 `decide.ts`/`trust.ts`/`config.ts`/`audit.ts`/`sensitive.ts`/`path-utils.ts`/`extensions/index.ts`。

### 整体性能预期变化

- **预期**：不变（仅在 for-loop 分支增加一次 for-loop 结构解析 + `isForBodyReadOnly` 调用，非常规命令路径无额外开销）
- **实际**：常规命令路径零开销（`stageCmd === "for"` 时才触发解析）。for-loop 路径新增一次 `parseGlobForLoop` 解析 + `isForBodyReadOnly` 调用，与 `isLiteralForLoop` 的解析成本同级（均为线性扫描），无感知影响。321 测试总耗时 715ms，与变更前 686ms 相比增加 ~39ms（主要是新增 9 条测试的开销）。

### 局部优化还是全局协调

- **预期**：局部优化（修复 `isBoundedGlobSafe` 对 for-loop 的分类错误）
- **实际**：局部优化。但修复路径与 proposal D1 有偏差：实际修复在 `scanUnreliable` + `scanControlFlow` 两个函数，而非 proposal D1 所述的 `isBoundedGlobSafe`。根因是 `splitCommands` 在 `;` 处拆分 for-loop，`isBoundedGlobSafe` 看不到完整 for-loop 结构。这是一个 proposal 阶段未预见到的架构约束。

### 局部优化的实际全局影响

- 主基调第 1 条事后回检：该修复不影响全局不变量。`scanControlFlow` 签名变更（新增 `projectRoot?` 可选参数）是唯一全局可见变更，但不影响任何现有调用点（只有 `extractBashTargets` 一处调用，已同步更新）。`isLiteralForLoop` 和 `isForBodyReadOnly` 未修改。`isBoundedGlobSafe` 未修改（修复走了 `scanUnreliable` 层面，不动原函数）。安全探针 12/12 通过，无安全回归。

### 模型验证

- **预期行为模型**：for-loop 迭代集 glob + read-only body + 项目内前缀 → reliable；反例（前缀出界 / body 写操作 / body 含 glob / 结构不完整）→ unreliable
- **模型验证结果**：模型成立。9 条测试覆盖 5 条 reliable 正例 + 4 条 unreliable 反例，全部符合预期。用户原始命令 `for d in openspec/specs/*/; do echo "=== $d ==="; ls "$d"; done` 返回 `{ reliable: true, targets: [] }`。

### 预期之外的副作用

- **架构偏差**（非副作用，但需记录为后续 audit 输入）：proposal D1 说"fix in `isBoundedGlobSafe`"，实际修复在 `scanUnreliable` + `scanControlFlow`。根因是 `splitCommands` 拆分 for-loop 的架构约束。这说明 proposal 阶段对 `isBoundedGlobSafe` 的 `splitCommands` 依赖理解不足——`isBoundedGlobSafe` 看到是拆分后的 fragment，不是完整 cmd。后续 change 如涉及 for-loop 解析，需注意此架构约束。
- **scanControlFlow 签名变更**：新增 `projectRoot?` 可选参数。当前只有一个调用点，无兼容性问题，但如果未来有其他调用点需注意传参。

### scenario→test 覆盖账本

| Scenario | Test ID | 状态 |
|---|---|---|
| for-loop 迭代集 glob + ls body → reliable | BMG88 | ✅ 通过 |
| for-loop 迭代集 glob 前缀出界 → unreliable | BMG89 | ✅ 通过 |
| for-loop 迭代集 glob + rm body → unreliable | BMG90 | ✅ 通过 |
| for-loop 迭代集 glob + cat body → reliable | BMG91 | ✅ 通过 |
| for-loop 迭代集 glob + echo body → reliable | BMG92 | ✅ 通过 |
| for-loop 迭代集 glob + 多命令 body → reliable | BMG93 | ✅ 通过 |
| for-loop 迭代集 glob + body 含 glob → unreliable | BMG94 | ✅ 通过 |
| for-loop 结构不完整 → unreliable | BMG95 | ✅ 通过 |
| for-loop 字面量迭代集 → 走另一条路径 | BMG96 | ✅ 通过 |

全绿，无 N/A 条目。

### security-probe 回归

12/12 通过，无安全回归。

