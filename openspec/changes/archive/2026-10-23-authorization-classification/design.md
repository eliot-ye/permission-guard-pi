## Context

当前 `Decision`（`src/lib/decision.ts:39-49`）是三分支 discriminated union：`auto_allow | deny_hard | prompt`，`auto_allow` 内部不区分授权来源。`AuditRecord`（`src/lib/audit.ts:36-53`）有 `event`（7 个值）+ `declaration`（5 个值）字段，能表达"事件类型"和"声明类型"，但不能表达"谁授权的"。`Grant` / `BashGrant`（`src/lib/trust.ts:51-70`）无 author 字段。

授权来源的**运行时事实**：
- 真人授权发生地：`extensions/index.ts:handlePromptDecision`（L753-992），choice 值 → `UserChoice` = `"allow_once" | "allow_session" | "allow_persistent" | "deny"`
- 系统派生授权发生地：`decide()` 内部各 return 分支 + `decideTarget()`（L691-749）中的 grant memory 命中检查
- 持久化写入发生地：`extensions/index.ts:895`（`addPersistentGrant`）+ `L944`（`addBashPersistentGrant`）—— 两条路径都是真人弹窗

历史参考：atomcode `events.rs:211-236` 的 `Authorization::Presumed | ByPerson` 分类法（内部设计参考，不声明依赖）。

## Goals / Non-Goals

**Goals:**
- 在类型系统里显式区分 `Presumed`（规则/记忆/默认）与 `ByPerson`（真人弹窗）
- 让审计消费者**无需读 note 字段**即可回答"这次放行是谁授权的"
- 让 trusted.json 未来的迁移/导入路径能追溯 author（防御性建模）
- 加宽兼容：既有审计消费者忽略新字段即可，无需升级

**Non-Goals:**
- 不引入 CredentialShell 或凭据外发通道（未来工作）
- 不改变任何授权判定结果——只加字段，不改语义
- 不新增 hook 机制或决策前置管道
- 不重写现有 trusted.json（迁移在读取时进行，不改磁盘）
- 不实现"config-based auto-grant"路径（当前唯一写入路径是真人弹窗，本 change 只保留类型能力）

## Decisions

### D1. `Decision` 类型的字段放置

**决策**：在 `Decision` 联合类型的每个 `kind: "auto_allow"` 分支上加 `authorization` + `grant_source`（必填，非可选）。`deny_hard` 与 `prompt` 分支不带这两个字段。

```ts
type Authorization = "presumed" | "by_person";
type GrantSource = "config_declaration" | "allow_rule" | "grant_memory" | "bash_grant_memory" | "default";

type Decision =
  | (DecisionCommon & {
      kind: "auto_allow";
      authorization: Authorization;
      grant_source: GrantSource;
    })
  | (DecisionCommon & { kind: "deny_hard"; denial: { reason: string } })
  | (DecisionCommon & { kind: "prompt"; tier: PromptTier; conflict?: boolean });
```

**理由**：
- 只在 `auto_allow` 上必填，因为 `deny_hard`（系统拒绝）与 `prompt`（还没决定）**不是授权事件**，不该标 authorization。把 authorization 放 `DecisionCommon` 会导致"系统拒绝"与"系统认为你已被授权"歧义
- 在 `auto_allow` 上**必填**（非可选），迫使 `decide()` 内部所有 auto_allow return 分支都派生字段——防止"以后忘加"的语义漂移
- `grant_source` 与 `authorization` 是**冗余但显式**的一对：`authorization` 是二分粗粒度，`grant_source` 是细分来源。冗余是为了审计消费者按需查询——二分过滤用 `authorization`，细分分析用 `grant_source`。atomcode 的 `Authorization` 只有二值，我们加细一档

