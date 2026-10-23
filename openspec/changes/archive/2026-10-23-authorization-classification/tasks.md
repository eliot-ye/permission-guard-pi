# Tasks

## 计划元数据

- **关键链**：T1.1 → T1.2 → T2.1 → T2.2 → T3.1 → T3.2 → T4.1 → T4.2 → T4.3 → T4.4 → T5.1 → T6.1 → T7.1。
  类型加宽是核心路径：先加 `Decision` 类型 → 加 `Grant` 类型 + 迁移 → 回填 extension 层 → audit 字段 → 全链路测试 → 既有测试更新 → 文档收尾。
- **project buffer（tier-medium 表 1 比例 35%）**：关键链 13 个 task 单元估时 1.5-3 小时，35% buffer = **30-60 分钟时间池**，用于吸收类型派生遗漏或既有测试严格断言超预期的调整。buffer 不作为独立 task（CCPM 里 buffer 是"吸收不确定性的时间池"，不是"待办项"），实际消耗信号在 T5.1 / T6.1 的验证结果里体现：若 T5.1 需要跨到 T6.1 才能定位（既有测试断言失败范围超预期），即为 buffer 被消耗。
- **依赖**：T1.x → T2.x → T3.x → T4.x 强顺序（类型定义在前，回填在后）；T5.1 在 T4.x 全部完成后启动；T6.1 可与 T4.x 并行；T7.1 在 T5.1 完成后启动。

## 1. 类型定义（policy-core 分系统）

- [x] 1.1 在 `src/lib/decision.ts` 中定义 `Authorization` 与 `GrantSource` 类型，并把 `authorization` + `grant_source` 字段加到 `Decision` 联合类型的 `auto_allow` 分支（必填，非可选）——验证：`tsc --noEmit` 报错指出 `decide()` 各 return 分支缺失字段（RED 阶段），报错定位准确
- [x] 1.2 在 `src/lib/trust.ts` 中定义 `GrantAuthor` 类型，把 `author` 字段加到 `Grant` 与 `BashGrant` interface（可选字段）——验证：`tsc --noEmit` 通过（可选字段不破坏既有调用点）

## 2. `decide()` 内部派生（policy-core 分系统）

- [x] 2.1 给 `decide()` 的每个 auto_allow return 分支补 `authorization: "presumed"` 与对应的 `grant_source`：L84-108 read_only 读 → `config_declaration`；L132-140 read_write inner → `config_declaration`；L160-171 allow rule → `allow_rule`；L218-226 tmp 兜底 → `default`；L229-237 项目内非敏感 → `default`；L241-249 项目外非敏感读 → `default`——验证：`node --experimental-strip-types --test test/decision.test.ts` 既有 test case 全绿（既有测试只断言 kind/region/declaration 等既有字段，不感知新增字段），新增 test 覆盖 D2 派生表 6 个 auto_allow 路径
- [x] 2.2 在 `decideTarget()`（`extensions/index.ts:691-749`）中：unread hard-deny 分支（L716-725）不加字段；grant memory 命中分支（L728-736）改返回带 `authorization: <Grant.author>` + `grant_source: "grant_memory"` 的 Decision。**API 决策（已定）**：给 `TrustStore` 新增 `lookupGrantAuthor(projectHash, action, absPath): GrantAuthor | undefined` 方法（**新增方法，不改 `has*Grant` 签名**——避免波及 5 处 caller + 3 处既有测试；`has*Grant` 继续返回 boolean 表示"是否命中"，`lookupGrantAuthor` 补充"命中时作者是谁"）。返回语义：persistent grant 命中 → 返回 `Grant.author`（缺省视为 `"by_person"`）；session grant 命中 → 返回 `"by_person"`（D2b 明确 session 恒 by_person）；都未命中 → `undefined`。同理为 bash grant 新增 `lookupBashGrantAuthor(projectHash, rawCommand): GrantAuthor | undefined`——验证：新增 test 覆盖 D2 派生表中 "grant memory 命中带 by_person 授权"、"session grant 命中带 by_person"、"bash grant memory 命中派生 bash_grant_memory"、"unread 命中不带 authorization 字段" 4 个 scenario

## 3. Grant 持久化 + 迁移（policy-core 分系统）

