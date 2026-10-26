## Why

`permission-guard-pi` 的 tier 类型 `"three" | "two"` 当前承载两种语义：
1. **持久化能力标签**——`tier=three` 弹窗提供"总是允许"持久化，`tier=two` 不持久化（sensitive default 语境）。
2. **来源区分标签**——`tier=two bash 命令类`（含 `bash_reason`）作为 `tier=two` 的"变体"，**实际**提供三档 + rawCommand 持久化。

语义漂移的直接后果：
- `access-decision` / `approval-flow` / `grant-memory` 三个 spec 里 `tier=two bash 命令类` 是 `tier=two` 的显式变体，与 `tier=two` 的"不持久化"核心契约自相矛盾；
- README "How decisions work" 与 `docs/security/permission-model.md` 声称 tier=two 不持久化，与实际弹窗行为不符；
- `~/.ssh/known_hosts` / `~/.ssh/authorized_keys` 被归为 hard sensitive，但它们是公钥（客户端存储的已知主机公钥 + 授权公钥），无"泄露不可逆"风险，误伤日常读取；
- 用户若声明 `~/.ssh/**` 或 `~/**` 等大范围通配并给非 `unread` 权限，会静默覆盖 `~/.ssh/id_rsa` 的 hard sensitive 兜底——配置加载时不告警，用户认知落差无主动提示。

## What Changes

- **A1：tier 语义收敛（d2 方向）**
  - `Decision.PromptTier` 从"sensitive 语义标签"收敛为"持久化能力标签"：`tier=three` 可持久化、`tier=two` 不可持久化。类型 `"three" | "two"` 不变，扩展的是 tier 值的语义。
  - `handleBash` unreliable 分支 tier 从硬编码 `"two"` 改为 `"three"`。reliable bash 目标走 `decide()` 时的敏感/网络外带路径不受影响。
  - `promptUser` 移除 `if (bashReason)` 分支（reliable bash tier=two 走不到该分支）；tier=three 与 tier=two 分支语义统一。
  - **BREAKING 语义**（用户可见）：unreliable bash 弹窗从"两档 + 无 Always allow"变为"三档 + 允许 Always allow"（rawCommand 持久化）——`trusted.json` 的 `bashGrants` 段首次成为有效写入目标；unreliable bash 持久化是**有意为之**的独立通道，与 sensitive-default tier=two 无关。

- **A2：`known_hosts` / `authorized_keys` 从 hard sensitive 降级为 soft sensitive**
  - `src/lib/sensitive.ts` SSH 规则拆分：`id_rsa` / `id_dsa` / `id_ecdsa` / `id_ed25519` / `config in .ssh` 保留 hard；`known_hosts` / `authorized_keys` 独立为新 soft 规则（reason = "SSH known_hosts / authorized_keys public key"）。
  - 用户可见行为变化：`~/.ssh/known_hosts` 与 `~/.ssh/authorized_keys` 从 tier=two 升为 tier=three（外区可持久化）；项目内本已是 tier=three 无变化。

- **A3：文档同步**
  - README "How decisions work"：tier 语义更新（tier=two 不持久化限定于 sensitive default + network exfiltration）；unreliable bash 归 tier=three。
  - `docs/security/permission-model.md`：同步 tier 语义 + A4 新 warning 行为。

- **A4：配置加载期通配覆盖 warning（e1 方向）**
  - `mergePolicies` 新增校验：遍历所有 entries，若 `permission !== "unread"` 且 pattern 命中至少一个 hard sensitive 锚点路径 → 向 `warnings[]` 追加一条结构化 warning。
  - 锚点枚举：hard sensitive 规则表覆盖的约 20 条 canonical 路径（SSH key 系列、私钥扩展名、凭证目录、系统机密）。
  - Warning 触发时机：`session_start` handler 里既有的 `warnings.length > 0 && ctx.ui.notify(...)` 循环自然承接——无需改 extension 层。

- **不变**：
  - `PromptTier` 类型定义 `"three" | "two"` 不变。
  - Dev-socket 写入 tier=two 契约不变（network exfiltration 是不可持久化的硬底线）。
  - `trusted.json` 磁盘格式不变（`grant-memory` spec 的 tier=two 限定收窄范围）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `access-decision`：unreliable bash 命令 tier 从 `tier=two` 改为 `tier=three`；hard sensitive 规则调整（`known_hosts` / `authorized_keys` 移出 hard 集合）；tier 语义扩展为"可持久化 vs 不可持久化"作为分派依据。
