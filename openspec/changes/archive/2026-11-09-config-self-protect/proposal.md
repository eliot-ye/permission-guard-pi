# Proposal: config-self-protect

## Why

permission-guard-pi 作为权限门，**不保护它自身维护的配置与运行时状态**。被管控的 agent 可通过工具调用：

- 写 `~/.pi/agent/extensions/permission-guard-pi/trusted.json` → **伪造持久 grant 自批授权**（把任意路径写成"总是允许"）；
- 写 `~/.pi/agent/extensions/permission-guard-pi/settings.json` → 设 `enabled: false` **关闭整个门**；
- 写 `<proj>/.pi/permission.json`（或 `.pi/local/permission.json`）→ **静默 auto_allow**（项目内非敏感写，无弹窗）→ 写入 `{"**": "read_write"}` **自我提权**。

前两者当前走常规规则（项目外非敏感写 → prompt tier=three），第三条是静默 auto_allow（`src/lib/decision.ts:302-315`）。ta-agent 对同类内部状态是硬 deny 且不可豁免（`../ta-agent/packages/runtime/src/approval/policy.ts:60-68`）。本 change 补上"配置与运行时状态自保护"。

**范围（用户拍板 2026-11-09，两次确认）**：
- 保护 `trusted.json` / `settings.json`（运行时状态）——写/delete → **deny_hard**；
- 保护 `permission.json`（project/local/global 三档）——写/delete → **prompt tier=two**（不再静默，且不可持久化"总是允许"）；
- **不做** `<proj>/.pi/**`、`~/.pi/agent/**` 的通用路径保护（用户明确否决）。

## What Changes

- 新增纯函数模块 `src/lib/config-protect.ts`：
  - `isProtectedRuntimeState(absPath, trustedPath, settingsPath): boolean` —— `absPath`（规范化绝对路径）等于 `trusted.json` 或 `settings.json` 的规范化路径。
  - `isConfigWritePath(action, absPath, paths: string[]): boolean` —— `action` 为 write/delete 且 `absPath` 等于任一 `paths` 元素（global/project/local `permission.json`）。
- `extensions/index.ts` 在 `decideTarget()` 内做两层 pre-check（统一覆盖 file 工具 + bash 目标）：
  - **运行时状态**：`isProtectedRuntimeState` 命中且 action ≠ read → `deny_hard`（在 grant 检查**之前**，不可被 grant/配置声明/`!` 否定豁免）。
  - **配置写**：`isConfigWritePath` 命中（无 grant）→ `prompt tier=two`、`declaration: "config_write"`（在 grant 检查**之后**、`decide()` **之前**；session grant 可放行本会话，**无**"总是允许"）。
- 读受保护文件均**不受影响**（按常规规则判定）。
- 新增 `Declaration` 值 `"config_write"` + 副文本码 `subtitle_config_write_not_persistable`（i18n zh/en）——配置写弹窗显示"不可持久化"引导。
- SessionState 增加 `configPaths` 字段（`configLocations()` 结果），供 `decideTarget` 判定。
- 契约变更：`access-decision`（2 条新要求）+ `approval-flow`（配置写副文本 scenario）。

## Capabilities

### New Capabilities

（无——本 change 不引入新 capability/子系统。）

### Modified Capabilities

- `access-decision`: 新增 Requirement「运行时状态自保护（trusted.json / settings.json 写保护）」——写/delete → `deny_hard`，不可豁免；「配置写保护（permission.json 写保护）」——写/delete → `prompt tier=two`（非静默、不可持久化），读不受影响。
- `approval-flow`: 新增 tier=two 配置写副文本分派——`declaration: "config_write"` 弹窗副文本提示"配置写不可持久化"。
- `audit-log`: `declaration` 字段枚举新增 `"config_write"`；`grant_source` 派生规则补充 config_write → `"default"`（对齐 `promptGrantSource` 既有 fallthrough，`extensions/index.ts:199`）。

## Impact

- **代码**：`src/lib/config-protect.ts`（新，纯函数）；`extensions/index.ts`（`decideTarget` pre-check + 副文本分派 + SessionState.configPaths）；`src/lib/decision.ts`（Declaration 加值）；`src/lib/reason-codes.ts` + `src/lib/i18n.ts`（副文本码）。
- **行为**：写/delete `trusted.json`、`settings.json` → `deny_hard`；写/delete `permission.json` → `prompt tier=two`；读均不变。
- **依赖**：无新第三方依赖。
- **分系统**：policy-core（判定 + 新模块 + Declaration/副文本）+ extension-orchestration（`decideTarget` pre-check 装配 + SessionState + approval-flow 副文本 + bash C5 扫描复用）+ side-effects（audit-log 契约 spec-only）。bash-extract（`src/lib/bash-extract/`）**不改**——C5 兜底扫描在 `extensions/index.ts`（extension-orchestration）内复用。

