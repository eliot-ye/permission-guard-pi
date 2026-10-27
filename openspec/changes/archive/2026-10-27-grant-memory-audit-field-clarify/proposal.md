# Change: Grant-memory audit field & allow-rule boundary clarification (D3)

## Metadata
- **Status**: proposal
- **Change Type**: spec clarification (contract alignment)
- **Spec Driven**: yes
- **Source**: reverse-spec 2026-10-27 检出漂移 D3；用户拍板 k1（D3a/D3b 都改 spec）

## Why

reverse-spec（2026-10-27）检出 grant-memory Req 8 两处 spec-代码漂移，经 explore 确认性质：

- **D3a：不可靠 bash 只查 deny 规则**——`extensions/index.ts:677` 注释明确 "Check deny rules for unreliable bash commands (deny takes precedence)"。**有意设计**（安全保守）：可靠 bash 经 `decideTarget`（decision.ts:214）查 allow 规则 → auto_allow；不可靠 bash 无法静态解析 target，若 allow 规则放行会绕过敏感检查。spec "任一击中即 auto-allow" 是**过度要求**。
- **D3b：grant_type/saved_to/reason 审计字段从未实现**——`grant_source` 枚举（`config_declaration | allow_rule | grant_memory | bash_grant_memory | default`）已完整区分授权来源且所有 audit.log 调用点都有 `grant_source`。`grant_type`（path/bash/rule）是粗粒度冗余；`saved_to`/`reason` 是结构化增强但 `note` 已含路径/原因。

## What Changes

- **D3a**：grant-memory spec 查询逻辑段改为明确"不可靠 bash 命令只查询 deny 规则（deny 优先），allow 规则对不可靠命令不生效；可靠 bash 命令才经规则解析（allow/deny 均生效）"——安全边界文档化。
- **D3b**：grant-memory spec 审计日志字段扩展段改为以 `grant_source` 为权威来源标注（`grant_type` 降级为可选/移除，`saved_to`/`reason` 作为 note 内容已覆盖，不再单列必填字段）。

## Impact

- **纯 spec 修正**：无代码变化。spec 与代码实际行为对齐（不可靠 bash 只查 deny；来源标注用 grant_source）。
- **安全**：明确 allow 规则对不可靠命令不生效（防绕过敏感检查），文档化既有安全设计。

## Caller impact analysis

- 无代码调用方变化。
- spec 读者：明确不可靠 bash 的规则查询边界（只 deny），以及审计来源标注用 `grant_source`。

## Risk

- **无风险**（纯 spec 澄清，无行为变化）。这是把 spec 对齐到代码的**实际安全行为**（不可靠命令只 deny 保守），不是放宽。

## Verification

- `openspec validate grant-memory-audit-field-clarify --type change` → passed。
- `npm test` → 无回归（无代码变化）。
- `openspec validate --all` → all pass。

## System Engineering Assessment

- **Subsystem**：policy-core（grant-memory spec）。
- **Tier**：medium。
- **Impact scope**：spec 澄清（契约对齐），无代码变化。
- **实际影响 vs 预期**：把 spec 对齐到代码的实际安全行为（不可靠 bash 只 deny；grant_source 为权威来源标注）——消除 spec 超前于实现造成的契约漂移。
