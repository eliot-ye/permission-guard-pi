# Design — bash-extract-split

## 设计决策概览

本 change 由三个正交子决策组成，实现顺序**必须**按 `D0 → D3 → D1+D2` 顺序推进（D0 是决策前置，D3 是拆分粒度判定的实际执行点）：

- **D0**：拆分前置事实（现状分析、内部层次判据、拆分策略）
- **D3**：`td-reverse-spec` 定向刷新（拆分粒度最终判定的实际执行点）
- **D1**：代码拆分 + import 路径迁移（D3 输出后的机械动作）
- **D2**：`profile-tier.yaml` 子系统归属更新（可与 D1 并行）
- **D4**：集成验证（拆分正确性回归）

**核心约束**：`bash-target-extraction/spec.md` 完全不动；403 个既有测试零修改。这是纯组织层重构，行为契约**必须** bit-for-bit 保持。

## D0：拆分前置事实

### 现状

`src/lib/bash-extract.ts` 当前状态：

- **3421 行**，**86 个 top-level declaration**（`function` + `const` 顶层符号）
- **29 个 spec requirement** 覆盖（`openspec/specs/bash-target-extraction/spec.md`）
- **15+ 大类命令分类常量表**（`READ_ONLY_COMMANDS` / `SILENT_COMMANDS` / `UNRELIABLE_COMMANDS` / `FORWARDING_COMMANDS` / `SUBSTITUTION_READONLY_CMDS` / `GIT_BLOB_OK_SUBCOMMANDS` / `NPM_RUN_OK_SCRIPTS` / `TSC_ENTRY_FLAGS` / `NPX_FLAG_*` / `CONTROL_FLOW_KEYWORDS` / `SHELL_NAMES` / `SHELL_WRAPPER_NAMES` / `HARMLESS_BUILTINS` / `COMMAND_TABLE` 等）
- **对外导出 13 个符号**（12 function/const + 1 type）；`isDevSocketOrFd` 被 `decision.ts` 消费；`extractBashTargets` / `tokenizeBashCommand` / `looksLikePathToken` / `ExtractResult` 被 `extensions/index.ts` 消费；其余 8 个符号被 `test/bash-extract.test.ts` 内部直接消费（403 用例）
- **依赖图**：`extractBashTargets` 的传递闭包 = **全部 86 个 decl**（强连通图，153 个循环）；按调用依赖拆分必产生大量循环 → **拆分必须按语义域而非按调用图**

### 内部层次判据

`bash-extract.ts` 里可识别的语义层：

1. **解析层**：tokenize / splitCommands / splitPipelines / extractRedirects / 变量展开（`SAFE_VARS` / `expandSafeVariables`）
2. **不可靠扫描层**：`scanUnreliable` 与子扫描器（引号感知、`$`/反引号/process-sub/heredoc/glob/unresolved-var）
3. **控制流扫描层**：`scanControlFlow`（while/for/until/if/case）+ for-loop 豁免（`isLiteralForLoop` / `isGlobForLoopExempt` / `isForBodyReadOnly`）
4. **Shell forwarder 层**：`isShellForwarder` / `isShellForwarderTokenStream` / `skipWrapperTokens` / `scanCdChdir`
5. **转发器守卫层**：`FORWARDING_COMMANDS` / `isForwarderDownstreamExempt` / `isForwarderStageSafe`
6. **有界 glob 层**：`isBoundedGlobSafe` / `isBoundedPrefix` / `isForLoopIterationGlobExempt`
7. **只读命令层**：`READ_ONLY_COMMANDS` / `FIND_WRITE_FLAGS` / `isFindReadOnly` / `isReadOnlyWithArgs`
8. **静默命令层**：`SILENT_COMMANDS` / `SILENT_ALLOW_ALL` / `isSilentCommand` / `isSilentTsc` / `isSilentGo` / `isSilentNpx` 及 dev-tool 只读子命令判定
9. **命令替换只读层**：`SUBSTITUTION_READONLY_CMDS` / `isSubstitutionReadOnlyAt`
10. **命令目标提取层**：`COMMAND_TABLE` + 15 个 `*Extract` 函数（`rmExtract` / `cpExtract` / `mvExtract` / `readExtract` / `teeExtract` / `mkdirExtract` / `touchExtract` / `testExtract` / `lnExtract` / `metaExtract` / `truncateExtract` / `ddExtract` / `curlExtract` / `wgetExtract` / `installExtract` / `findExtract`）
11. **入口编排层**：`extractBashTargets` 主函数

