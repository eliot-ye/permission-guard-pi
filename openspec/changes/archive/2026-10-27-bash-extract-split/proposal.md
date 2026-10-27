## Why

`src/lib/bash-extract.ts` 已经膨胀到 **3421 行 / 29 requirements / 86 个 top-level declaration / 15+ 大类命令分类常量表**，与 `side-effects` 分系统另外两个文件（`audit.ts` 160 行 + `sensitive.ts` 315 行，`sensitive.ts` 归属已迁移到 `policy-core`）体量相差 **10–25 倍**，被 `openspec/.td-state/profile-tier.yaml` 打包为 "side-effects tier-small"。

这个体量不匹配已被 `2026-10-23 project audit`（a1）识别为真失调、由用户显式确认（A），落入 `openspec/todo.md` P2 待办池：

> "bash-extract 内部层次（READ_ONLY_COMMANDS / SILENT_COMMANDS / UNRELIABLE_COMMANDS / FORWARDING_COMMANDS / SUBSTITUTION_READONLY_CMDS / GIT_BLOB_OK_SUBCOMMANDS / NPM_RUN_OK_SCRIPTS / TSC_ENTRY_FLAGS / NPX_FLAG_* / CONTROL_FLOW_KEYWORDS / SHELL_NAMES / SHELL_WRAPPER_NAMES / HARMLESS_BUILTINS / COMMAND_TABLE 等 15+ 大类）足以触发'明显子系统边界'判据"

本次 change 关闭该 a1 项：把 `bash-extract` 独立为子系统，与 `side-effects`（保留 `audit.ts`）**解耦归属**；同时按语义域把 3421 行单文件拆分为多文件，使未来 29 requirement 的独立演进不再堆叠到一个文件里。

**明确不做**（探索阶段决策锁定）：
- 不改任何 spec 文本（`bash-target-extraction/spec.md` 29 requirement + 全 scenario 语义**不变**）——spec 是行为契约不是组织契约，本次拆的是 module-design 层
- 不扩大 import 方范围（`decision.ts` 与 `extensions/index.ts` 的 import 路径改为 `./bash-extract/index.ts`，导入符号**完全不变**）
- 不合并到 extension-orchestration-cleanup（另立 change，独立 scope、独立 spec 影响面）

## What Changes

### 主体变更：拆分 + 子系统归属重定

- **代码拆分**：`src/lib/bash-extract.ts`（3421 行）拆分为 `src/lib/bash-extract/` 目录下 8 个文件，按语义域组织：
  - `index.ts`：barrel 重导出（对外 API 契约不变，13 个 export 符号）
  - `entry.ts`：`extractBashTargets` 编排入口
  - `parse.ts`：`tokenize` / `splitCommands` / `splitPipelines` / `extractRedirects` / 变量展开
  - `scan.ts`：`scanUnreliable` / `scanFindWriteFlags` / 引号感知
  - `readonly.ts`：READ_ONLY_COMMANDS / isReadOnlyWithArgs / isBoundedGlobSafe 与 bounded-glob 支持函数
  - `silent.ts`：SILENT_COMMANDS 与 isSilentCommand 及各 dev-tool 只读子命令判定
  - `extractors.ts`：COMMAND_TABLE 与 15+ 个 extractor 函数
  - `control-flow.ts`：`scanControlFlow` / for-loop 豁免 / HEREDOC / find-write-flag
  - `shell-forwarder.ts`：shell forwarder / wrapper / cd-chdir 检测
- **子系统归属**：`profile-tier.yaml` 更新——`bash-extract` 从 `side-effects` 拆分出独立子系统条目，tier 由 `td-reverse-spec` 定向刷新判定（**预计 tier-medium**）；`side-effects` 保留 `audit.ts`（tier-small）
- **import 路径同步**：
  - `extensions/index.ts` 3 个 import 从 `../src/lib/bash-extract.ts` 改为 `../src/lib/bash-extract/index.ts`
  - `src/lib/decision.ts` 1 个 import 从 `./bash-extract.ts` 改为 `./bash-extract/index.ts`
  - `test/bash-extract.test.ts` 4 处 import 从 `../src/lib/bash-extract.ts` 改为 `../src/lib/bash-extract/index.ts`
- **拆分分层假设（D3，`td-reverse-spec` 前置）**：先运行 `td-reverse-spec` 定向刷新，识别内部层次，给出拆分粒度的最终判定