- `approval-flow`：删除"tier=two bash 命令类"作为 tier=two 变体的定义（bash 命令类现在统一走 tier=three）；副文本分派规则按 tier 值精确分派，不再依赖 `bash_reason` 存在性。
- `grant-memory`：`"未配置路径不写入持久化"` requirement 里的 tier=two 限定收窄范围（不再包括 bash 命令类）；bash grant 持久化的 tier 前提更新。
- `permission-config`：新增 requirement "配置加载期通配覆盖 warning"——定义 e1 校验的触发条件、warning 消息格式与承载位置（warnings[] 字段）。
- `bash-target-extraction`：**文本级同步（非行为变更）**——spec 里多处"tier=two 兜底弹窗"引用需同步改为"tier=three"（tier 分派在 access-decision 层，extractor 只报告 reliable/unreliable 与 reason）。**变更内容：纯文本修改，不引入新 requirement / scenario / 行为契约**。列为本 change 的一部分而非后续 change，避免归档后文本漂移永久化（P2-3 责任划分明确化）。

## Impact

- **代码**：
  - `src/lib/sensitive.ts`：
    - SSH 规则拆分（A2）——`known_hosts` / `authorized_keys` 从 SSH 密钥 hard 规则移出，新增独立 soft SSH 公钥文件规则
    - `SensitiveRule` 接口新增可选 `anchor?: string[]` 字段（A4 锚点派生式，方案 A，消解双事实源漂移风险）
    - 新增导出 `HARD_SENSITIVE_ANCHORS: readonly string[]`（A4）——从 `DEFAULT_SENSITIVE_RULES` 中每条 hard 规则的 `anchor` 字段派生，共约 **26 条** canonical 锚点
  - `src/lib/config.ts`：`mergePolicies` 新增 e1 校验函数（A4），按 `entry.isRelative` 分支与 `resolve()` 匹配语义对齐
  - `src/lib/decision.ts`：`decide()` 的 `PromptTier` 分派注释同步（tier 语义扩展）
  - `src/lib/bash-extract.ts`：**不改行为**——extractor 只报告 reliable/unreliable 与 reason；tier 分派在 extension 层 `handleBash` unreliable 分支
  - `extensions/index.ts`：
    - `handleBash` unreliable 分支 tier 字面量从 `"two"` 改为 `"three"`（A1）
    - `promptUser` 移除 `if (bashReason)` 分支（A1）
    - `handlePromptDecision` 的 tier=two 副文本分派移除 bash 相关分支，并新增 tier=three + bash 分支处理 bash 副文本分派（A1）
  - `test/decision.test.ts`、`test/sensitive.test.ts`、`test/config.test.ts`、`test/audit.test.ts`、`extensions/index.test.ts`、`test/sys-integration.test.ts`：tier 断言更新 + 新场景覆盖
  - `README.md`、`docs/security/permission-model.md`、`CHANGELOG.md`：文档同步（A3）
  - `openspec/specs/bash-target-extraction/spec.md`：文本级同步"tier=two 兜底弹窗"→"tier=three"（A3，非行为变更）

- **配置**：无 schema 变化，向后兼容（`permission-config` 加宽 requirement，不改 `paths` / `rules` 结构）

- **数据**：`trusted.json` 格式不变（`grant-memory` 语义收窄但磁盘契约不变）

- **审计**：`grant_source` 与 `authorization` 字段派生规则不变；bash grant 命中的 `grant_source: "bash_grant_memory"` 保持

- **测试面**：TDD 优先——
  - A1：新增 bash unreliable tier=three 场景 + 删除 bash tier=two 相关既有断言
  - A2：新增 known_hosts / authorized_keys 场景（外区 tier=three）
  - A4：新增大范围通配 warning 场景（多种 pattern 形态）

- **发布**：patch 版本 0.2.1——A2 与 A1 都是**语义修正**而非新增能力；用户可观察行为变化记录在 CHANGELOG.md（`~/.ssh/known_hosts` 从 tier=two 升 tier=three；unreliable bash 弹窗提供 Always allow；大范围通配加载 warning）。

## caller impact 分析

