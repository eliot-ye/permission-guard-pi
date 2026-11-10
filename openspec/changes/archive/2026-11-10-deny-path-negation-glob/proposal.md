# Proposal: deny-path-negation-glob

## Why

pi 当前的 deny 能力是 **tool+pattern** 规则（`{"tool":"bash","pattern":"rm *","action":"deny"}`），有两个缺口（对齐 ta-agent 审批门 deny 层）：

1. **无 `!` 否定豁免**——pattern 匹配即命中，无例外集。用户想"拦所有 `.env.*` 但放行 `.env.example`"无法表达；只能靠 `sensitive.ts` 里硬编码的 `test()` 函数逐条写例外（如 `sensitive.ts:122` 显式排除 `.env.example`），不可配置。
2. **无可配置 path-based 种子 deny 集**——pi 的"开箱保护"硬编码在 `sensitive.ts` 的 `DEFAULT_SENSITIVE_RULES`（`test()` 函数，非 glob、不可配豁免）。ta-agent 则是可配置的 `DEFAULT_DENY_RULES`（path glob + `!` 豁免，`approval-config.ts:11-34`）。

ta-agent 的 deny 是 **path-based** + `!` 否定豁免（`../ta-agent/packages/runtime/src/approval/glob.ts:44-55` `isDenyHit`：正向命中且未命中任一否定才 deny，顺序无关例外集语义）。本 change 给 pi 引入独立的 path-based deny 层，对齐这三项：deny 规则、`!` 否定豁免 glob 语义、可配置种子 deny 集。

**范围（用户拍板 2026-11-10）**：
- permission.json 加 `deny` 段（path glob 列表，`!` 前缀否定豁免）；
- `!` 否定豁免**只作用于用户配置的 deny 段**，**不迁移** `sensitive.ts` 既有 hard 敏感规则（保持不可豁免，比 ta-agent 更强的安全基线不动）；
- deny-path 命中 → `deny_hard`（无条件，对齐既有 tool+pattern deny 语义）。

## What Changes

- `src/lib/config.ts`：
  - `RawConfig` 加 `deny?: string[]` 字段（path glob 列表，`!` 前缀否定豁免）。
  - `MergedPolicy` 加 `resolveDenyPath(absolutePath: string): boolean` 方法——`isDenyHit` 式判定（正向命中且未命中任一否定才 deny）；合并三档配置的 `deny` 段（global + project + local，additive 合并，不做优先级覆盖——deny 是安全收紧方向，多源叠加）。
  - `mergePolicies` 解析 `deny` 段并注入 `resolveDenyPath`。
- `src/lib/decision.ts`：`decide()` 在 tool+pattern deny 规则检查（step 0）之后、path 解析（step 1）之前插入 deny-path 检查——`resolveDenyPath(absPath)` 命中 → `deny_hard`（`declaration: "unconfigured"`，`reasonCode: "deny_path_hit"`）。
- `src/lib/reason-codes.ts`：`DecisionReasonCode` 加 `deny_path_hit`。
- 新增纯函数 `isDenyHit(path, patterns)` + `globToRegExp`（放 `src/lib/path-utils.ts` 或新模块，零依赖，对齐 ta-agent `glob.ts` 的顺序无关例外集语义）。
- 契约变更（ADDED）：
  - `permission-config`：`deny` 段语法 + `!` 否定豁免语义 + 三档合并语义；
  - `access-decision`：deny-path 检查的判定顺序与 `deny_hard` 处置。

## Capabilities

### New Capabilities

（无——本 change 不引入新 capability/子系统，是对既有 permission-config + access-decision 的扩展。）

### Modified Capabilities

- `permission-config`：ADDED Requirement「path-based deny 段与 `!` 否定豁免」——`deny` 段语法、`!` 前缀例外集语义（顺序无关）、三档 additive 合并、与 `sensitive.ts` 硬编码保护的边界（`!` 不豁免 hard 敏感）。
- `access-decision`：ADDED Requirement「path-based deny 规则检查」——deny-path 命中 → `deny_hard`，判定顺序在 tool+pattern deny 之后、path 解析之前，无条件（不论敏感/区域/操作）。

## Impact

- **代码**：`src/lib/config.ts`（`RawConfig`/`MergedPolicy`/`mergePolicies` 加 `deny` 段 + `resolveDenyPath`）；`src/lib/decision.ts`（deny-path 检查）；`src/lib/reason-codes.ts`（`deny_path_hit`）；`src/lib/path-utils.ts` 或新模块（`isDenyHit`/`globToRegExp`）。
- **行为**：用户配置 `deny` 段后，命中路径（且未命中 `!` 例外）的工具调用 → `deny_hard`；未配置 `deny` 段时行为与引入前逐字节一致（向后兼容）。
- **依赖**：无新第三方依赖（手写 glob，对齐 ta-agent `glob.ts` 零依赖）。
- **分系统**：policy-core（config 解析 + decision 判定 + 新纯函数 + reason-code）；extension-orchestration **不改**（`decideTarget` 已透传 `absPath` 给 `decide()`，deny-path 在 `decide()` 内判定）；side-effects（audit-log 沿用既有 `hard_deny` 形态，`declaration: "unconfigured"`，无新契约）。

