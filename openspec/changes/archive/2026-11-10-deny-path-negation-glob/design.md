# Design: deny-path-negation-glob

## Context

见 proposal.md - Why。pi 现有 deny 是 tool+pattern 规则（`config.ts:422-460` `resolveRule` + `access-decision/spec.md:321`），无 `!` 否定豁免、无可配置 path 种子集；"开箱保护"硬编码在 `sensitive.ts` `DEFAULT_SENSITIVE_RULES`（`test()` 函数，非 glob、不可配豁免）。ta-agent 的 deny 是 path-based + `!` 否定豁免（`../ta-agent/packages/runtime/src/approval/glob.ts:44-55` `isDenyHit`）。

## Goals / Non-Goals

**Goals**
- 用户能用 permission.json 的 `deny` 段声明 path glob 保护（如 `"deny": ["**/*.pem"]`），命中 → `deny_hard`。
- 支持 `!` 前缀否定豁免（`"deny": ["**/*.pem", "!**/public.pem"]` → `public.pem` 不命中）——顺序无关例外集语义（非 gitignore last-match-wins）。
- 三档配置的 `deny` 段 additive 合并（global + project + local 叠加，多源收紧）。
- 未配置 `deny` 段时行为与引入前逐字节一致（向后兼容）。
- 零第三方依赖（手写 glob，对齐 ta-agent `glob.ts` 同构 + pi 既有 `path-utils.ts` glob 风格）。

**Non-Goals**（用户拍板 2026-11-10）
- **不迁移** `sensitive.ts` hard 敏感规则成 path-glob 种子集——hard 保护保持不可豁免（比 ta-agent 更强的安全基线不动）。`!` 豁免只作用于用户配置的 `deny` 段，对 hard 敏感**不生效**（对齐 ta-agent「`!` 只作用于可配置 deny 规则，硬编码写保护不经此判定」，`glob.ts:6`）。
- **不改** 既有 tool+pattern deny 规则语义（两者互补并存：tool+pattern 按工具/命令，path-based 按路径）。
- **不做** deny-path 的 grant/记忆豁免通道（deny 是硬拒绝，对齐既有 tool+pattern deny「无条件」语义）。

## Decisions

### D1. deny-path 检查位置：`decide()` step 0.5（tool+pattern deny 之后、path 解析之前）

```
step 0:   tool+pattern deny 规则（既有，最高优先级）
step 0.5: path-based deny 段检查（新增）→ deny_hard
step 1:   path 解析（paths 表）
step 2:   ...（其余不变）
```

依据：deny-path 与 tool+pattern deny 同为"无条件硬拒绝"，紧邻放置语义清晰；两者都在 path 解析**之前**，保证 deny 优先于任何 permission 声明（对齐 access-decision「deny 规则是无条件的」）。tool+pattern deny 保持最高优先级（按工具精确拦截优先于按路径泛拦）。
备选（否决）：放 step 0 之前——path 泛拦抢占 tool 精确拦，语义倒置；放 path 解析之后——deny 会被 `unread` 等声明遮蔽，违背"无条件"。

### D2. `!` 否定豁免语义：顺序无关例外集（对齐 ta-agent，非 gitignore）

`isDenyHit(path, patterns)`：
1. 拆分正向（无 `!` 前缀）与否定（`!` 前缀）两组；
2. 正向组为空 → false（纯否定列表不拦任何东西）；
3. path 未命中任一正向 → false；
4. path 命中任一否定 → false（豁免）；
5. 否则 true。

依据：ta-agent `glob.ts:44-55` 同构语义——「正向命中且未命中任何否定才 deny」，顺序无关（`["*.env.*", "!.env.example"]` 与 `["!.env.example", "*.env.*"]` 等价）。**不用** gitignore 的 last-match-wins（顺序敏感、易错）。glob 语义：`*`=单段（不含 `/`）、`**`=跨段，对齐 ta-agent `globToRegExp`。
备选（否决）：gitignore last-match-wins——顺序敏感、用户心智负担高，ta-agent 也明确选了例外集语义。