**替代方案**：
- ❌ 只在 `DecisionCommon` 上加可选字段 → 语义歧义，deny_hard 也会被误标
- ❌ 只加 `grant_source`，不加 `authorization` → 二分粗过滤（"是真人授权吗？"）需要消费者自己做映射，把逻辑外溢到消费者
- ❌ 只加 `authorization`，不加 `grant_source` → 无法回答"具体哪条规则命中"这类细分审计问题

### D2. `authorization` 的派生规则

派生规则分两个作用域：**D2a `decide()` 内派生**（policy-core 内部，`src/lib/decision.ts`）与 **D2b extension 层回填**（`extensions/index.ts`）。这个划分与 `access-decision/spec.md` 的"语义约束"段一致——`decide()` 是纯函数，无法感知真人弹窗，因此它内部的 auto_allow **恒为 `presumed`**；真人授权信号只从 extension 层的弹窗选择或 grant memory 命中回填。

**D2a. `decide()` 内派生（`src/lib/decision.ts`）**

| 触发路径 | `authorization` | `grant_source` |
|---|---|---|
| L84-108：`entry.permission === "read_only"` 且 `action === "read"` → auto_allow | `presumed` | `config_declaration` |
| L132-140：`entry.permission === "read_write"` 且 `isInside` → auto_allow | `presumed` | `config_declaration` |
| L160-171：`policy.resolveRule(...)` 返回 `action: "allow"` 且非敏感 → auto_allow | `presumed` | `allow_rule` |
| L218-226：`isDefaultTmpPath` 兜底 → auto_allow | `presumed` | `default` |
| L229-237：项目内非敏感未配置 → auto_allow | `presumed` | `default` |
| L241-249：项目外非敏感读 → auto_allow | `presumed` | `default` |

`decide()` 返回的 `deny_hard` 与 `prompt` 分支**不带**这两个字段（见 D1）。

**D2b. extension 层回填（`extensions/index.ts`）**

| 触发路径 | `authorization` | `grant_source` |
|---|---|---|
| `decideTarget()` L728-736：path-based grant memory 命中（persistent）→ auto_allow | 由 Grant.author 决定 | `grant_memory` |
| `decideTarget()` L728-736：path-based session grant 命中 → auto_allow | `by_person` | `grant_memory` |
| `handleBash()` 内 bash grant memory 命中（persistent）→ auto_allow | 由 BashGrant.author 决定 | `bash_grant_memory` |
| `handleBash()` 内 bash session grant 命中 → auto_allow | `by_person` | `bash_grant_memory` |
| `handlePromptDecision` 里 choice ∈ {`allow_once`, `allow_session`, `allow_persistent`} → 本次调用放行 + audit 落盘 | `by_person` | （见 D4） |
| `handlePromptDecision` 里 choice === `deny` 或冲突弹窗拒绝 → 本次调用被拒 + audit 落盘 | `by_person` | （见 D4） |

**关键约束**：
- `decide()` 内的 auto_allow 恒为 `presumed`——这是防御性的（防止未来有人在 `decide()` 里误写 `by_person`）
- **persistent** grant memory 命中的 auto_allow 由 Grant 自身的 `author` 字段决定——当前所有持久化 grant 都是真人弹窗写入，实际都是 `by_person`；类型能力保留未来扩展（若加了 config-based auto-grant 写入路径，可标 `presumed`）
- **session** grant 命中恒为 `authorization: "by_person"`——session grant 是真人会话内选择"允许本会话"时写入的（`extensions/index.ts:858-867`），语义天然 by_person；`TrustStore` 的 session grant 存储在 `Set<string>`（`src/lib/trust.ts:156`）里没有 author 字段，无法从 Grant 元数据派生，只能按写入路径语义恒定
- `bash_grant_memory` 与 `grant_memory` 分开——bash 命令授权走独立键空间（`bash-extract` 提取），审计上要能区分

### D3. `AuditRecord` 的字段与写入

**决策**：加两个可选字段，兼容旧日志。字段类型**不重复定义**，通过 `import type` 从 `decision.ts` 引用（与 D7 对齐——单一真值源）：