## 系统工程影响评估

（钱学森系统工程主基调第 3 条「从定性到定量的综合集成」。）

- **影响哪些分系统**：policy-core（`config.ts` 加 `deny` 段解析 + `resolveDenyPath`、`decision.ts` 加 deny-path 检查、新纯函数 `isDenyHit`/`globToRegExp`、`reason-codes.ts` 加 `deny_path_hit`）。extension-orchestration 零改动（deny-path 在 `decide()` 纯函数内判定，`decideTarget` 已传 `absPath`）。side-effects 零契约改动（沿用 `hard_deny` 审计形态）。bash-extract 模块不改。
- **整体性能预期变化**：未配置 `deny` 段时零开销（`resolveDenyPath` 空列表短路返回 false）。配置后每次决策多一次 path-glob 匹配（O(用户 deny 规则数)，正向 + 否定各一遍）；普通路径无感知。
- **这是局部优化还是全局协调**：全局协调——补齐 pi deny 层的"可配置 path 保护 + 例外豁免"能力，让用户能用配置表达"拦一类、放行例外"，而非依赖改代码（`sensitive.ts`）；与 tool+pattern deny 互补（后者按工具/命令、前者按路径）。
- **如果是局部优化，对全局失调的风险**：N/A（全局协调）。注意边界：`!` 豁免**不削弱** `sensitive.ts` hard 敏感保护（并存设计，见 Why）——这是刻意的安全基线保留，非失调。
- **预期行为模型**：输入「配置 `deny: ["**/*.pem", "!**/public.pem"]` + 访问 `<proj>/certs/root.pem`」→ 期望 `deny_hard`（正向命中）；输入「同配置 + 访问 `<proj>/certs/public.pem`」→ 期望**不**因 deny-path 命中（`!` 豁免），按后续规则判定；输入「未配置 deny 段」→ 行为与引入前一致。验证：新增 TDD 单测（`isDenyHit` 纯函数）+ 集成测试（config 解析 + decide 判定）。
- **与既有架构/风格的遵循关系**：完全遵循既有分层——纯函数 `isDenyHit`（零 IO/UI，对齐 `src/lib/*.ts` 约定 + ta-agent `glob.ts` 同构）；`deny` 段解析在 `mergePolicies`（对齐既有 `paths`/`rules` 段）；deny-path 判定在 `decide()` 纯函数内（对齐既有 tool+pattern deny 的 step 0）。**无偏离**。

## caller impact 分析

- **变更点清单**：
  - `RawConfig` 加 `deny?: string[]`（additive，optional 字段，旧配置无此字段 → undefined → 视为空数组）。
  - `MergedPolicy` 加 `resolveDenyPath` 方法（additive，新方法，无既有 caller 破坏）。
  - `decide()` 加 deny-path 检查（step 0.5，插在既有 step 0 tool+pattern deny 与 step 1 path 解析之间）。**`decide()` 签名不变**（`policy` 已含 `resolveDenyPath`）。
  - `DecisionReasonCode` 加 `deny_path_hit`（additive union 拓宽）。
  - 新增 `isDenyHit`/`globToRegExp`（新符号，无既有 caller）。
- **高危标记**：无——均为 additive（新字段/新方法/新符号/union 拓宽）；`decide()` 内插入新 step 不改变既有 step 顺序（deny-path 在 tool+pattern deny **之后**，不抢占既有最高优先级）。
- **已知 caller**：`decide()` 的所有 caller（`extensions/index.ts` `decideTarget` :918/:920/:1003/:1005）——签名未改，policy 对象多一个方法 → 兼容；`mergePolicies` caller（`loadAllConfigs`）→ 返回形状不变，policy 内部多方法 → 兼容。

> 注：caller impact 因**跨分系统**（policy-core 单分系统为主，但 `decide()` 是核心公共契约）触发审阅；变更点均为 additive，无既有 caller 破坏。

## Architecture Review

**Verdict: APPROVED**（2026-11-10 收尾 review，subagent 隔离评审）
- reviewed-by: subagent（fresh-context，同模型）
- 报告位置：`reviews/20261110-162027-change-level.md`
- Security 不变量成立：`!` 例外集语义正确、相对 pattern 作用域限定（不泄漏到 projectRoot 外）、globDenyToRegExp 转义完整无 ReDoS、`!` 不削弱 hard 敏感基线
- 2 处 nit 已修复（过时注释 + spec 跨源豁免说明）

