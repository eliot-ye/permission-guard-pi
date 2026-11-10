# Proposal: config-write-hard-deny

## Why

permission.json 写/delete 当前是 `prompt tier=two`（config-self-protect change 落地），理论上**一次人批即可改配置**：agent 弹一次窗、用户误选"允许"，配置即被改写（如写入 `{"**":"read_write"}` 自我提权）。ta-agent 对同类配置自身是**硬 deny 且不受任何记忆豁免**（"否则一次人批即可清空 deny 种子"，`../ta-agent/packages/runtime/src/approval/policy.ts:91-98` 写保护 + `:103-109` 敏感命中）。本 change 把 L2 配置写从 prompt 升级为 `deny_hard`，使配置写与 L1 运行时状态同级的不可绕过防线。

**范围（用户拍板 2026-11-10）**：
- `permission.json`（global/project/local）写/delete → **deny_hard**，不可被 session/persistent grant、配置声明豁免；
- 读 `permission.json` 不受影响（按常规规则）；
- **shell 重定向已覆盖，无需补**（现场证据：可靠 bash 走 `decideTarget` per-target，重定向目标已进 `targets`；不可靠 bash 走 `scanBashProtectedPaths` tokenize 扫描 + `extractRedirects`）。

## What Changes

- `extensions/index.ts` `decideTarget()`：L2 配置写分支从 `prompt tier=two` 改为 `deny_hard`；判定位置从 grant 检查**之后**提前到 **之前**（对齐 L1 运行时状态，不可被 grant 豁免）。`declaration` 保留 `"config_write"`（deny 溯源标记，标明"这次 deny 由配置写自保护触发"，区别于普通 `unconfigured` deny；对齐 L1 用 `unconfigured` 仅是历史选择）。
- `extensions/index.ts` `scanBashProtectedPaths()`：不可靠 bash 命中 L2 时返回 `deny_hard` 而非 `config_write-prompt`；调用侧 `:779/:850` 的 `config_write-prompt` 分支改为走 `logBashSelfProtectDeny`（与 L1 deny 同路径）。
- `src/lib/decision.ts` `Declaration` 联合：**保留** `"config_write"` 值（deny 溯源用），不移除。
- `src/lib/reason-codes.ts` + `src/lib/i18n.ts`：移除 `subtitle_config_write_not_persistable`（deny_hard 不弹窗，无副文本）。
- `extensions/index.ts` 副文本分派：移除 `:1276-1277` 的 `config_write` 分支（该分支在 deny_hard 下永不触达）。
- 契约变更（MODIFIED）：
  - `access-decision`「配置写保护」requirement：从 prompt tier=two 改为 deny_hard（不可被 grant 豁免）；
  - `approval-flow`「配置写弹窗副文本」requirement：删除（deny_hard 不弹窗）；
  - `audit-log`：config_write 相关 scenario 从"用户拒绝弹窗"改为"deny_hard 自动记"；`declaration` 枚举**保留** `config_write`；`grant_source` 派生规则移除 config_write 条目（deny_hard 非 grant 事件，无真人授权来源）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `access-decision`：MODIFIED「配置写保护」——`permission.json` 写/delete 一律 `deny_hard`（不可被 grant/配置声明豁免，对齐 L1 不可绕过不变量）。
- `approval-flow`：REMOVED「配置写弹窗副文本分派」——deny_hard 不弹窗，副文本失效。
- `audit-log`：MODIFIED `declaration` 枚举（移除 `config_write`）+ `grant_source` 派生规则（移除 config_write 条目）+ hard_deny audit scenario（config_write 从 prompt 变 deny_hard）。

## Impact

- **代码**：`extensions/index.ts`（`decideTarget` L2 分支改 deny_hard + 提前到 grant 前 + `scanBashProtectedPaths` L2 返回值改 + 调用侧分支 + 副文本分派移除）；`src/lib/reason-codes.ts` + `src/lib/i18n.ts`（移除副文本码）。`src/lib/decision.ts` `Declaration` **不改**（保留 `config_write` 值）。`src/lib/config-protect.ts` 谓词**不改**（仅调用侧处置变）。
- **行为**：`permission.json` 写/delete 从 prompt tier=two 变 deny_hard（block，无 prompt，`declaration=config_write`）；读不变。
- **依赖**：无新第三方依赖。
- **分系统**：policy-core（`UiCode`/i18n 副文本 -1 键）+ extension-orchestration（`decideTarget` L2 分支改 deny_hard + 判定提前到 grant 前 + `scanBashProtectedPaths` 返回值与调用侧分支 + 副文本分派移除）+ side-effects（audit-log 契约）。