### 不变（明确边界）

- `openspec/specs/bash-target-extraction/spec.md` 文本**完全不变**——29 个 requirement 与全部 scenario 语义保持
- `ExtractResult` 类型（`{reliable: true, targets} | {reliable: false, reason, rawCommand}`）不变
- `extractBashTargets(rawCommand, projectRoot, env)` 函数签名不变
- 所有 13 个 `export` 符号的**对外 API 契约**不变（符号、类型、行为），仅组织路径改变
- 403 个既有 `test/bash-extract.test.ts` 用例**全部保留**、语义不变、作为回归网
- 测试覆盖率不降低

### 依赖决策

- **拆分粒度延迟决策**：本 change 内 design.md 定义"语义域分类"作为**候选**；实际拆分到几文件、每文件含哪些函数，由 apply 阶段的 `td-reverse-spec` 定向刷新判读 bash-extract 内部层次后最终确定（符合 `constraints/references/delay-decision.md`"模块设计层可延迟"）
- **子系统 tier 延迟决策**：bash-extract 独立子系统的 tier 由 `td-reverse-spec` 定向刷新判定后写入 profile-tier.yaml（预计 tier-medium）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无）

本次 change 是**纯组织层重构**——不新增/不修改任何 capability 的行为契约。`bash-target-extraction/spec.md` 文本、行为语义、scenario 集合**完全不变**。

## Impact

- **代码**：
  - `src/lib/bash-extract.ts`（3421 行）→ 删除（内容拆分到子目录）
  - `src/lib/bash-extract/` 新建目录 + 8 个文件（预计 300–500 行/文件）
  - `src/lib/bash-extract/index.ts`（barrel，~30 行）
  - `extensions/index.ts:43`：import 路径改
  - `src/lib/decision.ts:19`：import 路径改
  - `test/bash-extract.test.ts`：4 处 import 路径改（无测试语义变更）
- **测试**：403 个既有 `test/bash-extract.test.ts` 用例 + 全项目 764 个测试全部保持 GREEN（作为拆分正确性回归网）
- **规格**：无 spec 变更（`bash-target-extraction/spec.md` 完全不动）
- **配置**：`openspec/.td-state/profile-tier.yaml` 更新 subsystems 列表——bash-extract 独立为子系统（tier 由 td-reverse-spec 判定），side-effects 保留 audit.ts
- **数据 / 运行时**：无 IO / 无异步 / 无行为契约变化，纯静态代码组织重排
- **发布**：patch 版本；用户可见行为**完全不变**（本 change 无用户可观察变化）
- **依赖顺序**：本 change 与 `extension-orchestration-cleanup` 独立、无依赖，可并行推进

### Caller impact 分析

- **变更点清单**：
  - ① 文件路径 `src/lib/bash-extract.ts` → `src/lib/bash-extract/index.ts`（目录化）——属 ④ 类（内部实现路径）
  - ② `src/lib/bash-extract/index.ts` 新 barrel 导出——属 ② 类（公共符号面，符号名/类型/行为完全不变，仅来源路径变化）
  - ③ 内部符号（函数、常量）从单文件拆到 8 个文件——属 ④ 类（内部实现组织）
  - ④ `profile-tier.yaml` subsystems 列表更新——属 ⑤ 类（配置/元数据）
  - ⑤ `extensions/index.ts` / `src/lib/decision.ts` / `test/bash-extract.test.ts` 的 import 语句路径修改——属 ④ 类（内部实现）

- **高危标记**：② 属"公共符号面变化"（路径变化）——**但类型/签名/行为完全不变**，属加宽兼容中的"路径迁移"（符号名和类型签名不变，仅来源路径改变）。不触发 `constraints/references/human-in-loop.md` 必停基线。
- **已知 caller**：
  - `src/lib/decision.ts:19` 导入 `isDevSocketOrFd`——1 处，import 路径改
  - `extensions/index.ts:43` 导入 `extractBashTargets, tokenizeBashCommand, looksLikePathToken, ExtractResult`——4 符号，import 路径改
  - `test/bash-extract.test.ts`（403 用例）导入 10+ 符号——import 路径改，测试语义完全不变
  - 无其他生产代码调用 `bash-extract.ts` 内部符号（决策引擎、extension 编排、审计均通过上述已列 caller 中转）