- **变更点清单**：
  - ① `Decision.PromptTier` 类型 + `Decision.kind === "prompt"` 对象的 tier 分派规则（unreliable bash tier=two → tier=three；hard/soft sensitive 分流）——属 ① 类（公共符号，tier 值的语义扩展但类型不变）
  - ② `SensitiveRule` 接口新增可选 `anchor?: string[]` 字段 + `HARD_SENSITIVE_ANCHORS` 新增导出——属 ② 类（类型加宽 + 新公共符号）
  - ③ `mergePolicies` 返回值里 `warnings: string[]` 的**数量语义扩展**（A4 warning 新类型加入，但字段类型不变）——属 ② 类（类型加宽，字段承载新语义）
  - ④ `mergePolicies` 内新增 e1 校验循环——属 ③ 类（装配点）
  - ⑤ `DEFAULT_SENSITIVE_RULES` 数组元素内容（`known_hosts` / `authorized_keys` 分流；每条 hard 规则新增 anchor 字段）——属 ④ 类（内部实现：数组结构与 `SensitiveRule` 接口不变，仅元素内容变化）
  - ⑥ `handleBash` 内部 unreliable 分支 tier 字面量——属 ④ 类（内部实现，`handleBash` 是 `registerPermissionGate` 内的局部函数）
  - ⑦ `promptUser` 移除 `if (bashReason)` 分支——属 ④ 类（内部实现）
  - ⑧ `handlePromptDecision` 副文本分派修改（tier=two 分支移除 bash 相关分派，tier=three 分支新增 bash 副文本分派）——属 ④ 类（内部实现）
  - ⑨ **文档 / spec 引用同步**：README.md、`docs/security/permission-model.md`、`CHANGELOG.md`、`openspec/specs/bash-target-extraction/spec.md` 中"tier=two 兜底弹窗"引用文本——属 ⑤ 类（文档 / spec caller）

- **高危标记**：①②③ 属高危（公共符号 / 类型加宽 / 装配点）。**变更类型均为加宽兼容**：
  - ① `PromptTier` 类型本身不变，只是既有 tier 值的语义扩展——所有 `kind === "prompt"` 消费者不需要感知类型变化
  - ② `SensitiveRule` 接口新增可选字段（不破坏既有实现）+ `HARD_SENSITIVE_ANCHORS` 新增导出（新增而非修改，不影响既有导入者）
  - ③ `warnings: string[]` 类型不变，只扩展内容
  - ④⑤⑥⑦⑧ 内部实现，外部无感
  - ⑨ 文档非代码，无运行时影响

- **已知 caller**：
  - `decide()` 被 `extensions/index.ts:739` 调用（1 处，直接消费返回值）——兼容，无需改
  - `promptUser` 消费 `tier: "three" | "two"` 分派 UI——`if (bashReason)` 分支需删除（A1，⑦）
  - `handleBash` 内部构造 `Decision` 字面量——tier 字面量需改（A1，⑥）
  - `handlePromptDecision` 消费 `decision.tier` 与 `bashReason` 分派副文本——tier=two 分支修改 + tier=three 分支新增（A1，⑧）
  - `session_start` handler 与 tool_call handler 消费 `state.warnings`——A4 warning 自然被承接，无代码改动
  - `findSensitiveMatch(p)` 返回 `SensitiveRule | undefined`——接口加可选字段不破坏返回值类型（②）
  - `test/decision.test.ts`、`test/sensitive.test.ts`、`test/config.test.ts`、`test/sys-integration.test.ts`——断言值需按新 tier 分派更新（非兼容性问题，是断言更新）
  - README / permission-model.md / CHANGELOG.md / bash-target-extraction spec：文本同步（⑨）

本 change 是"语义收敛 + 数据分流 + 加载期校验 + 文档同步"的组合，**全部为加宽兼容型变更**，不含"收窄"或"删除"。与 `permission-config-rules-upgrade` / `authorization-classification` change 建立的加宽兼容先例一致。

## 系统工程影响评估