### 拆分策略

**按语义域**（非按调用图）拆分——11 个语义层聚合成 **8 个文件**（部分层次耦合紧密、共享私有辅助函数，合并到一个文件避免过度碎片化）：

- `index.ts`（barrel）：重导出对外 13 个符号，不新增行为
- `entry.ts`：入口编排（第 11 层）
- `parse.ts`：解析层（第 1 层）
- `scan.ts`：不可靠扫描层（第 2 层）
- `readonly.ts`：只读命令层 + 有界 glob 层（第 6 + 第 7 层；两者共享 `READ_ONLY_COMMANDS` 与 `isReadOnlyWithArgs` 的判定入口）
- `silent.ts`：静默命令层 + 命令替换只读层（第 8 + 第 9 层；两者共享 `isReadOnlyWithArgs` 与 dev-tool 只读子命令语义）
- `extractors.ts`：命令目标提取层（第 10 层，含 `COMMAND_TABLE`）
- `control-flow.ts`：控制流扫描层（第 3 层）
- `shell-forwarder.ts`：shell forwarder 层 + 转发器守卫层 + `cd_chdir` 检测（第 4 + 第 5 层；shell forwarder 与 forwarder 守卫共享"引号感知 stage 检测"底层逻辑）

**说明**：`scanFindWriteFlags` 归入 `control-flow.ts`（与 `scanControlFlow` 同为 pre-check 扫描器）；`findExtract` 归入 `extractors.ts`（虽 `isFindReadOnly` 在 `readonly.ts`，但 `findExtract` 本身是 extractor）。

## D3：`td-reverse-spec` 定向刷新

**位置**：本 change apply 的第一步（在拆代码前）。

**理由**：`bash-target-extraction/spec.md` 29 requirement 与 `bash-extract.ts` 86 个 decl 之间的**映射关系**未在 spec 中显式记录——spec 只写行为契约，不写代码组织。当前"11 个语义层 → 8 个文件"是 proposal 阶段的可读性判断，未基于 requirement 与代码的严格映射。`td-reverse-spec` 定向刷新的作用：

1. 建立 requirement → decl 的映射（29 requirement 各覆盖哪些 decl）
2. 判定每个语义层的**独立演进频率**（哪些层经常被同一 change 修改，应合并；哪些层几乎独立演进，应拆分）
3. 最终确定拆分粒度——可能维持 8 文件，也可能调整到 6–10 文件（延迟决策）

**执行**：apply 阶段第一步是 `td-reverse-spec` 命令，输出**定向刷新后的 spec**（若发现 spec 与代码有不一致）+ **拆分粒度最终判定**（写入本 design.md 的 D1 "最终文件列表"小节）。

**降级**：若 `td-reverse-spec` 未发现问题且拆分粒度维持 D0 建议，D1 直接按 8 文件执行。

## D1：代码拆分 + import 路径迁移

### 前置（D3 输出）

`td-reverse-spec` 完成后，本 design.md 的 D1 "最终文件列表"由 D3 结果确定（可能维持 D0 建议的 8 文件，也可能调整）。

### 拆分步骤

