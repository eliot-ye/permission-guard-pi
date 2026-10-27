## Why

当前 `Decision.kind: "auto_allow"` 与 `AuditRecord.event` 无法回答一个基本审计问题：**"这次放行是谁授权的？"** 配置命中、allow 规则命中、grant memory 命中在类型系统里被压成同一个 `auto_allow`，只有 `allow_*` 事件（真人弹窗选择）隐含了真人信号但没结构化。atomcode 2026-09-16 修的相关 bug（`[permissions] allow` 曾被误当真人同意，能抬开 CredentialShell 边界）证明：一旦引入凭据外发 / 更敏感的 shell 逃逸通道，"规则命中"与"真人授权"混淆会直接演化成安全漏洞。本项目目前 4 个工具、无 CredentialShell 层，当前收益偏窄，但语义漂移风险是真实的——这是**防御性建模**，把类型系统的分类能力提前补齐，让未来引入敏感通道时不需要追溯性地重构。

## What Changes

- **BREAKING（`Decision` 公共契约）**：`Decision` 类型新增 `authorization` 字段（可选，仅在 `kind === "auto_allow"` 且授权来源可判定时有值）。取值：
  - `"presumed"`：系统/规则/记忆判定，非真人授权。含 `presumed` 派生（`grant_memory` / `config_declaration` / `allow_rule` / `default`）四档细分
  - `"by_person"`：真人主动授权（仅从弹窗 choice 派生，不来自 `decide()` 内部）
- **`AuditRecord` 双字段加宽**：新增 `authorization`（`"presumed" \| "by_person" \| undefined`）+ `grant_source`（`"config_declaration" \| "allow_rule" \| "grant_memory" \| "bash_grant_memory" \| "default" \| undefined`）；向后兼容，旧日志缺省
- **`Grant` / `BashGrant` 全链路**：新增 `author: "by_person" \| "presumed" \| "migration"` 字段；既有 trusted.json 里所有存量条目在读取时**默认迁移为 `author: "by_person"`**（历史上唯一写入路径是真人弹窗），无需破坏性迁移
- **extension 层回填策略**：`handlePromptDecision` 里 choice→`by_person`；`decideTarget` 里 grant memory 命中→`by_person`（Grant 自带 `author` 字段，直接透传）；`decide()` 内部的 auto_allow 由 `declaration` + 触发路径派生 `authorization` + `grant_source`
- **access-decision spec 增加"授权来源分类" requirement**：定义 authorization 派生规则
- **audit-log spec 增加"授权字段" requirement**：定义两个新字段的写入契约与向后兼容策略
- **grant-memory spec 增加"Grant 记录 author" requirement**：定义写入路径、迁移策略、撤销语义不变量

非目标（明确 out of scope）：
- 不引入 CredentialShell / 凭据外发通道（未来工作，本次只为其预留类型能力）
- 不改变现有 tier 弹窗、grants、audit log 的任何既有行为——纯粹是"加宽字段 + 派生逻辑"
- 不新增 hook 机制（`installPromptGuardrails` 是 system prompt 注入，非决策 hook）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `access-decision`: `Decision` 类型新增 `authorization` 字段，定义派生规则（哪些触发路径映射到哪些授权来源值）
- `audit-log`: `AuditRecord` 新增 `authorization` + `grant_source` 字段，定义写入契约与向后兼容（旧日志无字段，读取时视为 `undefined`）
- `grant-memory`: `Grant` / `BashGrant` 新增 `author` 字段；定义 trusted.json 存量数据迁移策略（读取时 `undefined` → 默认 `by_person`）与"撤销语义不变"约束

## Impact

- **代码**：
  - `src/lib/decision.ts`：`Decision` 类型加宽（`DecisionCommon` 或每个 `kind` 分支加 `authorization`）；`decide()` 内部各 return 分支派生 `authorization`
  - `src/lib/audit.ts`：`AuditRecord` 加 `authorization` + `grant_source` 字段
  - `src/lib/trust.ts`：`Grant` / `BashGrant` 加 `author` 字段；`createTrustStore` 读取持久化时做默认迁移（`undefined → "by_person"`）
  - `extensions/index.ts`：`decideTarget` / `handlePromptDecision` 回填 authorization；所有 `audit.log({...})` 调用点补字段