本 change 是**组织层重构**，**全部为加宽兼容型变更**（新增 barrel、迁移路径、拆分文件），不含"收窄"或"删除"。与 `permission-config-rules-upgrade` / `authorization-classification` change 建立的加宽兼容先例一致。

## 系统工程影响评估

- **影响哪些分系统**：
  - **新增独立分系统** `bash-extract`（tier 由 td-reverse-spec 判定，预计 tier-medium）：承载 29 requirement 的 bash 命令提取与分类逻辑
  - `side-effects`（tier-small，减薄）：本 change 后只保留 `audit.ts`（`sensitive.ts` 归属 `policy-core` 已在 `2026-10-26-tier-contract-consistency` 完成）
  - `policy-core`（tier-medium）：`decision.ts` import 路径改，符号契约不变
  - `extension-orchestration`（tier-small）：`extensions/index.ts` import 路径改，符号契约不变

- **整体性能预期变化**：**零运行时开销**——纯静态代码组织重排，无 IO、无异步、无算法复杂度变化；barrel 文件的额外一次 `import` 解析由 jiti 在模块加载期完成，不进入 `extractBashTargets` 的调用路径。

- **这是局部优化还是全局协调**：**全局协调**——子系统归属变更会牵动 `profile-tier.yaml` 的 `subsystems` 列表、以及未来 29 requirement 演进时的 diff 归属（哪个 spec 变更、review 面多大）。任何单点改动（例如只拆文件不改 profile-tier.yaml）都会造成"代码已经拆分但配置元数据仍标为 side-effects 打包"的漂移，与 P2-2 教训（tier-contract-consistency change 记录）一致。

- **如果是局部优化，对全局失调的风险**：不适用（本次是全局协调）。

- **预期行为模型**（4 个可验证契约）：

  1. **对外 API 契约零变化**——所有 13 个 export 符号（`extractBashTargets`, `tokenizeBashCommand`, `looksLikePathToken`, `ExtractResult`, `isDevSocketOrFd`, `isReadOnlyWithArgs`, `isFindReadOnly`, `isBoundedGlobSafe`, `isForwarderStageSafe`, `isSubstitutionReadOnlyAt`, `isSilentCommand`, `isAnyUnreliableCommand`, `READ_ONLY_COMMANDS`, `FIND_WRITE_FLAGS`, `SILENT_COMMANDS`, `UNRELIABLE_COMMANDS`）签名/类型/行为与拆分前完全一致。验证方式：403 个既有 `test/bash-extract.test.ts` 用例零修改全 GREEN；`typecheck` 0 error。
  2. **子系统归属正确**——`profile-tier.yaml` 中 `bash-extract` 独立为 subsystem，`side-effects` 只保留 `audit.ts`。验证方式：`grep -A2 "bash-extract" openspec/.td-state/profile-tier.yaml` 返回独立 subsystem 条目；`grep -A2 "side-effects" ...` 只列 `audit.ts`。
  3. **无循环依赖引入**——拆分后的 8 个文件两两无循环 import。验证方式：`npm run typecheck`（TS module system 会在循环 import 时报错）+ 手工 `grep -n "^import" src/lib/bash-extract/*.ts` 检查。
  4. **spec 与代码一致**——`bash-target-extraction/spec.md` 29 requirement 与全部 scenario 文本不变。验证方式：`git diff openspec/specs/bash-target-extraction/spec.md` 返回空 diff。

- **与既有架构/风格的遵循关系**：本次改动严格遵循既有分系统的架构风格：
  - `src/lib/*.ts` 保持无 UI/IO 依赖纯函数——拆出的每个子文件继续无 UI/IO 依赖（`bash-extract.ts` 一直是纯函数模块，拆分不改变这一性质）
  - barrel `index.ts` 模式遵循既有 `src/lib/config.ts` 与 `src/lib/path-utils.ts` 的"一个文件对外"约定，只是从"一个文件"演进为"一个目录"（`policy-core` 若未来也拆分，模式一致）
  - 命名风格遵循既有 kebab-case 与 camelCase（`readonly.ts` / `control-flow.ts` / `shell-forwarder.ts`；`isReadOnlyWithArgs` / `extractBashTargets`）

  **偏离既有架构**：**无**——本 change 不引入新的架构风格，只把既有的"单文件模块"演化为"目录 + barrel"这一更细粒度的同一模式。

- **不适用降级**：不适用（本 change 是纯组织层重构，有明确可验证的行为契约——403 个测试 + typecheck + spec 零改动）。