1. **创建目录**：`mkdir -p src/lib/bash-extract`
2. **拆分文件**：按 D0 语义域划分，把 `bash-extract.ts` 内容按依赖层次拆分到 8 个子文件
3. **barrel 重导出**：`src/lib/bash-extract/index.ts` 从各子文件 import 并 `export` 13 个对外符号
4. **删除原文件**：`git rm src/lib/bash-extract.ts`
5. **迁移 import 路径**（4 处 caller）：
   - `extensions/index.ts:43`：`from "../src/lib/bash-extract.ts"` → `from "../src/lib/bash-extract/index.ts"`
   - `src/lib/decision.ts:19`：`from "./bash-extract.ts"` → `from "./bash-extract/index.ts"`
   - `test/bash-extract.test.ts:29,30,1046,1840`：`from "../src/lib/bash-extract.ts"` → `from "../src/lib/bash-extract/index.ts"`（4 处 import 语句，符号完全不变）

### 拆分约束

- **零循环依赖**：拆分后 8 个文件两两无循环 import（`npm run typecheck` 会检测）
- **对外 API 契约不变**：`index.ts` 的 export 集合与拆分前 `bash-extract.ts` 完全一致（13 个符号，签名/类型/行为不变）
- **测试零修改**：403 个 `test/bash-extract.test.ts` 用例文本**完全不变**（只改 import 路径 4 处），全部 GREEN 作为拆分正确性回归网
- **spec 零修改**：`openspec/specs/bash-target-extraction/spec.md` git diff 空

### 最终文件列表（D3 内部层次判读结论）

D3 定向刷新确认 D0 建议的 **8 文件拆分**有效。29 requirement → 8 文件映射如下（无遗漏、无重复）：

| # | 文件 | 承载 requirements | 承载 decl（含私有辅助） |
|---|---|---|---|
| 1 | `parse.ts` | —（基础设施） | `tokenize`, `splitCommands`, `splitPipelines`, `extractRedirects`, `looksLikePath`, `looksLikePathToken`, `expandSafeVariables`, `findUnresolvedVariable`, `SAFE_VARS`, `INERT_SPECIAL_PARAMS`, `ExtractAction` 类型 |
| 2 | `readonly.ts` | R7（相对路径规范化）, R16（有界 glob）, R17（设备重定向）, R20（find 写操作 flag 基础） | `READ_ONLY_COMMANDS`, `FIND_WRITE_FLAGS`, `isFindReadOnly`, `isReadOnlyWithArgs`, `isBoundedGlobSafe`, `isBoundedPrefix`, `hasDotDotSegment`, `isDevSocketOrFd`, `isForLoopIterationGlobExempt` |
| 3 | `scan.ts` | R5（变量展开与展开失败）, R6（复杂语法不可靠）, R12（命令替换在引号内）, R15（Shell 内置变量白名单）, R18（引号定界 heredoc）, R26（命令替换内只读命令豁免） | `scanUnreliable`, `parseHeredocDelimiter`, `getStageCommandName`, `SUBSTITUTION_READONLY_CMDS`, `SUBSTITUTION_MAX_DEPTH`, `isSubstitutionReadOnlyAt` |
| 4 | `control-flow.ts` | R13（控制流关键字守卫）, R19（字面量 for 循环豁免）, R20（find 写操作 flag 不可靠） | `CONTROL_FLOW_KEYWORDS`, `scanControlFlow`, `scanFindWriteFlags`, `isGlobForLoopExempt`, `parseGlobForLoop`, `isLiteralIterationWord`, `isLiteralForLoop` |
| 5 | `shell-forwarder.ts` | R10（转发器命令守卫）, R14（Shell 转发器守卫）, R27（shell 转发器长参数前缀）, R28（shell 外层包装器）, R29（cd cwd 变更判不可靠） | `FORWARDING_COMMANDS`, `isForwarderStageSafe`, `isForwarderDownstreamExempt`, `SHELL_NAMES`, `SHELL_WRAPPER_NAMES`, `WRAPPER_VALUE_FLAGS`, `skipWrapperTokens`, `isShellForwarder`, `isShellForwarderTokenStream`, `scanCdChdir` |
| 6 | `silent.ts` | R11（静默命令白名单）, R21（Git 只读子命令 blob）, R22（npm/yarn/pnpm run）, R23（tsc 纯检查）, R24（go vet/fmt）, R25（npx --no-install）, R19（for 循环体只读判定辅助） | `SILENT_COMMANDS`, `SILENT_ALLOW_ALL`, `UNRELIABLE_COMMANDS`, `isSilentCommand`, `isAnyUnreliableCommand`, `isSilentTsc`, `isSilentGo`, `isSilentNpx`, `GIT_BLOB_OK_SUBCOMMANDS`, `NPM_RUN_OK_SCRIPTS`, `TSC_ENTRY_FLAGS`, `TSC_FLAG_*`, `NPX_FLAG_*`, `GO_SILENT_POSITIONAL_SUBCOMMANDS`, `looksLike*` 辅助函数, `HARMLESS_BUILTINS`, `isForBodyReadOnly` |
| 7 | `extractors.ts` | R1（文件写入/删除命令）, R2（文件读取命令）, R3（重定向）, R4（网络工具）, R8（提取结果数据结构）, R9（管道按 stage 独立提取的 stage 内 extractor 部分） | `COMMAND_TABLE`, `Extractor` 类型, 16 个 `*Extract` 函数（`rmExtract`, `cpExtract`, `mvExtract`, `readExtract`, `teeExtract`, `mkdirExtract`, `touchExtract`, `testExtract`, `lnExtract`, `metaExtract`, `truncateExtract`, `ddExtract`, `curlExtract`, `wgetExtract`, `installExtract`, `findExtract`） |
| 8 | `entry.ts` | R9（管道按 stage 独立提取的编排部分） | `extractBashTargets`（编排入口） |
| + | `index.ts` | —（barrel） | 13 个 `export` 符号重导出 |