## 系统工程影响评估

（钱学森系统工程主基调第 3 条「从定性到定量的综合集成」。）

- **影响哪些分系统**：policy-core（`Declaration` 联合收窄 -1 值 + `UiCode`/i18n 副文本 -1 键）、extension-orchestration（`decideTarget` L2 分支改 `deny_hard` + 判定提前到 grant 前 + `scanBashProtectedPaths` L2 返回值改）、side-effects（audit-log 契约：config_write 相关 scenario 全改 deny_hard）。bash-extract 模块**不改**。
- **整体性能预期变化**：无新增扫描（复用既有 `isConfigWritePath` 谓词）；行为从 prompt（需用户交互）变 deny_hard（直接 block），**减少一次弹窗交互**。普通路径无性能变化。
- **这是局部优化还是全局协调**：全局协调——把"配置自身完整性"防线从"一次人批可破"升级为"不可绕过"，防止被管控 agent 通过单次误批自我提权（写入 `{"**":"read_write"}`）；与 L1 运行时状态同级防线，统一"门自身状态不可 agent 改"的安全基线。
- **如果是局部优化，对全局失调的风险**：N/A（全局协调）。
- **预期行为模型**：输入「写/delete `permission.json`（无论有无 grant）」→ 期望 `deny_hard`（`{ block: true }`，无 prompt）；输入「读 `permission.json`」→ 常规规则（非 deny_hard）；输入「不可靠 bash 写目标含 permission.json」→ 期望 `deny_hard`。验证：改写 `SYS-CP3/7/9/10` 集成测试断言从 prompt 变 deny_hard；新增 TDD 测试覆盖 grant 不豁免。
- **与既有架构/风格的遵循关系**：完全遵循既有分层与模式——复用既有 `isConfigWritePath` 谓词（不改）、对齐 L1 运行时状态的 `deny_hard` 处置（同 `extensions/index.ts:1136-1145` 模式）、对齐既有 unread/deny 规则的 `deny_hard` 语义。**无偏离**，仅把 L2 处置从 prompt 统一到 deny_hard（与 L1 同级）。

## caller impact 分析

- **变更点清单**：
  - `extensions/index.ts` `decideTarget` L2 分支（`:1204-1213`）：处置从 prompt 变 deny_hard、位置从 grant 后提前到 grant 前、`tier` 字段移除（deny_hard 不带 tier）。**无签名变更**，内部逻辑改。
  - `extensions/index.ts` `scanBashProtectedPaths`（`:518`）：L2 返回值从 `"config_write-prompt"` 变 `"deny_hard"`。**返回类型从三值联合收窄为二值**——调用侧 `:779/:850` 的 `"config_write-prompt"` 分支需同步改走 `logBashSelfProtectDeny`。
  - `extensions/index.ts` 副文本分派（`:1276-1277`）：移除 `config_write` 分支（deny_hard 下永不触达）。
  - `src/lib/reason-codes.ts` `UiCode`：**移除** `subtitle_config_write_not_persistable`——需核对 i18n bundle（`i18n.ts:119/:226`）与分派处已同步移除。
  - `src/lib/decision.ts` `Declaration`：**不改**（保留 `"config_write"` 作为 deny 溯源标记）。
- **高危标记**：
  - `scanBashProtectedPaths` 返回类型收窄：调用侧 `:779/:850` 的 `"config_write-prompt"` 分支若遗漏同步，会编译失败（联合类型不再含该字面量）或运行时分支死代码。**需同步改**。
  - `UiCode` 移除副文本码：i18n bundle 若遗留键、分派处若遗留引用，会 typecheck 失败（`as UiCode` 断言失效）。**需同步移除**。
  - audit-log 集成测试：`SYS-CP3/7/9/10` 断言 prompt/副文本/`allow_session`，需全改为 deny_hard 断言。
- **已知 caller**：`decideTarget` 调用点（`:918/:920/:1003/:1005`）签名未改 → 兼容；`scanBashProtectedPaths` 调用点（`:779/:850`）需同步改分支；副文本码引用（`:1277`）需同步移除。

> 注：caller impact 因**跨分系统**（policy-core + extension-orchestration + side-effects）触发三层防护；变更点含返回类型收窄 + 移除码，非纯新增，需逐点核对兼容。`Declaration` 保留值 → 无 union 变更，降低一档风险。