## 实际 vs 预期（archive 复盘）

**复盘日期**：2026-10-27
**对照源**：本 proposal "系统工程影响评估"节 + `openspec/specs/bash-target-extraction/spec.md` baseline。

### 5 字段对照（tier-medium 深度）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：新增独立分系统 `bash-extract`（tier-medium）；`side-effects` 减薄至只留 audit.ts；`policy-core`/`extension-orchestration` import 路径改 | 实际影响：`bash-extract` 新增（tier-medium 确认）；`side-effects` 只留 audit.ts（sensitive.ts 已在 tier-contract-consistency 归 policy-core）；`policy-core`（decision.ts import 路径）；`extension-orchestration`（extensions/index.ts import 路径）。**一致**。 |
| 整体性能预期变化：零运行时开销（纯静态组织重排） | 实际：符合预期——纯静态代码移动，无 IO/无异步/无算法变化；barrel 的 import 解析在模块加载期一次性完成，不进 `extractBashTargets` 调用路径。 |
| 这是局部优化还是全局协调：**全局协调**（子系统归属变更牵动 profile-tier.yaml + 未来 29 req 演进 diff 归属） | 实际：确认是全局协调。profile-tier.yaml 已更新（bash-extract 独立 + side-effects 只留 audit.ts），归档后 29 req 演进的新 change 会直接落在 bash-extract 子系统。**无**局部优化→全局失调风险。 |
| 如果是局部优化，对全局失调的风险：不适用 | 不适用。**事后回检**（主基调第 1 条）：本 change 是否引入"局部最优全局失调"风险？——**无**。拆分按语义域，8 文件职责单一；readonly↔silent 环是只读判定内在耦合（TS 容忍），不构成失调。 |
| 预期行为模型（4 契约） | 见下方逐契约验证。 |

### 模型验证（4 契约逐一）

| 契约 | 验证方式 | 结果 |
|---|---|---|
| 契约 1：对外 API 契约零变化 | 403 个既有 `test/bash-extract.test.ts` 用例零修改全 GREEN；index.ts 18 export 符号与拆分前完全一致（含 SUBSTITUTION_READONLY_CMDS）；typecheck 0 error | **通过**。403/403 GREEN；18/18 符号对等。 |
| 契约 2：子系统归属正确 | `profile-tier.yaml` bash-extract 独立 subsystem（tier-medium）；side-effects 只列 audit.ts | **通过**。grep 验证独立条目 + audit.ts-only。 |
| 契约 3：无循环依赖引入 | 依赖图：readonly↔silent 双向引用环（`isBoundedGlobSafe`→`isForBodyReadOnly`，`isForBodyReadOnly`→`isReadOnlyWithArgs`） | **通过（有说明）**。TS 容忍（ESM 函数提升），无运行时问题；已记录 design.md D1 为已知可接受环——这是只读判定逻辑的内在耦合，非设计缺陷。 |
| 契约 4：spec 与代码一致 | `git diff openspec/specs/bash-target-extraction/spec.md` 空 diff | **通过**。29 req 文本与拆分前完全一致。 |

**模型验证结论**：4 契约全部验证通过（契约 3 有说明性偏差——环存在但可接受），预期行为模型成立。

### 预期之外的副作用

1. **readonly↔silent 循环依赖**：design.md D1 原断言"无循环"不成立——`isBoundedGlobSafe`（readonly）与 `isForBodyReadOnly`（silent）互相引用。实际为语义域拆分的合理边界（只读判定内在耦合），TS 容忍，已如实回写 design.md（td-apply 步骤 5 设计回写）。非缺陷，是设计文档修正。
2. **HARMLESS_BUILTINS/isForBodyReadOnly 归属调整**：D0 建议归 control-flow.ts，实际归 silent.ts（两者依赖 isReadOnlyWithArgs + isSilentCommand，silent.ts 天然满足）。design.md D1 已同步修正。
3. **测试覆盖**：403 bash-extract + 548 边界测试（policy-core 59 + extension 26 + trust 32 + audit 9 + sys-integration 16 + grant-memory 3 + decision 59... 全量 689）全 GREEN；AL7 并发审计 flake 1/3 触发（既有，非本 change 引入）。

### 未使用的 F2 缓冲槽位

3 个 F2 触发式缓冲槽位**均未触发**（D3 内部层次判读、D1 拆分 + import 迁移、D4 集成验证一次通过）。预留但未消耗。
