## Why

项目外 `config.*`/`auth.*`/`settings.*`/`models.*` 等通用配置文件常含 apikey/token（如 `~/.config/gh/config.yml` 含 GitHub token），但未在 sensitive 白名单 → 项目外**读**走 `decide()` step 2e"未配置非敏感读"→ 静默 `auto_allow`，LLM 可直接读走凭证。这是 sensitive 白名单的**读侧盲区**——凭证泄露风险主要在读，读恰是静默。

用户要堵此盲区（标敏感→弹窗），但对这类"可撤销凭证"（apikey，多可吊销重置）希望允许持久化赦免（"总是允许"），避免每次读都弹窗；区别于 `~/.ssh/id_rsa` 等"不可撤销私钥"（泄露=服务器被攻破，不可吊销）仍应外区 tier=two 不可持久化。

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
- **整体性能预期变化**：`config.*`/`auth.*` 等文件项目外读从静默 `auto_allow` 变 tier=three prompt（首弹堵盲区），用户"总是允许"后持久化静默；项目内 `config.json` 读从 `auto_allow` 变 tier=three prompt（首弹，可持久化消除）。`~/.ssh/id_rsa` 等 hard 不变（外区 tier=two 不可持久化）。
- **这是局部优化还是全局协调**：**全局协调**。引入 sensitive hard/soft 分级是新概念，触碰决策引擎核心 tier 语义 + grant 持久化边界 + 安全硬底线。
- **如果是局部优化，对全局失调的风险**：**高**。偏离"敏感路径永远弹窗"硬底线——soft 外区可持久化 = 永久静默读 apikey。失调场景：用户误对 `~/.config/gh/config.yml` 选"总是允许" → LLM 永久可读 GitHub token。缓解：soft 集合只含"可撤销凭证"文件名（`config.*`/`auth.*` 等，apikey 多可吊销重置），不含 `~/.ssh/id_rsa`（不可撤销私钥仍 hard）；soft 规则按 basename+凭证扩展名精匹配，不误伤无扩展名 `config`（`~/.ssh/config` 仍 hard）。
- **预期行为模型**：(1) 项目外 `~/.config/gh/config.yml` 首次读 → tier=three prompt（堵盲区，不再静默 auto_allow）；(2) 用户选"总是允许" → 持久化 grant，后续同会话/跨会话静默；(3) `~/.ssh/id_rsa` 外区读仍 tier=two 不可持久化（hard 不变）；(4) 项目内 `config.json` 读首弹 tier=three，可"总是允许"持久化。验证：sensitive 单元测试（soft 规则匹配 `config.json`/`auth.yml` 等、hard 仍匹配 `~/.ssh/id_rsa`、`~/.ssh/config` 仍 hard）+ decide 测试（soft → tier=three 不论内外、hard → 外区 tier=two/内区 tier=three）+ 集成测试（项目外 `config.yml` 读首弹 + 持久化后免弹 + `~/.ssh/id_rsa` 外区仍 tier=two 不可持久化）。
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
  - `findSensitiveMatch` caller（`find_references` 实测 51 处 / 10 文件）：`extensions/index.ts:755`（decideTarget）、`test/cross-system-boundary.mjs:90`、`test/decision.test.ts:70`、`test/sensitive.test.ts`。预判：`extensions/index.ts:755` 需适配（读 `level` 透传 decide）；测试需新增 soft 场景。
  - `decide()` caller：`extensions/index.ts:790`（decideTarget）。预判：兼容（`Decision` 类型不变，tier 值由 decide 内部按 `sensitive.level` 算）。

## Scenario→Test 覆盖账本

| Requirement | Scenario | 测试文件路径 | 测试名 | 状态 |
|---|---|---|---|---|
| 可赦免敏感路径分级与 tier 语义 | 项目外 config.yml 读弹 tier=three 可持久化 | test/sys-integration.test.ts | SYS-SOFT: 项目外 config.yml 读弹 tier=three 并持久化 | 🔴 |
| 可赦免敏感路径分级与 tier 语义 | 项目外 auth.json 读弹 tier=three | test/decision.test.ts | DEC-SOFT: auth.json 外区读 tier=three | 🔴 |
| 可赦免敏感路径分级与 tier 语义 | ~/.ssh/id_rsa 外区读仍 tier=two 不可持久化 | test/decision.test.ts | DEC-SOFT: hard id_rsa 外区 tier=two 不变 | 🔴 |
| 可赦免敏感路径分级与 tier 语义 | ~/.ssh/config 仍 hard 不受 soft 集合影响 | test/sensitive.test.ts | SENS-SOFT: ssh config 仍 hard 不命中 soft | 🔴 |
| 可赦免敏感路径分级与 tier 语义 | 项目内 config.json 读弹 tier=three | test/decision.test.ts | DEC-SOFT: config.json 内区 tier=three | 🔴 |
| 可赦免敏感路径分级与 tier 语义 | config.ts 不命中 soft（代码扩展名） | test/sensitive.test.ts | SENS-SOFT: config.ts 不命中 soft | 🔴 |
| 可赦免敏感路径分级与 tier 语义 | settings.toml 命中 soft | test/sensitive.test.ts | SENS-SOFT: settings.toml 命中 soft | 🔴 |
| 可赦免敏感路径分级与 tier 语义 | models.json 命中 soft | test/sensitive.test.ts | SENS-SOFT: models.json 命中 soft | 🔴 |
| 可赦免敏感路径分级与 tier 语义 | 用户配置声明覆盖 soft sensitive | test/sys-integration.test.ts | SYS-SOFT: 配置声明覆盖 soft sensitive | 🔴 |
| 可赦免敏感路径外区持久化授权 | soft sensitive 外区"总是允许"写入持久化 | test/sys-integration.test.ts | SYS-SOFT: soft 外区总是允许写入持久化 | 🔴 |
| 可赦免敏感路径外区持久化授权 | hard sensitive 外区仍不可持久化 | test/sys-integration.test.ts | SYS-SOFT: id_rsa 外区 tier=two 不可持久化 | 🔴 |
| 可赦免敏感路径外区持久化授权 | soft 持久化 grant 撤销后重新弹窗 | test/grant-memory.test.ts | GM-SOFT: soft 持久化撤销后重新弹 | 🔴 |
| 可赦免敏感路径外区持久化授权 | soft sensitive 按文件记忆不抬开目录 | test/grant-memory.test.ts | GM-SOFT: soft 按文件记忆不抬开目录 | 🔴 |

**机械校验**：(1) 路径存在性——4 个测试文件均实际存在（`test/sensitive.test.ts`、`test/decision.test.ts`、`test/sys-integration.test.ts`、`test/grant-memory.test.ts`，已逐一核对文件系统）；(2) 名称对齐——Scenario 列与 `specs/access-decision/spec.md` + `specs/grant-memory/spec.md` 现文逐字一致。

**状态说明**：全部 🔴——测试尚未实现，对应 tasks.md 的 1.1（sensitive RED）/ 1.2（decide RED）/ 3.1（集成测试）任务，apply 时由 TDD 产出。