- [x] 3.1 在 `src/lib/trust.ts` 的 `createTrustStore` 持久化加载逻辑（L137-153）中，把 `parsed.grants` / `parsed.bashGrants` 每项 map 一次补 `author ?? "by_person"`——验证：新增 test 覆盖 grant-memory spec 的"存量 trusted.json 无 author 字段加载"、"新版本 trusted.json 有 author 字段保留原值"、"迁移不触发磁盘写入"（通过 mock `fs.stat` 验证 trusted.json mtime 不变）3 个 scenario
- [x] 3.2 在 `addPersistentGrant` / `addBashPersistentGrant` 写入路径里，若传入的 grant 缺失 `author` 则默认补 `"by_person"` 后持久化——验证：新增 test 覆盖 grant-memory spec 的"真人弹窗选择总是允许时 Grant 记录 author"、"真人弹窗选择总是允许时 BashGrant 记录 author"、"首次持久化写入带上新字段" 3 个 scenario

## 4. extension 层回填（extension-orchestration 分系统）

- [x] 4.1 修改 `decideTarget()`（`extensions/index.ts:691-749`）grant memory 命中分支，通过 T2.2 增加的 TrustStore 查询能力拿到匹配的 grant author，派生 Decision 的 `authorization` + `grant_source` 字段——验证：新增 test 覆盖 extension 层集成"handleFileTool 命中 grant memory 时 authorization 由 Grant.author 决定"
- [x] 4.2 修改 `handleBash()`（`extensions/index.ts:474-624`）中 bash grant memory 命中分支，同样派生 `authorization` + `grant_source: "bash_grant_memory"`——验证：新增 test 覆盖 "bash grant memory 命中派生 bash_grant_memory"
- [x] 4.3 修改 `handlePromptDecision()`（`extensions/index.ts:753-992`）所有 `state.audit.log({...})` 调用点（共 7 处：deny / allow_once / allow_session / allow_persistent path / allow_persistent bash / session downgrade / bash downgrade），补 `authorization: "by_person"` 与按 D4 派生的 `grant_source`——验证：新增 test 覆盖 audit-log spec 的 "真人总是允许落日志带 by_person"、"真人拒绝也标 by_person"、"grant_source 字段可缺省" 3 个 scenario
- [x] 4.4 修改 `handleFileTool()`（`extensions/index.ts:628-681`）中 `deny_hard` 与 `auto_allow` 两条路径的 `state.audit.log` 调用点：`deny_hard` 补 `authorization: "presumed"`（`grant_source` 缺省），`auto_allow` 从 `decision.authorization` / `decision.grant_source` 透传——验证：新增 test 覆盖 audit-log spec 的 "系统硬拒绝标 presumed"、"auto_allow 从决策对象透传" 2 个 scenario

## 5. 端到端契约测试（跨分系统集成验证）

- [x] 5.1 在 `extensions/index.test.ts` 中新增端到端测试，覆盖 D2 派生表全部路径 + D3 event→authorization 映射表全部行——验证：`node --experimental-strip-types --test test/` 全绿，端到端用例覆盖 5 种 grant_source × auto_allow + 7 种 event × authorization 映射（见下方 scenario→test 覆盖账本 "集成验证" 段）

## 6. 既有测试更新（可与 T4 并行）

- [x] 6.1 更新 `test/decision.test.ts`、`test/audit.test.ts`、`test/trust.test.ts`、`extensions/index.test.ts` 中所有使用**结构化等值断言**（`toEqual` / `toStrictEqual` / 深度对比）的既有用例，把新增字段补进期望值——验证：`node --experimental-strip-types --test test/` 全绿；既有测试用例的**授权判定结果**（`kind` / `event` / `decision.tier`）断言值不变，只补字段

## 7. 文档与验证（收尾）

- [x] 7.1 在 `README.md` 中补充一小节说明"审计日志新增 authorization / grant_source 字段"，说明消费者向后兼容策略（旧字段缺省视为 undefined）——验证：README 新增小节存在，包含 D3 的 event→authorization 映射表；不改变 README 既有章节结构

---

## scenario→test 覆盖账本

**tier-medium 强制**（`td-propose` 6.c）。规则：每个 `#### Scenario:` 映射到一个具名测试或显式 N/A 说明。测试命名约定：T-DEC-*（decision.ts 单元）、T-TRUST-*（trust.ts 单元）、T-AUDIT-*（audit.ts 单元）、T-EXT-*（extensions/index.ts 集成）、T-E2E-*（端到端）。