**依赖方向**（readonly ↔ silent 有双向引用——`isBoundedGlobSafe` 需 `isForBodyReadOnly`，`isForBodyReadOnly` 需 `isReadOnlyWithArgs`。TS 容忍函数提升，无运行时问题；这是只读判定逻辑的内在耦合，属可接受环）：

```
parse.ts         ← 基础（无内部依赖）
  ↑
readonly.ts      ← parse（且 → silent：需 isForBodyReadOnly）
  ↑
silent.ts       ← parse, shell-forwarder（且 → readonly：需 isReadOnlyWithArgs）
scan.ts          ← parse, readonly
control-flow.ts  ← parse, readonly, silent
shell-forwarder.ts ← parse, readonly
extractors.ts    ← parse
  ↑
entry.ts         ← parse, readonly, scan, control-flow, shell-forwarder, silent, extractors
  ↑
index.ts         ← 从各文件 re-export
```

**循环依赖说明**：`readonly.ts ↔ silent.ts` 存在双向引用环（`isBoundedGlobSafe`→`isForBodyReadOnly`，`isForBodyReadOnly`→`isReadOnlyWithArgs`）。这是只读判定逻辑的**内在耦合**——两者共同构成"命令是否只读"的判定，拆分时无法完全解耦而不牺牲语义聚类。TS（ESM 函数提升）容忍该环，无运行时问题；`npm run typecheck` 通过。**已记录为已知可接受环**（非零循环断言，是语义域拆分的合理边界）。

### Tier 判定（bash-extract 独立子系统）

**判定**：`tier-medium`（对齐 `policy-core`）

**判据**：
- 29 requirement（bash-target-extraction spec），与 `permission-config`（23 requirement）+ `access-decision`（29 requirement）体量相当
- 3421 行代码，86 个 top-level decl
- 23 个 archive change 中 15+ 个直接影响 bash-extract（bash-pipeline-extract、bash-meta-commands-guard、bash-extractor-agent-exploration、bounded-glob-compound-separators、bash-stage-a-security-fixes、expand-reliable-classification、for-loop-iteration-glob-bounded、bash-extractor-false-positive-trim、bash-extractor-side-effect-tools-silent、bash-stage-b-security-fixes、permission-hardening-cleanup、bash-guardrails-popup-noise、bash-substitution-readonly-exemption、bash-bounded-glob-readonly-silent、bash-hardening-round-2、bash-symlink-grant-key-fix、tier-contract-consistency）——独立演进频率高
- 无 UI / 无 IO / 无第三方依赖（纯函数模块），符合 tier-medium 复杂度上限
- 未达到 tier-large 判据（tier-large 需要 3+ 嵌套层次或跨子系统的顶层架构决策）