## 系统工程影响评估

（钱学森系统工程主基调第 3 条「从定性到定量的综合集成」。）

- **影响哪些分系统**：policy-core（access-decision 契约 + 新 `config-protect` 模块 + Declaration/i18n）、extension-orchestration（`decideTarget` 装配 + SessionState + approval-flow 副文本 + bash C5 扫描复用）、side-effects（audit-log **契约**，spec-only delta——`promptGrantSource` 既有 fallthrough 已产生 `config_write` 审计，无代码改动）。bash-extract 模块本身不改（C5 扫描在 extension-orchestration）。
- **整体性能预期变化**：受保护路径命中为 O(1) 路径等值/前缀判断（只对已解析的目标路径执行，不新增扫描）；普通路径无性能变化。行为：trusted.json/settings.json 写/delete 从常规判定变 `deny_hard`；permission.json 写/delete 从 `auto_allow`（项目内静默）变 `prompt tier=two`；读均不变。
- **这是局部优化还是全局协调**：全局协调——保护"决策层自身配置与运行时状态"的完整性，防止被管控 agent 自我提权（伪造 grant / 关闭整门 / 静默改策略）；不是局部优化。
- **如果是局部优化，对全局失调的风险**：N/A（全局协调）。
- **预期行为模型**：输入「写/delete `trusted.json` / `settings.json`」→ 期望 `deny_hard`（`{ block: true }`），不可被配置声明 / grant 记忆 / `!` 否定绕过；输入「写/delete `permission.json`（无 session grant）」→ 期望 `prompt tier=two`（`declaration: "config_write"`），不被配置声明静默化；「读任一受保护文件」→ 期望按常规规则（非 deny_hard）。验证：新增 TDD 测试断言以上输入→输出；spec scenario 覆盖。
- **与既有架构/风格的遵循关系**：遵循既有分层——纯函数 `config-protect.ts`（零 IO/UI，可单测，对齐 `src/lib/*.ts` 约定）+ `extensions/index.ts` 集成层装配；配置写用既有 tier=two prompt 机制（对齐"未配置项目外 hard sensitive"的不可持久化语义）。不偏离既有架构。

## caller impact 分析

- **变更点清单**：
  - ③ 装配点新增定义点：`extensions/index.ts` `decideTarget` 内新增两层 pre-check（运行时状态 + 配置写）。纯新增，无既有 caller。
  - 新增公共符号 `isProtectedRuntimeState` / `isConfigWritePath`（`src/lib/config-protect.ts`）——新符号，非签名变更。
  - 类型加值：`Declaration` 联合新增 `"config_write"`（additive，union 拓宽，不破坏既有等值检查——已核对无穷尽 switch）。
  - 副文本码新增 `subtitle_config_write_not_persistable`（additive UiCode + i18n bundle，不破坏既有）。
- **高危标记**：无——无公共符号签名变更（①）、无 Protocol/接口变更（②）、无既有装配点改动（③ 为新增定义点）、无返回值语义变更（④）；均为新增符号 / 新增装配点 / additive 类型加值。
- **已知 caller**：无高危 caller（新增符号无既有调用者；装配点新增不改既有函数签名；`Declaration`/`UiCode` 加值不破坏既有等值检查）。

> 注：caller impact 三层防护因**跨分系统**（policy-core + extension-orchestration + side-effects ≥ 2）触发；但变更点均为纯新增（新符号 + 新装配点 + additive 类型/码 + spec-only 契约 delta），无既有 caller 破坏。

## Architecture Review

Verdict: **APPROVED_WITH_CHANGES**（无 critical；2 warning + 3 nit）。reviewed-by: subagent。