## Architecture Review

**Verdict: APPROVED**（2026-11-10 收尾 review，subagent 隔离评审）
- reviewed-by: subagent（fresh-context，同模型）
- 报告位置：`reviews/20261110-162027-change-level.md`
- Security 不变量成立：L2 deny 不可被 grant/配置声明/大小写变体/符号链接绕过；bash 重定向写 permission.json 两路均硬拒
- 2处 nit 已修复（过时注释 + spec跨源豁免说明）

## 实际 vs 预期复盘（archive）

（tier-medium，5 字段全填。对照 proposal「系统工程影响评估」节。）

| 维度 | 预期 | 实际 |
|---|---|---|
| **影响分系统** | policy-core（`Declaration` 加值 + 副文本码）、extension-orchestration（`decideTarget` L2 分支 + `scanBashProtectedPaths` + 副文本分派）、side-effects（audit-log 契约） | policy-core（`reason-codes.ts` UiCode -1 键 + `i18n.ts` -2 键）、extension-orchestration（`decideTarget` L2 块提前到 grant 前 + 改 deny_hard + `scanBashProtectedPaths` 收窄返回类型 + 副文本分派移除）、side-effects（沿用 `hard_deny` 形态，**零契约改动**——`declaration:"config_write"` 保留，走 `hard_deny` 事件） |
| **整体性能变化** | 无新增扫描（复用既有 `isConfigWritePath` 谓词）；行为从 prompt变 deny_hard，**减少一次弹窗交互** | 符合预期。L2 检查从 grant 后提前到 grant 前，判定位置提前但谓词 O(1) 不变；行为从 prompt（需用户交互）变 deny_hard（直接 block），弹窗次数减少（SYS-CP3/7/9/10 从 prompt 变 block） |
| **局部 vs 全局** | **全局协调**——把"配置自身完整性"防线从"一次人批可破"升级为"不可绕过"，防止被管控 agent 通过单次误批自我提权 | **全局协调**。与 L1 运行时状态同级防线，统一"门自身状态不可 agent 改"的安全基线；ta-agent 同类配置写也是恒 deny 不受记忆豁免，语义一致 |
| **全局失调风险** | N/A（全局协调） | N/A。session grant便利消失（原"本会话编辑一次"）——用户拍板接受（grant 一律失效，安全优先） |
| **预期行为模型验证** | 「写/delete `permission.json`」→ 期望 deny_hard（block，无 prompt，`declaration=config_write`）；「读」→ 常规规则；「不可靠 bash 写目标含 permission.json」→ deny_hard | **预期模型已验证**。SYS-CP3/4/7/9/10 改写断言从 prompt 变 deny_hard，全绿；SYS-CP9 验证 grant 不豁免（两次都 deny_hard）；SYS-CP11验证 case-variant deny |

### 预期之外的副作用

- **SYS-CP9 语义反转**：原断言"session grant 后仍 prompt config_write"（config-self-protect 设计），本次改为"两次都 deny_hard"——grant 便利通道关闭。用户已拍板（完全对齐 ta-agent「grant 不豁免配置写」）。
- **`config_write` Declaration 值保留**：初版 proposal 曾写"移除 config_write 改用 unconfigured"，调研后修正——`config_write` 是审计溯源标记（标明"deny 由配置写自保护触发"），保留避免审计语义丢失。L1 运行时状态用 `unconfigured` 仅是历史选择，非必须对齐。
- **shell 重定向已覆盖，无需补**：调研初期凭直觉列了"补 shell 重定向覆盖"假设，现场证据证伪——可靠 bash 走 `decideTarget` per-target（`:918/1003`），不可靠 bash 走 `scanBashProtectedPaths`（`:518`，tokenize 扫描含重定向目标）+ `extractRedirects`。这条从范围里剔除。

### scenario→test覆盖账本状态

- SYS-CP3/4/7/9/10 改写断言从 prompt 变 deny_hard，全绿。
- SYS-CP1/2/5/6/8/11 不改（L1 deny / 读放行 / 可靠 bash L1 / case-variant deny），全绿。
- 全量测试 1011/1012（唯一 fail是既有 flaky AL7，git stash 对照基线确认非本次引入）。

### 需求权衡处置

无留待 archive 的矛盾。用户拍板已闭合：grant 一律失效（对齐 ta-agent）+ deny_hard 处置 + 保留 config_write 溯源 + shell 重定向已覆盖。