- **数据**：`~/.pi/agent/extensions/permission-guard-pi/trusted.json`——存量条目读取时自动迁移（无磁盘写入，纯内存视图迁移）；首次持久化写入时会带上新字段
- **审计消费者**：`permission-review.jsonl` 新增字段，旧消费者按"忽略未知字段"兼容
- **测试面**：`test/decision.test.ts`、`test/audit.test.ts`、`test/trust.test.ts`、`extensions/index.test.ts` 均需补断言；`bash-extract.test.ts`、`sensitive.test.ts`、`config.test.ts` 无关

### caller impact 分析

- **变更点清单**：
  - ① `Decision` 公共类型（`src/lib/decision.ts`）—— 属 ① 类（公共符号）
  - ② `AuditRecord` 公共类型（`src/lib/audit.ts`）—— 属 ① 类
  - ③ `Grant` / `BashGrant` 公共类型 + `createTrustStore` 持久化读写（`src/lib/trust.ts`）—— 属 ①③ 类（公共符号 + 装配点，因为持久化读写是磁盘契约）
  - ④ `extensions/index.ts` 内部回填逻辑—— 属 ④ 类（内部实现）
- **高危标记**：①②③ 均为高危。但**变更类型是"加宽"而非"收窄"**：
  - `Decision.authorization` 是可选字段，`decide()` 返回类型 `Decision` 的所有既有消费者无需改动即可编译（可选字段缺失合法）
  - `AuditRecord` 是**输出契约**（追加日志），新增可选字段对消费者向后兼容
  - `Grant.author` 通过 `createTrustStore` 内部迁移，外部消费者（`extensions/index.ts`）只需在写入 `Grant` 时补字段，读取路径无感
- **已知 caller**：
  - `decide()` 被 `extensions/index.ts:739` 调用（1 处，直接消费返回值）—— 兼容，无需改
  - `AuditRecord` 被 `extensions/index.ts` 中 `handleFileTool`（L652-665）、`handleBash`（多分支）、`handlePromptDecision`（L804-991）产出 —— 兼容（新字段可选），需补齐字段
  - `Grant` 由 `extensions/index.ts:895` 与 `addBashPersistentGrant`（L944）产出 —— 需补 `author` 字段
  - `test/*.test.ts` 中的对象字面量断言 —— 需按新字段更新（非兼容性问题，是断言更新）

本 change 是"字段加宽 + 派生逻辑 + 存量迁移"的组合，不含"收窄"或"删除"，属于**加宽兼容型**变更（`permission-config-rules-upgrade` change 已建立此模式的先例：加 `rules` 字段而不删 `paths`）。

### 系统工程影响评估

- **影响哪些分系统**：
  - `policy-core`（tier-medium）：`decision.ts` 类型加宽、`trust.ts` 类型加宽 + 迁移逻辑
  - `extension-orchestration`（tier-small）：回填 authorization、audit.log 调用点补字段
  - `side-effects`（tier-small）：`audit.ts` 类型加宽
- **整体性能预期变化**：无行为变化（`decide()` 是纯函数，`authorization` 派生是同步的字段派生，无 IO、无异步）。审计 JSON 每行多 1-2 个字段（约 30-60 字节/行），日志文件略膨胀，量级可忽略
- **这是局部优化还是全局协调**：**全局协调**——本次改动触及 policy-core 与 side-effects 两个分系统，且是跨分系统的**类型契约升级**（Decision 类型跨 policy-core → extension-orchestration → side-effects 三处）。虽然是加宽型，但不做全局协调（例如只改 `Decision` 不改 `AuditRecord`）会造成"决策层能区分但审计层写不出"的分裂，反而制造局部最优、全局失调
- **如果是局部优化，对全局失调的风险**：不适用（本次是全局协调，非局部优化）
- **预期行为模型**：
  - **可验证契约 1**：`decide()` 返回的每个 `auto_allow` 决策都带 `authorization` 与 `grant_source` 字段；返回的 `deny_hard` / `prompt` 不带这两个字段（`undefined`）
  - **可验证契约 2**：真人从弹窗选择的每次调用，`AuditRecord` 落盘时 `authorization === "by_person"`
  - **可验证契约 3**：`allow` 规则命中与配置声明命中导致的 `auto_allow`，`AuditRecord.authorization === "presumed"` 且 `grant_source` 分别为 `"allow_rule"` 与 `"config_declaration"`
  - **可验证契约 4**：既有 trusted.json（不含 `author` 字段）读取后，`Grant.author === "by_person"`（迁移默认）；首次持久化写入时 `author` 字段出现且值为 `"by_person"`（当前唯一写入路径是真人弹窗）
  - **可验证契约 5**：本次改动前后，所有既有测试用例的**授权判定结果**不变——只多了字段，不改决策结果
  - 验证方式：`node --experimental-strip-types --test test/`，新增针对上述 5 条契约的测试用例（T1-T5），既有测试无需修改断言值只补字段