### access-decision/spec.md（本 change 新增 requirement: "auto_allow 决策携带授权来源标注"）

| Scenario | 映射测试 | 备注 |
|---|---|---|
| 配置声明命中 read_only 读 auto_allow | T-DEC-1 | 覆盖 D2 派生表第 1 行 |
| 项目内 read_write 读写 auto_allow | T-DEC-2 | 覆盖 D2 派生表第 2 行 |
| allow 规则命中非敏感路径 | T-DEC-3 | 覆盖 D2 派生表第 3 行 |
| 项目内非敏感默认 auto_allow | T-DEC-4 | 覆盖 D2 派生表第 5 行 |
| /tmp 兜底 auto_allow | T-DEC-5 | 覆盖 D2 派生表第 4 行 |
| deny_hard 不带授权字段 | T-DEC-6 | 负向断言：`expect(decision).not.toHaveProperty("authorization")` |
| prompt 不带授权字段 | T-DEC-7 | 负向断言 |
| grant memory 命中带 by_person 授权 | T-EXT-G1 | 属 extension 层集成，非 decide() 单元 |
| bash grant memory 命中 | T-EXT-B1 | 属 extension 层集成 |

### audit-log/spec.md（本 change 新增 requirement: "审计记录携带授权来源标注"）

| Scenario | 映射测试 | 备注 |
|---|---|---|
| 真人"总是允许"选择落日志带 by_person | T-EXT-P1 | `handlePromptDecision` 里 `allow_persistent` 分支 |
| 真人"拒绝"选择也标 by_person | T-EXT-P2 | 语义争议点已定型在 D3：`authorization` 表示"谁做的决策" |
| 系统硬拒绝标 presumed | T-EXT-F2 | `handleFileTool` 里 `deny_hard` 分支 |
| auto_allow 从决策对象透传 | T-EXT-F1 | `handleFileTool` 里 `auto_allow` 分支 |
| 既有日志无字段向后兼容 | T-AUDIT-BACKCOMPAT | 构造一条无 `authorization` 字段的 JSON 行，验证读取/写入路径不报错 |
| grant_source 字段可缺省 | T-EXT-P3 | bash 弹窗授权事件场景 |

### grant-memory/spec.md（本 change 新增 2 个 requirement）

**Requirement: Grant 记录 author 字段**

| Scenario | 映射测试 | 备注 |
|---|---|---|
| 真人弹窗选择"总是允许"时 Grant 记录 author | T-TRUST-W1 | 通过 `addPersistentGrant` 写入，验证返回值/内存态含 `author: "by_person"` |
| 真人弹窗选择"总是允许"时 BashGrant 记录 author | T-TRUST-W2 | 通过 `addBashPersistentGrant` 写入 |

**Requirement: 存量 trusted.json 读取时迁移**

| Scenario | 映射测试 | 备注 |
|---|---|---|
| 存量 trusted.json 无 author 字段加载 | T-TRUST-M1 | 写一个不含 author 的 JSON 文件，`createTrustStore` 加载后检查内存态 |
| 新版本 trusted.json 有 author 字段保留原值 | T-TRUST-M2 | 写一个含 `author: "by_person"` 的 JSON 文件，加载后不覆盖 |
| 迁移不触发磁盘写入 | T-TRUST-M3 | 加载旧文件后不调用 `flush()`，验证 mtime 不变 |
| 首次持久化写入带上新字段 | T-TRUST-W3 | 加载旧文件后写入新 grant，读回磁盘文件，新条目带 author，旧条目不变 |

### 集成验证（跨分系统，T5.1 覆盖）

| 覆盖维度 | 映射测试 | 备注 |
|---|---|---|
| 5 种 grant_source × auto_allow | T-E2E-GSRC-1..5 | config_declaration / allow_rule / grant_memory / bash_grant_memory / default |
| 7 种 event × authorization 映射 | T-E2E-EVT-1..7 | allow_once / allow_session / allow_persistent / deny / conflict_prompt / hard_deny / auto_allow 各自对应 D3 映射表的 authorization 值 |

### 覆盖率检查

- **mapped**：access-decision 9/9、audit-log 6/6、grant-memory 6/6，集成验证 5+7=12 个测试点 = **33 个测试用例**
- **unmapped**：无
- **N/A**：无
