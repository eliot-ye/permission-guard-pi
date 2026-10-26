## Why

项目外 `config.*`/`auth.*`/`settings.*`/`models.*` 等通用配置文件常含 apikey/token（如 `~/.config/gh/config.yml` 含 GitHub token），但未在 sensitive 白名单 → 项目外**读**走 `decide()` step 2e"未配置非敏感读"→ 静默 `auto_allow`，LLM 可直接读走凭证。这是 sensitive 白名单的**读侧盲区**——凭证泄露风险主要在读，读恰是静默。

用户要堵此盲区（标敏感→弹窗），但对这类"可撤销凭证"（apikey，多可吊销重置）希望允许持久化赦免（"总是允许"），避免每次读都弹窗；区别于 `~/.ssh/id_rsa` 等"不可撤销私钥"（泄露=服务器被攻破，不可吊销）仍应外区 tier=two 不可持久化。

**范围说明**：`decide()` step 2b（`decision.ts:248`）的 tier 分派不区分 action，soft→tier=three 同时放宽外区读、写与 delete——baseline `access-decision:111`「项目外敏感路径：读与写都 prompt，tier=two」被 override 时读与写一并覆盖，`delete` 亦同（`decide()` 的 `Action` 联合类型含 `"delete"`，由 bash `rm` 提取产出，文件工具路径无 delete）。这是有意接受的范围：soft 集合按"可撤销凭证"语义界定，外区写（修改凭证文件本身）同样属可持久化赦免范围；区别于 hard sensitive（外区读写删均 tier=two 不可持久化）。

**已知边界（用户 2026-10-26 确认后接受）**：soft 的 `delete` 持久化不在"可撤销"论证范围内——read/write 泄了可吊销 token，但 delete 是彻底消除文件，无法通过吊销恢复。blast radius 已核实为**路径粒度**（`addPersistentGrant({action:"delete", path})`，`extensions/index.ts:966-975`），非命令 hash 粒度：一次批准同路径的任意 `rm <该路径>` 形态后续全部静默。用户可编辑 `trusted.json` 删除该 grant 撤销。该边界已写入 `decision.ts` step 2b 注释、`access-decision` spec 与 `grant-memory` spec。

现有 sensitive 设计：外区 tier=two 不可持久化（`permission-model.md` Summary 声明的"敏感路径永远弹窗"硬底线 + `grant-memory` spec"未配置路径不写入持久化"requirement）。本 change 接受偏离此硬底线，对 soft sensitive 允许外区可持久化。

## What Changes

- `sensitive.ts` 引入 hard/soft 分级：`SensitiveRule` 加 `level: "hard" | "soft"` 字段（或新增并列 `PARDONABLE_RULES` 数组）。soft 集合覆盖 `config.*`/`auth.*`/`settings.*`/`models.*` 的凭证扩展名（`.json`/`.toml`/`.yml`/`.yaml`），basename 精确匹配（`config`/`auth`/`settings`/`models` + 凭证扩展名），不含无扩展名的 `config`（避免误伤 `~/.ssh/config` 既有 hard 规则）。
- `decide()` step 2b（`decision.ts:242-251`）分级逻辑：hard sensitive 沿用现有（外区 tier=two / 内区 tier=three）；**soft sensitive → tier=three 不论内外**（可持久化赦免）。
- `access-decision` spec 新增 requirement"可赦免敏感路径分级与 tier 语义"。
- `grant-memory` spec 显式声明 soft sensitive 外区可持久化（现有"未配置路径不写入持久化"requirement 针对 tier=two，soft 是 tier=three 不受其约束，但需显式声明避免歧义）。
- ⚠️ **偏离 `permission-model.md`"敏感路径永远弹窗"硬底线**（项目外敏感不可持久化部分），需 spec 显式声明 hard/soft 分级与各自 tier 语义。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `access-decision`: 新增 requirement"可赦免敏感路径分级与 tier 语义"——soft sensitive 命中 → tier=three 不论内外（区别于 hard 的外区 tier=two / 内区 tier=three）；现有"系统机密文件读取判敏感"requirement 的 tier 语义细化为按 `level` 分派。
- `grant-memory`: 显式声明 soft sensitive 外区持久化授权允许——现有"未配置路径不写入持久化"requirement 限定 tier=two，soft 是 tier=three 可写，需新增 requirement 消除"敏感路径是否可持久化"的歧义。

## Impact