### D3. glob 匹配函数放 `src/lib/path-utils.ts`（复用既有 glob 基建）

新增 `isDenyHit(path, patterns)` + `globDenyToRegExp`（deny 专用，`*`=单段/`**`=跨段，独立于既有 `matchesGlob` 的 `?`/`[...]` 语义）。

依据：`path-utils.ts` 是既有 glob/路径工具的单一归属（`matchesGlob` 已在此），deny-glob 与之同源；不新建模块避免碎片化。deny-glob 用**独立** `globDenyToRegExp`（非复用 `matchesGlob`），因为两者语义不同：`matchesGlob` 支持 `?`/`[...]`（配 path 声明用），deny-glob 只需 `*`/`**`（对齐 ta-agent 最小语义），且 deny-glob 要处理 `!` 前缀剥离。
备选（否决）：复用既有 `matchesGlob`——语义不同（`?`/`[...]` vs 纯 `*`/`**`），强行复用会让 deny pattern 意外支持 path 声明才有的元字符；新建独立模块——碎片化，`path-utils.ts` 已是 glob 工具归属。

### D4. `deny` 段三档 additive 合并（非优先级覆盖）

`resolveDenyPath` 判定用 global + project + local 三档 `deny` 列表**拼接**后的合集（`[...global, ...project, ...local]`）。

依据：deny 是安全收紧方向——多源 deny 应叠加（任一源拦即拦），而非像 `paths` 那样 local 覆盖 global（覆盖会削弱保护）。对齐 ta-agent「全局与项目 deny 规则合并生效」（`m9 spec:80`）。
备选（否决）：按 source 优先级覆盖——会让 project 的 deny 覆盖掉 global 的 deny，削弱保护，与 deny 收紧方向相反。

### D5. deny-path 命中 → `deny_hard`，`declaration: "unconfigured"`，`reasonCode: "deny_path_hit"`

依据：对齐既有 tool+pattern deny 的 `deny_hard` + `declaration: "unconfigured"` + `reasonCode: "rule_denied"` 形态（`decision.ts:112-123`）；新增 `deny_path_hit` reason-code 区分"deny 由 path 段触发"与"deny 由 tool+pattern 规则触发"，供审计/调试溯源。无 grant/记忆豁免（对齐 D-NonGoals）。
备选（否决）：`declaration: "deny_path"` 新值——增加 `Declaration` union 值，且 deny 溯源用 `reasonCode` 已足够（`config_write` 保留是因为它同时承载审计 permission=null 语义，deny-path 无此需求）。

## Risks / Trade-offs

- **[两套 deny 并存的心智负担] → 已接受**：tool+pattern deny（按工具/命令）与 path-based deny（按路径）语义不同、互补。→ 缓解：spec 明确两者边界与各自适用场景；`reasonCode` 区分溯源（`rule_denied` vs `deny_path_hit`）。
- **[`!` 豁免不作用于 hard 敏感可能让用户困惑] → 已接受**：用户配 `!~/.ssh/id_rsa` 想豁免私钥保护不会生效。→ 缓解：这是刻意的安全基线保留（比 ta-agent 更严），spec scenario 显式声明「`!` 不豁免 hard 敏感」；文档说明 hard 敏感不可配豁免。
- **[deny-glob 与既有 path 声明 glob 语义差异] → 低风险**：deny-glob 只支持 `*`/`**`，path 声明还支持 `?`/`[...]`。→ 缓解：D3 独立 `globDenyToRegExp`，spec scenario 锁定 deny-glob 的最小语义。
- **[性能：配置大 deny 列表] → 可忽略**：O(用户 deny 规则数) path-glob 匹配，用户配置量级小；未配置时短路返回。

## Migration Plan

无数据迁移。纯加法（新 `deny` 段 + 新判定 step）；未配置 `deny` 段时行为不变。回滚 = 移除 `decide()` step 0.5 + `resolveDenyPath` + `deny` 段解析。无 schema 变更（`deny` 是 optional 字段）。

## Open Questions

无（deny-path 位置、`!` 语义、glob 函数归属、三档合并、命中处置 均已裁定）。