**结论**：写入 profile-tier.yaml `bash-extract` 子系统为 tier-medium。无需触发顶层架构审阅（tier-large 加成不生效）。

## D2：`profile-tier.yaml` 子系统归属更新

### 变更

修改 `openspec/.td-state/profile-tier.yaml` 的 `subsystems` 列表：

**修改前**：
```yaml
subsystems:
  - name: extension-orchestration
    tier: tier-small
    ...
  - name: policy-core
    tier: tier-medium
    ...
  - name: side-effects
    tier: tier-small
    ...
```

**修改后**：
```yaml
subsystems:
  - name: bash-extract
    tier: tier-medium  # 或 D3 判定的值
    judge_reason: ...
  - name: extension-orchestration
    tier: tier-small
    ...
  - name: policy-core
    tier: tier-medium
    ...
  - name: side-effects
    tier: tier-small
    ...（judge_reason 更新：只保留 audit.ts）
```

**tier 判定**：由 D3 (`td-reverse-spec`) 给出，预计 tier-medium（29 requirement、86 decl、独立演进 23 个 archive change 里的 15+ 个）；如 D3 判定 tier-large，需评估是否触发顶层架构审阅（`constraints/references/human-in-loop.md` 表 1 tier-large 加成）。

### 依赖

D2 与 D1 独立、可并行——子系统归属是元数据变更，与代码拆分无运行时依赖。但**归档前两者必须都完成**，否则 profile-tier.yaml 与代码组织漂移。

## D4：集成验证

在 D1 与 D2 完成后运行：

1. `npm run typecheck` → 0 error（含循环依赖检测）
2. `npm test` → 全部 GREEN（764 测试，其中 403 是 bash-extract 拆分正确性回归网）
3. `git diff openspec/specs/bash-target-extraction/spec.md` → 空 diff（spec 未变）
4. `grep -A2 "bash-extract" openspec/.td-state/profile-tier.yaml` → 独立 subsystem 条目
5. `grep -A2 "side-effects" openspec/.td-state/profile-tier.yaml` → 只列 audit.ts

## 边界约束

- 不修改任何 spec 文本
- 不新增导出符号（barrel 只重导出既有 13 个符号）
- 不删除任何既有符号
- 不引入新的运行时依赖
- 不改变 `extractBashTargets` 的函数签名或返回值结构
- 拆分后 8 个文件两两无循环依赖
- 403 个 bash-extract 测试零修改（除 import 路径 4 处）

## 与既有架构/风格的遵循关系

- `src/lib/*.ts` → `src/lib/bash-extract/*.ts` 是"一个目录 + barrel"的演进，与 `policy-core` 若未来拆分保持一致模式
- 命名风格遵循既有 kebab-case（文件名）+ camelCase（符号）
- 无 UI/IO 依赖保持（bash-extract 一直是纯函数模块）

## 偏离既有架构

**无**——本 change 是既有"单文件模块"模式的细化（一个目录 + barrel），不引入新架构风格。

## 已知风险与缓冲

- **风险 R1**：拆分过程中可能发现隐藏循环依赖，需重新合并某些层（缓冲：D3 的 `td-reverse-spec` 输出会前置发现）
- **风险 R2**：`profile-tier.yaml` tier 判定（预计 tier-medium）若最终为 tier-large，触发顶层架构审阅 → 需暂停等用户拍板
- **缓冲策略**：F2 触发式缓冲槽位 2 个（tier-medium 15% × 13 = 2，向上取整）