- **影响哪些分系统**：
  - `policy-core`（tier-medium）：`sensitive.ts` 规则分流 + `SensitiveRule` 接口加 anchor 可选字段 + `HARD_SENSITIVE_ANCHORS` 新增导出 + `decision.ts` tier 分派语义扩展 + `config.ts` 新增 e1 校验
  - `extension-orchestration`（tier-small）：`handleBash` tier 字面量 + `promptUser` 分支简化 + `handlePromptDecision` 副文本分派
  - `side-effects`（tier-small）：`audit.ts` 不涉及（本 change 无 audit 行为变更）
  - **分系统归属澄清（P2-2）**：本 change 将 `sensitive.ts` 归属归入 `policy-core`（而非之前误归的 side-effects）。理由：`sensitive.ts` 是纯函数规则表（无 IO / UI），与 `decision.ts` / `config.ts` 语义上同属决策层的规则定义与配置解析；side-effects 严格意义是 `audit.ts`（追加日志 IO）。此归属澄清与 `profile-tier.yaml` 中现有声明可能不一致，本 change 归档时可一并更新 profile-tier.yaml 的分系统列表。

- **整体性能预期变化**：无 IO / 无异步新增；`mergePolicies` 新增 e1 校验是纯计算遍历，量级 ≈ 配置条目数 × 锚点数（≤ 20），会话初始化阶段一次性执行，无运行时开销。审计日志新增 warning 记录（若触发），单条 < 500 字节。

- **这是局部优化还是全局协调**：**全局协调**——A1/A2/A3 是跨分系统的类型契约收敛（tier 语义跨 access-decision → approval-flow → grant-memory → bash-target-extraction 四个 capability 联动），A4 是 policy-core 内的加载期校验但需 spec 表达为 permission-config 契约。任何单点改动（例如只改 `handleBash` tier 字面量而不改 spec / approval-flow）都会造成契约漂移，反而制造局部最优、全局失调。

- **如果是局部优化，对全局失调的风险**：不适用（本次是全局协调，非局部优化）。

- **预期行为模型**（4 个可验证契约）：

  1. **所有 prompt 决策的 tier 值语义一致**——`tier=three` 弹窗选项包含"总是允许"（写入 path 或 rawCommand 持久化），`tier=two` 弹窗选项不含"总是允许"。验证方式：`node --experimental-strip-types --test` 中所有 `Decision.tier === "three"` 场景断言弹窗选项集合包含"Always allow"；`Decision.tier === "two"` 场景断言弹窗选项集合不含"Always allow"。

  2. **敏感路径分级匹配**——`~/.ssh/id_rsa` 等私钥路径仍 hard（外区 tier=two 不可持久化）；`~/.ssh/known_hosts` / `~/.ssh/authorized_keys` 现 soft（外区 tier=three 可持久化）。验证方式：`findSensitiveMatch("~/.ssh/id_rsa").level === "hard"`；`findSensitiveMatch("~/.ssh/known_hosts").level === "soft"`；`findSensitiveMatch("~/.ssh/config").level === "hard"`。

  3. **unreliable bash 命令弹窗 tier=three 且提供"总是允许本命令"**——`cat $SECRETS` / `bash -c "..."` 等 unreliable 命令触发 tier=three 弹窗，用户选择"Always allow this command"后写入 `trusted.json.bashGrants`；下次同 rawCommand auto-allow。验证方式：`handleBash` 分支断言 `Decision.tier === "three"`；`grant-memory` spec 里 bash grant 持久化场景更新为 tier=three 前提；audit log `event: "allow_persistent"` 且 `grant_source: "bash_grant_memory"`。

  4. **配置加载期通配覆盖 warning**——`mergePolicies` 遍历 entries 时，若 `permission !== "unread"` 且 pattern 命中至少一个 hard sensitive 锚点路径，向 `warnings[]` 追加一条 warning；`session_start` handler 通过 `ctx.ui.notify(...)` 呈现。验证方式：给定配置 `{ paths: { "~/.ssh/**": "read_write" } }` → `mergePolicies(...).warnings` 包含匹配 `/\.ssh/` 的 warning；`{ paths: { "~/.ssh": "unread" } }` → 无 warning；`{ paths: { "src/**": "read_write" } }` → 无 warning。