```ts
import type { Authorization, GrantSource } from "./decision.ts";

export interface AuditRecord {
  // ... 既有字段不变 ...
  authorization?: Authorization;
  grant_source?: GrantSource;
}
```

**关键约束**：`type` import 编译后完全消失，不违反 `audit.ts` 的"纯模块（except for fs）"边界（`src/lib/audit.ts:1-8`）。若未来需要 `audit.ts` 独立于 `decision.ts` 存在，可把 `Authorization` / `GrantSource` 抽到 `src/lib/authorization-types.ts`（备选方案，本次不采用——改动更大，且当前 `audit` 与 `decision` 同属 side-effects / policy-core 两个分系统但都在 `src/lib/` 下，`type` import 不会造成运行期循环依赖）。

**决策**：`event` 与 `authorization` 的映射规则：

| `event` | `authorization` | 理由 |
|---|---|---|
| `allow_once` | `by_person` | 真人弹窗选择"允许一次" |
| `allow_session` | `by_person` | 真人弹窗选择"会话内允许" |
| `allow_persistent` | `by_person` | 真人弹窗选择"总是允许" |
| `deny` | `by_person` | 真人弹窗选择"拒绝"——虽然是拒绝，但**是真人做出的决策**，标 `by_person` |
| `conflict_prompt` | `by_person` | 真人从冲突弹窗拒绝 |
| `hard_deny` | `presumed` | 系统硬拒绝（`unread` 或 deny 规则命中），无人参与 |
| `auto_allow` | 视触发路径而定（见 D2） | 大部分是 `presumed`（配置/规则/默认/记忆），少数是 `by_person`（记忆命中且 Grant.author=by_person） |

**关键约束**：
- `deny` / `conflict_prompt` 标 `by_person` 有争议（"拒绝"是授权吗？）——**决策**：`authorization` 字段语义是"**谁做了这个决策**"，不是"是否授予了权限"。真人拒绝也是真人决策，标 `by_person`；否则审计消费者无法区分"系统自动拒绝"和"真人拒绝"
- 旧日志（无 `authorization` 字段）在读取时视为 `undefined`，消费者应回退到 `event` 字段做兼容判断

### D4. `AuditRecord` 里 `grant_source` 的派生（真人授权场景）

真人弹窗授权时，`grant_source` 表示"这次真人授权**基于什么来源触发**"：

| 弹窗触发的 Decision.declaration | `grant_source` |
|---|---|
| `read_write` / `read_only` / `sensitive_default` | `config_declaration` 或 `default`（视是否配置） |
| `unconfigured` 且路径敏感 | `default` |
| `unconfigured` 且 bash 命令 | （无对应值——bash 命令授权走独立的 `bash_grant_memory` 写入路径，本次记录 `grant_source` 缺省） |

**理由**：真人授权事件里，"授权来源"更多表示"这次弹窗是为什么弹的"，而不是"真人从哪授权的"（真人就是真人）。这让审计消费者能回答"真人授权主要发生在什么场景"。

### D5. `Grant` / `BashGrant` 的 `author` 字段与迁移

**决策**：

```ts
export type GrantAuthor = "by_person" | "presumed" | "migration";

export interface Grant {
  // ... 既有字段不变 ...
  author?: GrantAuthor;  // 可选，兼容旧 trusted.json
}

export interface BashGrant {
  // ... 既有字段不变 ...
  author?: GrantAuthor;
}
```

**迁移策略**：**读取时默认赋值**，不改磁盘。

在 `createTrustStore` 的持久化文件加载逻辑（`src/lib/trust.ts:137-153`）里，把加载出来的 grants 数组每一项补默认值：

```ts
persistentGrants = parsed.grants.map((g) => ({ ...g, author: g.author ?? "by_person" }));
persistentBashGrants = parsed.bashGrants.map((g) => ({ ...g, author: g.author ?? "by_person" }));
```