- **高内聚**：OK。policy-core（决策契约 + 新 `config-protect` 模块）、extension-orchestration（`decideTarget` 装配 + SessionState）、approval-flow（副文本）职责单一；bash-extract 模块不改（C5 扫描在 extension-orchestration）。
- **低耦合**：OK。子系统接口 = 2 个纯谓词 + additive Declaration/UiCode；无循环依赖 / 隐式共享态；D4 顺序显式。
- **caller impact**：OK。③ 装配点新增定义点 + 新增公共符号 + additive 类型加值；已核对 `Declaration` 无 exhaustive switch（union 拓宽 code-safe）。
- **spec 合规**：OK（2 个 warning 已在本版修复，见下）。
- **Issues（修复记录）**：
  1. [warning→已修] audit-log 契约：`config_write` 补入 `declaration` 枚举 + `grant_source → "default"` 派生 → 新增 `specs/audit-log/spec.md` delta + proposal Modified Capabilities 加 `audit-log`。
  2. [warning→已修] D5 覆盖声明：不可靠 bash **无 grant** 分支也做 L1/L2 保护扫描（`scanBashProtectedPaths` 三分支复用）→ design D5 / tasks 3.4 / access-decision 补「不可靠 bash」场景。
  3. [nit→已修] bash-extract 标签 → 改为 extension-orchestration（proposal Impact / 系统工程影响评估 / caller impact 注）。
  4. [nit→已修] 谓词双输入：`resolvedAbs` + `canonicalPath`（OR）→ design D8 / tasks 3.1-3.2。
  5. [nit→已修] configPaths 键形状：`loadAllConfigs` 统一返回 `{global,project,local}` 并复用 → design D7 / tasks 3.1。

## 实际 vs 预期复盘（archive）

（系统工程主基调第 3 条「从定性到定量的综合集成」——archive 前闭合"实际 vs 预期"循环，数据供后续 `/td-system-audit`。）

- **实际影响的分系统**：policy-core（`src/lib/config-protect.ts` 新谓词 + `Declaration` 加 `"config_write"` + `UiCode`/i18n 副文本）、extension-orchestration（`decideTarget` L1/L2 pre-check + `SessionState.configPaths` + `scanBashProtectedPaths` + approval-flow 副文本分派）、side-effects（audit-log 契约：`declaration=config_write` + grant_source 标注（非 bash→default / bash→bash_grant_memory）+ config_write allow_session `permission=null`）。bash-extract 模块**未改**（仅只读导入 `expandSafeVariables`）。与预期一致。
- **实际整体性能变化**：L1/L2 为 O(1) 规范化等值判断，仅对已解析目标路径执行；`scanBashProtectedPaths` 仅在**不可靠 bash** 分支（有/无 grant）各运行一次 O(tokens) 扫描；普通路径无新增扫描。与预期一致（不可靠 bash 新增一次 O(tokens) 扫描，量级可忽略）。
- **实际是局部优化还是全局协调**：全局协调——防止被管控 agent 自我提权（伪造 grant / 关闭整门 / 静默改策略），非局部优化。与预期一致。
- **局部优化的实际全局影响**：N/A（全局协调）。注：scan 大小写折叠为 fail-closed（大小写敏感 FS 上对 case-variant 变体会多拒受控位置路径），属安全向 fail-closed 的保守，非全局失调。
- **模型验证**：**预期行为模型已验证**。SYS-CP1（trusted 写 deny_hard 无 prompt）、SYS-CP2（settings deny_hard）、SYS-CP3（permission prompt tier=two 无 always-allow + 副文本）、SYS-CP4（read_write 声明不静默）、SYS-CP5（读 permission 不受阻）、SYS-CP6/8（可靠/不可靠 bash trusted → deny_hard）、SYS-CP7/10（不可靠 bash permission → config_write prompt）、SYS-CP9（session grant 不自动放行 config_write）、SYS-CP11（case-variant deny_hard）全绿。**模型修正（review 发现→已闭合）**：不可靠 bash 扫描最初漏 env-var/大小写变体路径（模型"不可被 grant 绕过"的 bash 覆盖缺口），经补 `expandSafeVariables` env 展开 + 大小写折叠修复后模型成立。

### 补充复盘项

- **预期之外的副作用**：① scan 大小写折叠（fail-closed，受控位置多拒可接受）；② `expandSafeVariables` 只读导入（bash-extract 模块零改动）；③ 不可靠 bash 新增一次 O(tokens) 扫描（量级可忽略）。
- **scenario→test 覆盖账本状态**：本 change 未产出独立 scenario→test 覆盖账本（`.openspec.yaml` 为 `schema: spec-driven`，无 `applyRequires`，ledger 非必需）；spec scenario 由 TDD 集成测试直接覆盖（SYS-CP1-11 + config-protect 13 单测，全绿）。
- **需求权衡处置**：无留待 archive 的矛盾标注（决策在 propose/apply 已定：trusted/settings deny_hard + permission prompt 范围、L1 非豁免、L2 不可持久化、bash 三分支覆盖）。