- **与既有架构/风格的遵循关系**：本次改动遵循既有分系统的架构风格与代码约定：
  - `src/lib/*.ts` 保持无 UI/IO 依赖纯函数（e1 校验加入 `mergePolicies` 而非 extension 层；HARD_SENSITIVE_ANCHORS 从 rules 派生避免双事实源）
  - JSONC 配置格式不变（仅扩展 warning 内容语义，不改 schema）
  - `Decision` 类型加宽兼容（tier 值语义扩展但类型不变）
  - `SensitiveRule` 接口加宽兼容（新增可选 `anchor` 字段，不破坏既有实现）

  **偏离既有架构**：**无**（P1-3 已通过方案 A 消解——锚点与规则同侧维护，非静态常量双事实源。SensitiveRule 接口加宽是新字段引入，与 `permission-config-rules-upgrade` / `authorization-classification` change 建立的加宽兼容模式一致，不触发 `constraints/references/human-in-loop.md` 的必停场景）。
  - TDD 节奏：测试先于实现（T1–T4 覆盖四契约，既有测试补断言）

  **偏离既有架构**：无。A4 的 warning 承载在 `warnings[]` 既有字段而非新增字段，是**加宽而非新增类型**，与 `permission-config-rules-upgrade` / `authorization-classification` change 建立的加宽兼容模式一致。

- **不适用降级**：不适用（本 change 有实质行为变化，四契约均需可验证测试）。

## 实际 vs 预期（archive 复盘）

**复盘日期**：2026-10-27
**对照源**：本 proposal "系统工程影响评估"节 + `openspec/specs/{access-decision,approval-flow,grant-memory,permission-config,bash-target-extraction}/spec.md` baseline。

### 5 字段对照（tier-medium 深度）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：`policy-core`（sensitive + config + decision tier 分派语义扩展）、`extension-orchestration`（handleBash / promptUser / handlePromptDecision）、`side-effects`（不涉及 audit） | 实际影响：`policy-core`（sensitive.ts + config.ts + decision.ts 未改，tier 分派语义通过 extension 层实现而非 decision.ts，属**契约描述层与实现层的小幅不一致**——decision.ts 里 tier 字面量与本次 handleBash 修改保持同步，无代码改动但契约层 spec delta 已覆盖）；`extension-orchestration`（handleBash / promptUser / handlePromptDecision）；`side-effects` 不涉及。**新增**：`src/lib/sensitive.ts` 的 anchor 字段引入把 `policy-core` 的规则数据从"纯规则"扩展为"规则 + 锚点索引"，是**接口加宽而非分系统归属变更**。 |
| 整体性能预期变化：无 IO / 无异步新增；`mergePolicies` e1 校验 ≈ 配置条目数 × 锚点数（≤ 20），会话初始化一次性执行 | 实际：符合预期。锚点数最终为 **24**（略高于估 20，仍在同一数量级）；e1 校验在 mergePolicies 末尾单次遍历；无新增 IO / 无运行时开销。审计日志 warning 未落盘（仅 `ctx.ui.notify`，不落 JSONL——符合预期"若触发"语义，实际 warning 不进 audit，仅 UI 提示）。 |
| 这是局部优化还是全局协调：**全局协调** | 实际：确认是全局协调。A1/A2 的 tier 语义收敛跨 access-decision / approval-flow / grant-memory / bash-target-extraction 4 个 capability spec；A4 的 warning 落 permission-config 新 requirement 且 anchor 派生机制跨 sensitive.ts / config.ts 两个模块。**局部协调的边界**：A4 的 warning 呈现层（`ctx.ui.notify`）在 extension 而非 policy-core，属**已有承接路径**——既有 config warning（unknown permission 等）已在此路径，未新增架构入口。 |
| 如果是局部优化，对全局失调的风险：不适用 | 不适用（本次是全局协调）。**事后回检**（主基调第 1 条）：本 change 是否引入新的"局部最优全局失调"风险？——**是**，一条：**warning flood 边界**。若用户配置多个通配（如 20 条各覆盖 5 锚点），会产生 20+ 条 warning 刷屏 UI。已在 proposal A4 边界节明确标注并落入后续 `warning-batching` change 处理（`openspec/todo.md` B3 条目）。此为已知接受边界，非隐性失调。 |
| 预期行为模型（4 契约） | 见下方逐契约验证。 |

### 模型验证（4 契约逐一）