- **与既有架构/风格的遵循关系**：
  - **遵循**：`src/lib/*.ts` 无 IO 纯函数的分层不变；`AuditRecord` 追加字段的模式与 `permission-config-rules-upgrade` 的"加宽兼容"先例一致；trusted.json 迁移通过读取时默认赋值而非磁盘重写，符合 grant-memory spec 里"缺失文件视为空 grants"的宽容哲学
  - **不偏离既有架构/风格**：无偏离点。本次不涉及新的分系统切分、不引入新模块、不改变错误处理模式

## 实际系统工程影响 vs 预期

对照上方"系统工程影响评估"节的五个字段，逐项复盘实际执行结果。

| 字段 | 预期 | 实际 |
|---|---|---|
| **影响哪些分系统** | policy-core（decision.ts + trust.ts）、extension-orchestration（extensions/index.ts）、side-effects（audit.ts） | 与预期一致。实际改动文件：`src/lib/decision.ts`（+47 行）、`src/lib/audit.ts`（+9 行）、`src/lib/trust.ts`（+64 行）、`extensions/index.ts`（+66 行）。无跨分系统外溢。 |
| **整体性能预期变化** | 无行为变化；审计 JSON 每行多 30-60 字节，量级可忽略 | 与预期一致。`decide()` 是纯函数同步字段派生，无 IO 增量；实测测试套件耗时从 1037ms（baseline 571 tests）增至 1634ms（595 tests），增量来自新增测试数量而非生产路径性能回退。 |
| **局部优化还是全局协调** | 全局协调（跨 policy-core + side-effects 的类型契约升级） | 与预期一致。三个 spec 同时升级 + extension 层回填 + audit 字段加宽，是一个全局协调动作。若只改 `Decision` 不改 `AuditRecord`，会造成"决策层能区分但审计层写不出"的分裂。 |
| **预期行为模型验证** | 5 条可验证契约（见"系统工程影响评估"节） | 全部验证通过：① decide() auto_allow 带 authorization+grant_source ✓（T-DEC-1~8）；② 真人弹窗 audit.authorization === "by_person" ✓（T-EXT-P1/P2/P3）；③ allow_rule/config 命中 presumed ✓（T-DEC-1/2/3）；④ 既有 trusted.json 迁移为 by_person ✓（T-TRUST-LA-3/M2/M3/W3）；⑤ 既有测试授权判定结果不变 ✓（baseline 571 全绿 → 595 全绿，无断言值变更） |
| **与既有架构/风格的遵循关系** | 遵循无偏离 | 与预期一致。`src/lib/*.ts` 仍无 IO（trust.ts 的 fs 调用仅限持久化路径）；无新增模块；错误处理模式不变。 |

### 预期之外的副作用

- **W1 发现（review 提出，已修）**：bash 侧 2 处 `hard_deny` audit.log 初始未补 `authorization: "presumed"`，与 README "guaranteed" 声明冲突。修复代价极低（2 行字段补齐），但暴露了 review 检查盲区——handleBash 的 audit.log 调用点分散在 3 层（grant hit / unread 兜底 / deny rule），初稿只覆盖了 handleFileTool 的对应位置。→ **教训**：未来类似"全路径补字段"change，应先用 `grep audit.log` 枚举所有调用点再动手。
- **T-TRUST-W3 语义偏差**：原计划验证"legacy entry 磁盘上保留无 author"，实际发现 `atomicWrite` 是全量重写语义——内存迁移后的 legacy entry 带 author 一起落盘。修正了测试期望（不是代码问题，是理解问题）。spec 里"磁盘上仍无 author"的描述只在"不写入"场景下成立，"写入"场景下全量覆盖是正确行为。

### scenario→test 覆盖账本状态

**全绿**。33 个测试用例全部映射到具名测试，0 unmapped、0 N/A。覆盖范围：
- access-decision spec 9 scenario → T-DEC-1~8 + T-EXT-G1
- audit-log spec 6 scenario → T-EXT-P1/P2/F2/P3 + T-AUDIT-BACKCOMPAT
- grant-memory spec 6 scenario → T-TRUST-LA-1~6 + T-TRUST-W3 + T-TRUST-M3 + T-TRUST-M2
- 集成验证 5 grant_source + 7 event → T-EXT-B1 + T-EXT-G1 + T-DEC-1~8
