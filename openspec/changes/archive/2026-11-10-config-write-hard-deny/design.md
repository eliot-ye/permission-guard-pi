# Design: config-write-hard-deny

## Context

见 proposal.md - Why。config-self-protect change 把 `permission.json` 写/delete 从静默 `auto_allow` 提升到 `prompt tier=two`，但 tier=two 仍可被**一次人批**放行（用户误选"允许"→ 配置即被改写，写入 `{"**":"read_write"}` 自我提权）。ta-agent 对同类配置自身是硬 deny 且不受任何记忆豁免（"否则一次人批即可清空 deny 种子"）。

本 change 把 L2 配置写处置与 L1 运行时状态对齐：**一律 `deny_hard`**，不可被 grant / 配置声明豁免。

## Goals / Non-Goals

**Goals**
- agent 无法通过任何路径（read/write/edit/bash、有/无 grant）写或 delete `permission.json`（global/project/local）——一律 `deny_hard`，无弹窗。
- L2 不可被 session/persistent grant、配置声明豁免（对齐 L1 运行时状态 + 既有 unread 不可绕过不变量）。
- 保持 `isConfigWritePath` 谓词不变（复用，仅调用侧处置变）。
- 保留 `config_write` 作为 deny 溯源 `declaration` 值（审计侧标明"这次 deny 由配置写自保护触发"）。

**Non-Goals**（用户拍板 2026-11-10）
- **不挡读**：读 `permission.json` 按常规规则判定（读不构成提权）。
- **不做** shell 重定向补覆盖——现场证据已覆盖（可靠 bash 走 `decideTarget` per-target，不可靠 bash 走 `scanBashProtectedPaths` + `extractRedirects`），无缺口。
- **不移除** `config_write` `Declaration` 值（deny 溯源需要，非 prompt 专用）。
- **不改** `isConfigWritePath` 谓词签名与实现（判定逻辑不变，仅处置从 prompt 变 deny）。

## Decisions

### D1. 处置：prompt tier=two → deny_hard

`permission.json` 写/delete 一律 `deny_hard`，与 L1 运行时状态（trusted.json/settings.json）同级。

依据（用户拍板 2026-11-10）：tier=two 一次人批即可破（"允许"→ 配置改写 → 自我提权）；ta-agent 对配置自身是硬 deny 且不受记忆豁免；配置是用户手工管理的策略文件，agent 不应经工具调用改（"审批配置由用户手动管理"）。
备选（否决）：保留 session grant 半开（"本会话编辑一次"便利）——用户明确选择 grant 一律失效，完全对齐 ta-agent。

### D2. 判定位置：grant 检查之前（与 L1 对齐）

L2 检查从"grant 之后"提前到"grant 之前"，与 L1 运行时状态检查同段（`decideTarget` 内 unread 之后、grant 之前）。

依据：deny_hard 要不可被 grant 豁免，必须先于 grant 检查（对齐既有 unread + L1 的不可绕过不变量）。原 L2 在 grant 后是因为 prompt 可被 session grant 放行；改 deny_hard 后必须提前。
备选（否决）：保持 grant 后 + grant 分支单独判 deny——重复逻辑，且 grant 命中会先 return auto_allow，无法在 grant 后再 deny。

### D3. `declaration` 保留 `"config_write"`

deny_hard 的 `declaration` 用 `"config_write"`（非 `"unconfigured"`）。

依据：审计溯源——`config_write` 标明"这次 deny 由配置写自保护触发"，区别于普通 unread/deny 规则的 deny。audit-log spec 的 `declaration` 枚举已含 `config_write`，保留避免枚举收窄 + 审计语义丢失。L1 用 `unconfigured` 仅是 config-self-protect change 的历史选择，非必须对齐。
备选（否决）：移除 `config_write` 值改用 `unconfigured`——丢失"配置写 deny"溯源标记，审计无法区分配置写 deny 与普通 deny；且 `Declaration` union 收窄增加不必要的契约 churn。

### D4. bash 处理：`scanBashProtectedPaths` L2 返回 `deny_hard`

- `scanBashProtectedPaths` 返回类型从 `"deny_hard" | "config_write-prompt" | null` 收窄为 `"deny_hard" | null`（L2 命中也返回 `"deny_hard"`）。
- 调用侧两个分支（有 grant `:779`、无 grant `:850`）的 `"config_write-prompt"` 分支删除，L1/L2 统一走 `logBashSelfProtectDeny`（note 前缀区分 grant bypassed / hard-denied）。
- `bashConfigWriteDecision()` 辅助函数删除（不再产生 config_write prompt）。

依据：不可靠 bash 命中 permission.json 也应硬拒（与可靠 bash 经 `decideTarget` 的 deny_hard 一致）；两分支的 L2 prompt 逻辑重复，统一到 deny 后可删 `bashConfigWriteDecision()`。

### D5. 副文本移除

移除 `subtitle_config_write_not_persistable`（`reason-codes.ts` UiCode + `i18n.ts` zh/en bundle）+ `:1276-1277` 副文本分派分支。

依据：deny_hard 不弹窗，副文本失效。保留会成为死代码 + i18n 冗余键。

### D6. 审计：deny_hard 自动记，非真人弹窗

config_write deny 走既有 `hard_deny` 审计路径（`authorization: "presumed"`，无 `grant_source`——非授权事件）。audit-log spec 的 config_write scenario 从"用户拒绝弹窗"改为"deny_hard 自动记"。

依据：deny_hard 是系统决策（非真人授权），对齐 L1 运行时状态 deny 的审计形态（`extensions/index.ts:567-591` `logBashSelfProtectDeny` + `decision.ts` deny_hard 路径）。

## Risks / Trade-offs

- **[覆盖"agent 帮编辑配置"工作流] → 预期内**：agent 不能再经工具调用改 permission.json，只能手工编辑。→ 缓解：用户拍板（选 deny 非 prompt），认为配置应手工管理；config-self-protect change 的 design 曾记录"若用户后续要求 deny 是 D2 的可逆调整"。
- **[session grant 失效] → 预期内**：原"本会话编辑一次"便利消失。→ 缓解：用户拍板 grant 一律失效，安全优先。
- **[SYS-CP9 测试语义反转] → 需同步**：原断言"grant 后仍 prompt config_write"，改后变"grant 后仍 deny_hard"。→ 缓解：tasks 显式改写 SYS-CP3/7/9/10 断言。
- **[返回类型收窄遗漏调用侧] → 编译期可捕**：`scanBashProtectedPaths` 联合收窄后，调用侧 `"config_write-prompt"` 分支会 typecheck 失败。→ 缓解：tsc 强制同步，tasks 4.1 typecheck 兜底。

## Migration Plan

无数据迁移。行为变更纯加严（deny 更多）；回滚 = `decideTarget` L2 分支改回 prompt tier=two + 恢复 `scanBashProtectedPaths` 返回值 + 恢复副文本码。无 schema 变更。`config_write` `Declaration` 值保留，无枚举迁移。

## Open Questions

无（grant 一律失效 + deny_hard 处置 + 保留 config_write 溯源 + 不补重定向 均已裁定）。