| 契约 | 验证方式 | 结果 |
|---|---|---|
| 契约 1：tier 语义一致（tier=three 含 Always allow / tier=two 不含） | `extensions/index.test.ts` AF1-A1（unreliable bash 4 选项）、AF2-A1（bash grant persist）、既有 AFS1/AFS2（副文本分派） | **通过**。apply 前实际行为已经是 4 选项（tier=two + bashReason 隐式分支），本次改动是**语义收敛**：把隐式分支迁移到 tier=three 显式分支，用户可见行为不变。 |
| 契约 2：SSH 公钥降级 soft / 私钥仍 hard | `test/sensitive.test.ts` 新增 7 条断言：id_rsa/known_hosts/authorized_keys/config/aws config 分类 | **通过**。`findSensitiveMatch("~/.ssh/known_hosts").level === "soft"`、`findSensitiveMatch("~/.ssh/authorized_keys").level === "soft"`、`findSensitiveMatch("~/.ssh/id_rsa").level === "hard"` 等全部断言通过；ordering invariant 保持（soft 规则追加于所有 hard 之后，`~/.aws/config.json` 仍 hard）。 |
| 契约 3：unreliable bash 弹窗 tier=three + Always allow + bashGrants 持久化 | 端到端 smoke test（`/tmp/smoke-tier-consistency.ts` item1）：`cat $SECRETS` → 4 选项 → 选 Always allow → `trusted.json.bashGrants` 含 rawCommand + commandHash + author=by_person | **通过**。bashGrants 段写入正确，author=by_person（真人批准），reason="unresolved variable: SECRETS"。 |
| 契约 4：配置加载期通配覆盖 warning | 12 条 PC-WARN-A4 测试 + 端到端 smoke test item2：`{~/.ssh/**: read_write}` → 1 warning 含 pattern + source + 锚点样本 + 权限 | **通过**。锚点派生 24 条 ≥ 20 阈值，全部 hard 规则有 anchor，soft 规则无 anchor。P1-1 关键验证（projectRoot=homedir + `**` → warning）通过。P2-4 语义（多 source 同 pattern → 1 条合并 warning）通过。 |

**模型验证结论**：4 契约全部验证通过，预期行为模型成立。

### 预期之外的副作用

1. **A1 实际是"契约收敛"而非"bug 修复"**——proposal 描述"tier=two 无持久化"与实际不符：apply 前代码里的 tier=two + bashReason 隐式分支**已提供 4 选项含 "Always allow"**。此次改动是**代码整洁**（隐式分支 → 显式 tier=three 分支），用户可见行为前后一致。此偏差已记录，不修正 proposal 的历史叙述（避免时间线错位），但 archive 复盘如实标注。
2. **anchor 精度边界**：私有 key 扩展名仅覆盖 `.pem` / `.key` 两条锚点（`.pfx`/`.p12`/`.jks`/`.kdbx`/`.asc`/`.gpg` 无锚点），已接受为设计边界。`HARD_SENSITIVE_ANCHORS` 派生机制未来加锚点只需在 rule 的 anchor 数组里追加，无需改 config.ts——机制可扩展。
3. **P2-4 语义修正**：多 source 同 pattern 从"每 source 1 条 warning"改为"1 条合并 warning"——本 change 内 proposal 与 spec 已同步，无 baseline 破坏。
4. **spec delta 同步范围**：本 change 修改 `openspec/specs/{access-decision,approval-flow,grant-memory,permission-config,bash-target-extraction}/spec.md` 五个主 spec（通过 archive sync 落地），bash-target-extraction 是**纯文本修改**（tier=two → tier=three 在 5 处 scenario/requirement 引用），不引入新 requirement/scenario，行为契约不变——符合 A3-4 任务定义。

### Scenario → test 覆盖账本

本 change 未生成正式 scenario→test 账本（未走 td-propose 的账本产出流程），改为按契约粒度记录覆盖：

- 契约 1（tier 语义）：3 条测试覆盖（AF1-A1, AF2-A1, AFS2）
- 契约 2（sensitive 分级）：7 条测试覆盖（test/sensitive.test.ts 新增）
- 契约 3（bash grant）：2 条测试覆盖（AF1-A1, AF2-A1）+ 1 条端到端 smoke
- 契约 4（warning）：12 条测试覆盖（test/config.test.ts 新增）+ 1 条端到端 smoke

**测试数量**：新增 24 条测试，全部 GREEN。既有 612 条测试全部保持 GREEN（AL7 flake 1/3 run 已确认非本 change 引入）。

### 未使用的 F2 缓冲槽位

3 个 F2 触发式缓冲槽位**均未触发**（A1/A2/A4/F 推进顺利，无跨分系统接口未对齐问题）。缓冲机制有效——预留但未消耗。