**理由**：
- 存量 trusted.json 中所有条目的**唯一写入路径是真人弹窗**（`handlePromptDecision` L895 / L944），因此默认迁移为 `by_person` 是**语义正确**的（不是"猜"）
- `author: "by_person"` 而非 `"migration"`——因为迁移结果**语义等价于真人授权**，标 `"migration"` 会让消费者以为这些条目不是真人授权的（语义漂移）
- 保留 `"migration"` 值是为了未来如果有跨版本可信性变化（例如未来发现某个旧版本有 bug 会误写 grant）时能标记"这些是通过迁移来的，可信性存疑"

**首次持久化写入时会带上 `author` 字段**（值 = 写入路径的语义）。当前唯一写入路径是 `handlePromptDecision` → `addPersistentGrant`，所以写入的 `author` 恒为 `"by_person"`。

### D6. 撤销语义不变量

**决策**：本 change **不改变任何撤销语义**。

现有撤销路径（`grant-memory` spec）：
- 会话级：`session_start` 清空 Map
- 持久化：用户手动编辑 `trusted.json`

新增 `author` 字段后：
- 撤销时**不需要**检查 author——真人 vs 规则命中的撤销权限不变（当前 spec 未区分，本 change 也不引入区分）
- 未来如果需要"真人授权的 grant 可以被规则撤销"或"规则命中的 grant 不能撤销"这类精细撤销，是**未来工作**（本 change 只保留类型能力）

### D7. 代码组织结构

- `Authorization` / `GrantSource` / `GrantAuthor` 三个类型定义**分别放在各自模块**：
  - `Authorization` + `GrantSource` 在 `src/lib/decision.ts`（因为它们是 `Decision` 类型的组成部分）
  - `GrantAuthor` 在 `src/lib/trust.ts`
- `AuditRecord` 引用 `Authorization` / `GrantSource` 时通过 `import type`，不重新定义
- 派生规则**集中在 extension 层**（`extensions/index.ts`），不进入 `src/lib/`——因为真人授权信号只在 extension 层可见

**理由**：类型就近定义，避免 `decision.ts` 反过来 import `audit.ts`（会破坏纯函数模块的边界）。

### D8. 测试策略

**决策**：TDD 顺序（`systematic-debugging` + `test-driven-development` 要求 RED-GREEN-REFACTOR）：

1. **RED**：先写失败测试（新增 test case，既有测试的断言值不变，只补字段）
2. **GREEN**：实现类型加宽 + 派生逻辑，让新测试通过
3. **REFACTOR**：如有重复代码收敛

新增测试面：
- `test/decision.test.ts`：`decide()` 返回的每个 auto_allow 都带 `authorization` + `grant_source`；`deny_hard` / `prompt` 不带
- `test/trust.test.ts`：`createTrustStore` 读取无 `author` 字段的存量文件后，内存中的 grants 都带 `author: "by_person"`；`addPersistentGrant` 写入时带 `author` 字段
- `test/audit.test.ts`：`createAuditLogger` 支持带 `authorization` + `grant_source` 字段的记录写入
- `extensions/index.test.ts`：`handlePromptDecision` 各种 choice → audit 记录的 `authorization === "by_person"`；`handleFileTool` 命中 grant memory 时 `authorization` 由 Grant.author 决定

**理由**：TDD 是本项目的既有开发方法（`config.yaml` 里明确写"TDD（RED-GREEN-REFACTOR，测试先于实现）"），本次不例外。

## Risks / Trade-offs