## 实际 vs 预期复盘（archive）

（tier-medium，5 字段全填。对照 proposal「系统工程影响评估」节。）

| 维度 | 预期 | 实际 |
|---|---|---|
| **影响分系统** | policy-core（`config.ts` `deny` 段解析 + `resolveDenyPath`、`decision.ts` 加 deny-path 检查、新纯函数 `isDenyHit`/`globDenyToRegExp`、`reason-codes.ts` 加 `deny_path_hit`）；extension-orchestration 零改动；side-effects 零契约改动 | policy-core（`config.ts` 加 `deny` 字段 + `resolveDenyPath` + `mergePolicies` 三档拼接、`decision.ts` step 0.5 + 可选链容错、`path-utils.ts` 新增 `isDenyHit`/`globDenyToRegExp`、`reason-codes.ts` + `i18n.ts` 加 `deny_path_hit`）。extension-orchestration **零改动**（符合预期）；side-effects **零改动**（沿用 `hard_deny` 形态） |
| **整体性能变化** | 未配置 `deny` 段时零开销（空列表短路）；配置后每次决策多一次 path-glob 匹配（O(用户 deny 规则数)） | 符合预期。`resolveDenyPath` 空 deny 列表短路返回 false；配置后 O(deny 规则数) 正向 + 否定各一遍，普通路径无感知。SYS-DP3（未配置 deny）行为与引入前逐字节一致 |
| **局部 vs 全局** | **全局协调**——补齐 pi deny 层的"可配置 path 保护 + 例外豁免"能力，让用户用配置表达"拦一类、放行例外" | **全局协调**。与 tool+pattern deny 互补（后者按工具/命令、前者按路径）；`!` 豁免让 `.env.example` 类例外无需改代码（原 `sensitive.ts` 硬编码 `test()` 例外） |
| **全局失调风险** | N/A（全局协调）。注意边界：`!` 豁免**不削弱** `sensitive.ts` hard 敏感保护（并存设计） | N/A。一处设计内权衡记录：negation 跨源豁免（local 档 `!` 可作用于 global 档正向 deny）——例外集语义不隔离来源，已在 spec 补说明；风险可控（三档 config 受 P0 deny_hard 保护，agent 无法注入 negation） |
| **预期行为模型验证** | 「配置 `deny: ["**/*.pem", "!**/public.pem"]` + 访问 `root.pem`」→ deny_hard；「同配置 + `public.pem`」→ 不因 deny-path 命中（`!` 豁免）；「未配置 deny 段」→ 行为不变 | **预期模型已验证**。deny-path 单测 14/14（isDenyHit 纯函数 + 三档 additive + `!` 豁免 + 向后兼容 + 相对作用域）；SYS-DP1/2/3 集成全绿 |

### 预期之外的副作用

- **step 0.5 可选链容错**：初版 `decide()` step 0.5 用 `policy.resolveDenyPath(absPath)` 直调，DEC-CODE 系列旧测试手工 mock 的 policy 对象只有 `resolve`/`resolveRule` 两方法，触发 TypeError。改为 `policy.resolveDenyPath?.()` 可选链容错——既兼容旧 mock、也对真实 `MergedPolicy` 无行为变化（该方法恒存在）。这是 caller impact 分析未预见到的（测试手工 mock policy 是既有模式）。
- **`globDenyToRegExp` 的 `**/` 处理**：初版把 `**/` 展开为 `.*` + 字面 `/`，导致 `**/*.pem` 匹配不到根级 `.pem`（ta-agent `glob.ts` 把 `**/` 处理为可选目录段 `(?:.*/)?`）。单测 1.2 抓住该边界，修正为 `(?:.*/)?`——与 ta-agent 同构。
- **相对 pattern 作用域处理**：`resolveDenyPath` 的相对 pattern 需感知 projectRoot（限 root 内生效，对齐既有 `resolve()` 相对模式语义）。初版用 `\0__outside__` hack 处理 root 外情况，重写为清晰版本——相对 pattern 拼接 `rootPrefix`，absPath 在 root 外时 `rootPrefix=""` 使相对 pattern 不匹配绝对 abs。

### scenario→test 覆盖账本状态

- `test/deny-path.test.ts` 14 用例全绿（isDenyHit 9 + resolveDenyPath 5）。
- SYS-DP1/2/3 集成全绿（deny 命中 deny_hard / `!` 豁免不命中 / 未配置向后兼容）。
- 全量测试 1011/1012（唯一 fail 是既有 flaky AL7，git stash 对照基线确认非本次引入）。

### 需求权衡处置

无留待 archive 的矛盾。用户拍板已闭合：方向 b1（独立 path-based deny 层）+ 种子集不迁移（与 `sensitive.ts` hard 规则并存，`!` 不作用于 hard 敏感）。