- **代码**：
  - `src/lib/sensitive.ts`：`SensitiveRule` 接口加 `level` 字段；`DEFAULT_SENSITIVE_RULES` 现有 5 条标 `hard`；新增 soft 规则集（`config`/`auth`/`settings`/`models` + `.json`/`.toml`/`.yml`/`.yaml`）。
  - `src/lib/decision.ts`：`decide()` step 2b 按 `sensitive.level` 分派 tier。
  - `extensions/index.ts`：`findSensitiveMatch` 返回值携带 `level`，`decideTarget` 透传给 `decide()`。
- **spec**：`access-decision` 新增 requirement + `grant-memory` 新增 requirement。
- **依赖**：无新增。
- **系统**：偏离安全硬底线（critical），引入 sensitive hard/soft 分级；soft 外区可持久化 = 永久静默读 apikey 的风险换首弹后免打扰。

## 系统工程影响评估

（服务钱学森系统工程主基调第 3 条"从定性到定量的综合集成"）

- **影响哪些分系统**：sensitive-path-classification（`sensitive.ts` 分级改造）+ access-decision（`decide` step 2b 分级分派）+ grant-memory（soft 外区可持久化声明）+ extension-orchestration（`findSensitiveMatch` 透传分级）。audit-log 间接影响（soft 命中 audit 记录可标 level）。
- **整体性能预期变化**：`config.*`/`auth.*` 等文件项目外读从静默 `auto_allow` 变 tier=three prompt（首弹堵盲区），用户"总是允许"后持久化静默；项目外**写**同样从 tier=two 降为 tier=three（`decide()` step 2b 不分 action，与 baseline `access-decision:111`「读与写都 tier=two」一并 override），可持久化授权；项目内 `config.json` 读写从 `auto_allow` 变 tier=three prompt（首弹，可持久化消除）。`~/.ssh/id_rsa` 等 hard 不变（外区读写均 tier=two 不可持久化）。
- **这是局部优化还是全局协调**：**全局协调**。引入 sensitive hard/soft 分级是新概念，触碰决策引擎核心 tier 语义 + grant 持久化边界 + 安全硬底线。
- **如果是局部优化，对全局失调的风险**：**高**。偏离"敏感路径永远弹窗"硬底线——soft 外区可持久化 = 永久静默读 apikey。失调场景：用户误对 `~/.config/gh/config.yml` 选"总是允许" → LLM 永久可读 GitHub token。缓解：soft 集合只含"可撤销凭证"文件名（`config.*`/`auth.*` 等，apikey 多可吊销重置），不含 `~/.ssh/id_rsa`（不可撤销私钥仍 hard）；soft 规则按 basename+凭证扩展名精匹配，不误伤无扩展名 `config`（`~/.ssh/config` 仍 hard）。
- **预期行为模型**：(1) 项目外 `~/.config/gh/config.yml` 首次读 → tier=three prompt（堵盲区，不再静默 auto_allow）；(2) 用户选"总是允许" → 持久化 grant，后续同会话/跨会话静默；(3) `~/.ssh/id_rsa` 外区读仍 tier=two 不可持久化（hard 不变）；(4) 项目内 `config.json` 读写首弹 tier=three，可"总是允许"持久化；(5) 项目外 `~/.config/gh/config.yml` 写 → tier=three（soft 放宽覆盖写，可持久化）；(6) `~/.ssh/id_rsa` 外区写仍 tier=two 不可持久化（hard 读写均不变）；(7) 项目外 soft `delete`（`rm ~/.config/gh/config.yml`）→ tier=three 可持久化（已知边界，见「已知边界」节）；(8) `~/.ssh/id_rsa` 外区 `delete` 仍 tier=two 不可持久化（hard 不变）。验证：sensitive 单元测试（soft 规则匹配 `config.json`/`auth.yml` 等、hard 仍匹配 `~/.ssh/id_rsa`、`~/.ssh/config` 仍 hard、`~/.aws/config.json` 与 `~/.docker/config.json` 排序边界仍 hard、规则表结构性断言 soft 必为末条）+ decide 测试（soft → tier=three 不论内外且 read/write/delete 全覆盖、soft 外区 delete → tier=three、hard 外区 read/write/delete → tier=two、hard 内区 read/write/delete → tier=three、排序边界决策级断言）+ 集成测试（项目外 `config.yml` 读首弹 + 持久化后免弹 + `config.yml` 外区写跨 session 持久化 + bash `rm` 产出的 delete 目标 soft→tier=three 且 grant 落盘 / hard→tier=two 不持久化 + `~/.ssh/id_rsa` 外区读写仍 tier=two 不可持久化）。
- **与既有架构/风格的遵循关系**：⚠️ **偏离既有架构**——"敏感路径永远弹窗"硬底线（`permission-model.md` Summary + `grant-memory` spec"未配置路径不写入持久化"）。新设计引入 hard/soft 分级是有意的安全模型细化（可撤销凭证 vs 不可撤销私钥），需 spec 显式声明。偏离点：soft sensitive 外区 tier=three 可持久化（既有是 tier=two 不可持久化）。触发 human-in-loop——用户已通过选 B1 接受偏离。