- **[风险] trusted.json 存量数据的 author 默认赋值假设**：假设"当前唯一写入路径是真人弹窗"，如果这个假设有漏洞（例如发现某个早期版本有 bug 会误写 grant），迁移策略会误标。→ **缓解**：保留 `GrantAuthor` 类型的 `"migration"` 值，未来发现漏洞时可以通过一次性的可信性修复脚本把可疑条目标 `"migration"`。当前不做，因为无证据表明有 bug
- **[风险] 消费者依赖 `event` 字段做二分判断**：如果既有审计消费者假设"`event: "allow_*"` 就是真人授权"，本次改动后消费者需要额外判断 `authorization`（例如 `event: "allow_persistent"` 但现在也可能有 `event: "allow_persistent" && authorization: "presumed"`——**等等，这不可能发生**，因为 `allow_persistent` 只在真人弹窗时产生）。→ **缓解**：本 change 的 `event` → `authorization` 映射是**确定的**（真人弹窗事件 → `by_person`，系统事件 → `presumed`），消费者无歧义
- **[风险] AuditRecord 字段膨胀**：新增 2 个可选字段后，日志 JSON 每行多 30-60 字节。长期运行下的日志文件会略膨胀。→ **缓解**：量级可忽略；且审计消费者按字段查询是必需的，无法用 note 字段 workaround（note 是自由文本，不结构化）
- **[风险] 类型加宽后既有测试的严格断言失败**：如果既有测试用**结构化等值断言**（`expect(decision).toEqual({...})`）而非字段级断言，新增字段会导致测试失败。→ **缓解**：这是可预期的测试更新成本；且测试失败会**明确指示**哪些用例需要补字段，不会静默
- **[权衡] `authorization` 是二分 vs 细分**：我们选择"二分 `authorization` + 细分 `grant_source`"两字段冗余，而不是"只用细分"或"只用二分"。冗余增加字段数，但让消费者按需查询。**接受**——审计场景下，可读性和冗余字段比字段数重要
- **[权衡] grant memory 命中的 authorization 由 Grant.author 决定 vs 恒为 by_person**：我们选择前者，为未来 config-based auto-grant 预留类型能力。**接受**——当前 Grant.author 恒为 `by_person`，两者当前无差别，但前者未来兼容

## Migration Plan

**部署步骤**（无停机需求，本扩展无服务端部署）：

1. 合并代码，发布 `@permission-guard/pi` 新版本
2. 用户升级 pi-extension 后：
   - **首次决策时**：`createTrustStore` 加载 trusted.json → 内存中 grants 补 `author: "by_person"`
   - **首次持久化写入时**：`addPersistentGrant` 写入带 `author: "by_person"` 的条目，磁盘文件更新
   - **既有审计日志**：保持原样（旧字段），新增记录带新字段
3. 存量 trusted.json 磁盘文件**无需用户操作**——首次写入自然会带上新字段

**回滚策略**：

- 类型加宽是**向后兼容**的（新字段可选，既有代码不感知）
- 如果发现问题需要回滚：
  - 代码回滚到旧版本 → trusted.json 里带 `author` 字段的条目被忽略（旧代码不读这个字段）
  - 新审计日志（带 `authorization` 字段）被旧审计消费者忽略（不认识的字段直接丢弃）
- **无破坏性数据迁移**——所有迁移都是内存视图，不改磁盘

**验证清单**：

- [ ] `node --experimental-strip-types --test test/` 全绿
- [ ] 手工触发一次真人弹窗 → 检查日志文件的 `authorization` 字段为 `"by_person"`
- [ ] 手工触发一次配置命中 auto_allow → 检查日志文件的 `authorization` 为 `"presumed"`、`grant_source` 为 `"config_declaration"`
- [ ] 手工触发一次 grant memory 命中 → 检查日志文件的 `authorization` 由 Grant.author 决定
- [ ] 用旧版本的 trusted.json 加载 → 内存中 grants 带 `author: "by_person"`（不报错）

## Open Questions

（无——本 change 的 scope 已由用户在 td-explore 阶段明确 a1=细分 / a2=双字段 / a3=全链路 / a4=直接 propose，所有关键决策点在 D1-D8 已定型。）