## caller impact 分析

- **变更点清单**：
  - `SensitiveRule` 接口（`sensitive.ts:9-12`）加 `level: "hard" | "soft"` 字段：属**第②类**（内部实现，但 `DEFAULT_SENSITIVE_RULES` 是导出符号——加字段前向兼容，既有 5 条规则需补 `level: "hard"`）。
  - `decide()` step 2b（`decision.ts:242-251`）tier 分派逻辑变更：`sensitive.level === "soft"` → tier=three 不论内外。属**第①类**（决策引擎核心行为/公共契约变更）——**高危**。`Decision` 类型不变（tier 仍 `"two" | "three"`），但 tier 分配规则变。
  - `findSensitiveMatch` 返回的 `SensitiveRule` 携带 `level`，`decideTarget`（`extensions/index.ts:755`）透传给 `decide()`：属**第②类**（接口契约扩展，前向兼容）。
  - `access-decision` spec 新增 requirement"可赦免敏感路径分级与 tier 语义"：属**第③类**（公共契约 spec 变更）——**高危**。
  - `grant-memory` spec 新增 requirement"soft sensitive 外区可持久化"：属**第③类**——**高危**。
  - 偏离 `permission-model.md` Summary 声明的"敏感路径永远弹窗"硬底线：属**第①类**（安全模型变更）——**高危**。
- **高危标记**：涉及①③类多处——`decide` tier 逻辑、access-decision spec、grant-memory spec、安全硬底线偏离。这是 go/no-go 决策点，用户已通过选 B1 接受偏离。
- **已知 caller**：
  - `findSensitiveMatch` caller（`find_references` 实测 62 匹配 / 13 文件，其中文档自引用 7 文件；**代码 caller** 生产 1 处 + 测试 3 文件）：`extensions/index.ts:755`（decideTarget，生产）、`test/cross-system-boundary.mjs:90`、`test/decision.test.ts:70`、`test/sensitive.test.ts`（37 行）。预判：`extensions/index.ts:755` 需适配（读 `level` 透传 decide）；测试需新增 soft 场景。
  - `decide()` caller：`extensions/index.ts:807`（decideTarget 内 `return decide({...sensitive...})`）。预判：兼容（`Decision` 类型不变，tier 值由 decide 内部按 `sensitive.level` 算）。

## Scenario→Test 覆盖账本

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 可赦免敏感路径分级与 tier 语义 | 项目外 config.yml 读弹 tier=three 可持久化 | test/sys-integration.test.ts | SYS-SOFT: soft outer config.yml read prompts tier three and persists | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | 项目外 config.yml 写弹 tier=three 可持久化 | test/decision.test.ts | DEC-SOFT: soft outer write and delete prompt tier three | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | 项目外 auth.json 读弹 tier=three | test/decision.test.ts | DEC-SOFT: soft auth.json outer read prompts tier three | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | 项目外 config.yml delete 弹 tier=three 可持久化 | test/decision.test.ts | DEC-SOFT: soft outer write and delete prompt tier three | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | ~/.ssh/id_rsa 外区读仍 tier=two 不可持久化 | test/decision.test.ts | DEC-SOFT: hard outer read, write and delete stay tier two | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | ~/.ssh/id_rsa 外区写仍 tier=two 不可持久化 | test/decision.test.ts | DEC-SOFT: hard outer read, write and delete stay tier two | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | ~/.ssh/id_rsa 外区 delete 仍 tier=two 不可持久化 | test/decision.test.ts | DEC-SOFT: hard outer read, write and delete stay tier two | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | ~/.ssh/config 仍 hard 不受 soft 集合影响 | test/sensitive.test.ts | SENS-SOFT: ssh id_rsa and ssh config still hard | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | ~/.aws/config.json 仍 hard 不可持久化（规则排序边界） | test/sensitive.test.ts | SENS-SOFT: hard priority beats soft on ordering boundaries | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | 项目内 config.json 读弹 tier=three | test/decision.test.ts | DEC-SOFT: soft inner read, write and delete prompt tier three | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | config.ts 不命中 soft（代码扩展名） | test/sensitive.test.ts | SENS-SOFT: code-extension files do NOT match soft | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | settings.toml 命中 soft | test/sensitive.test.ts | SENS-SOFT: soft credential config files match as soft | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | models.json 命中 soft | test/sensitive.test.ts | SENS-SOFT: soft credential config files match as soft | 🟢 |
| 可赦免敏感路径分级与 tier 语义 | 用户配置声明覆盖 soft sensitive | test/sys-integration.test.ts | SYS-SOFT-DECL: explicit config declaration overrides soft sensitive | 🟢 |
| 可赦免敏感路径外区持久化授权 | soft sensitive 外区"总是允许"写入持久化 | test/sys-integration.test.ts | SYS-SOFT: soft outer config.yml read prompts tier three and persists | 🟢 |
| 可赦免敏感路径外区持久化授权 | soft sensitive 外区写持久化授权 | test/sys-integration.test.ts | SYS-SOFT: soft outer config.yml write also persists across sessions | 🟢 |
| 可赦免敏感路径外区持久化授权 | soft sensitive 外区 delete 持久化授权 | test/sys-integration.test.ts | SYS-SOFT-HARD: hard outer id_rsa and ssh config stay tier two, no persist | 🟢 |
| 可赦免敏感路径外区持久化授权 | hard sensitive 外区仍不可持久化 | test/sys-integration.test.ts | SYS-SOFT-HARD: hard outer id_rsa and ssh config stay tier two, no persist | 🟢 |
| 可赦免敏感路径外区持久化授权 | hard sensitive 外区写仍不可持久化 | test/sys-integration.test.ts | SYS-SOFT-HARD: hard outer id_rsa and ssh config stay tier two, no persist | 🟢 |
| 可赦免敏感路径外区持久化授权 | soft 持久化 grant 撤销后重新弹窗 | test/sys-integration.test.ts | SYS-SOFT-REVOKE: revoking the soft persistent grant re-prompts | 🟢 |
| 可赦免敏感路径外区持久化授权 | soft sensitive 按文件记忆不抬开目录 | test/sys-integration.test.ts | SYS-SOFT-FILE: soft persistent grant is keyed by file, not directory | 🟢 |

**机械校验**：(1) 路径存在性——3 个测试文件均实际存在且被 `npm test` 的 glob 纳入（`test/sensitive.test.ts`、`test/decision.test.ts`、`test/sys-integration.test.ts`）；(2) 名称对齐——Scenario 列与 `specs/access-decision/spec.md` + `specs/grant-memory/spec.md` 现文逐字一致，测试名列与 `grep '^test("'` 实测输出逐字一致；(3) 21 行全部映射，无 unmapped scenario、无 N/A 行（access-decision 15 + grant-memory 6）。

**状态说明**：21/21 🟢。执行顺序为 TDD：1.1/1.2 先写失败测试（exit=1 实测）→ 2.1/2.2 实现 → 3.1 集成 → 6.1 补齐。其中 4 行在 6.1 账本审计时补测试（auth.json 外区读、配置声明覆盖、撤销后重弹、按文件不抬开目录）——原账本为 🔴 未实现，6.1 判为 blocking defect 后补齐，非事后翻绿。另 3 行（soft 外区 delete、hard 外区 delete、soft 外区 delete 持久化）在 6.3 收尾 review 之后由 P2#3 产品决策落地时新增：用户确认接受 delete 一并放宽并文档化，spec 与账本同步增补。

**路径订正**：账本原计划把「soft 持久化 grant 撤销后重新弹窗」「soft sensitive 按文件记忆不抬开目录」两行映射到 `test/grant-memory.test.ts`。实际改映射到 `test/sys-integration.test.ts`——`grant-memory.test.ts` 仅测 `bashPermissionForReason`（bash 命令 reason→permission 映射），不经过 `decide()` 与 trust store 的端到端管道；撤销与按文件语义需要真盘 `trusted.json` 读写 + 跨 session 状态，属集成层。

## 实际系统工程影响 vs 预期（archive 复盘）

（服务主基调第 3 条"从定性到定量的综合集成"——archive 前的闭合动作。复盘对照源：proposal「系统工程影响评估」节 + `openspec/specs/` 主 spec baseline。）

| proposal 侧（预期） | archive 侧（实际） |
|---|---|
| 影响哪些分系统：sensitive-path-classification + access-decision + grant-memory + extension-orchestration；audit-log 间接影响 | 实际影响分系统：4 个主分系统全部按预期改动（`sensitive.ts` 分级 / `decision.ts` step 2b / `grant-memory` spec / extensions 透传）；audit-log 实测未改 `AuditRecord` 结构，`declaration: "sensitive_default"` 为 hard/soft 共享，间接影响确认无 scope 扩张（与预期一致） |
| 整体性能预期变化：config.* / auth.* 项目外读从静默 auto_allow 变 tier=three prompt（首弹堵盲区）；项目外写从 tier=two 降 tier=three；项目内 config.json 读写从 auto_allow 变 tier=three prompt；hard 不变 | 实际整体性能变化：与预期一致。DEC 层 soft→tier=three 不论内外、hard 外区→tier=two / 内区→tier=three 实测成立；集成层 soft 外区读首弹 + 持久化后跨会话静默、soft 外区写跨 session grant 落盘、hard 外区读写删均 tier=two 不可持久化实测成立。**预期之外的增量**：delete 一并放宽（P2#3 决策），soft 外区 delete→tier=three 可持久化、hard 外区 delete→tier=two 不可持久化 |
| 这是局部优化还是全局协调：全局协调。引入 hard/soft 分级是新概念，触碰决策引擎核心 tier 语义 + grant 持久化边界 + 安全硬底线 | 实际是局部优化还是全局协调：**全局协调**（与预期一致）。hard/soft 分级作为全局概念已同步 4 处：`decision.ts` step 2b 注释、proposal 范围说明+已知边界、`access-decision` spec requirement+delete 边界段、`grant-memory` spec delete scenario+KNOWN BOUNDARY。无局部优化遗留 |
| 如果是局部优化，对全局失调的风险：高。偏离"敏感路径永远弹窗"硬底线——soft 外区可持久化=永久静默读 apikey。缓解：soft 集合只含可撤销凭证 | 局部优化的实际全局影响（主基调第 1 条事后回检）：N/A——本 change 是全局协调非局部优化。但"偏离硬底线"风险的实际控制：soft 集合 basename 精匹配（不含无扩展名 config → `~/.ssh/config` 仍 hard）、不含代码扩展名、排序不变式（soft 必为末条，hard 永远先匹配）有行为用例 + 结构性断言双重守护。排序不变式仅靠代码顺序维护无机械防护（review #9 记录为已知边界，未来规则表扩为可配置项再考虑） |
| 预期行为模型：(1)-(8) 8 条 | 模型验证：**预期行为模型已验证**。6 条由一次性审计脚本逐条实测通过（6/6，跑完删除），2 条（delete soft/hard）由 6.3 收尾 review P2/P3 修复时新增的测试承担端到端验证。模型扩展（非证伪）：原模型按"读"表述，实际 step 2b 不分 action 覆盖写+delete，模型从 6 条扩到 8 条，未被证伪——偏差已转化为 proposal「范围说明」+「已知边界」节的显式声明 |

**补充字段**：

- **预期之外的副作用**：(1) soft 外区 delete 持久化的 blast radius 为**路径粒度**（`addPersistentGrant({action:"delete", path})`，非命令 hash 粒度）——一次批准后续同路径任意 `rm <该路径>` 形态全部静默，且删除后文件无法通过吊销 token 恢复。用户 2026-10-26 确认接受并文档化（4 处）。(2) audit-log 测试 AL7（`concurrent_audits_are_serialized_no_line_interleaving`）在全量套件首轮偶发失败（`expected 100 lines, got 81`），单独跑 5/5 通过、全量连跑 3 次 615/615 通过——并发时序 flaky，与本 change 无关（`git diff` 未触及 `audit.ts`），属既有问题，本次未修。这两条是后续 `/td-system-audit` 的输入。
- **scenario→test 覆盖账本状态**：21/21 🟢，0 N/A。spec 21 scenario（access-decision 15 + grant-memory 6）↔ 账本 21 行严格一致，测试名 0 断链（`grep '^test("'` 实测逐字对齐）。

**主 spec baseline 契约对照（对照源 2）**：

- `access-decision` baseline L111「项目外敏感路径：读与写都 prompt，tier=two（不允许"总是允许"）」——本 change 的 spec delta **显式 override** 此条目（soft sensitive 项目外走 tier=three 而非 tier=two），override 语义在 spec delta「override 语义」段声明，非静默破坏。hard sensitive 不受 override，沿用 tier=two。用户已通过选 B1 接受偏离（human-in-loop）。
- `grant-memory` baseline L116-118「未配置路径不写入持久化」requirement 限定 tier=two——soft 是 tier=three 不在该 requirement 约束范围内，本 change 新增 requirement 消除"敏感路径是否可持久化"歧义，**未破坏** baseline 的 tier=two 限定。
- 结论：change delta 对 baseline 契约的偏离均为显式声明 + 用户确认，无静默破坏。
