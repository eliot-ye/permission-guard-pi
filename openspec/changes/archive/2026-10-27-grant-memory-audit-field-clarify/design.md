# Design: Grant-memory audit field & allow-rule boundary clarification (D3)

## D3a: 不可靠 bash 只查 deny（安全边界文档化）

代码实际行为（extensions/index.ts:677 "Check deny rules for unreliable bash commands (deny takes precedence)"）：不可靠 bash 只查 deny 规则，不查 allow。这是**有意安全设计**——不可靠命令无法静态解析 target，若 allow 规则放行会绕过敏感检查（如 `git *` 让 `git clone evil.sh` auto-allow）。

spec 原"任一击中即 auto-allow"是过度要求。修正为明确边界：
- 可靠 bash → allow/deny 均生效（decideTarget 逐 target 判定）
- 不可靠 bash → 只查 deny（allow 不生效，走 tier=three 弹窗）

## D3b: grant_type 降级（grant_source 为权威）

`grant_source` 枚举（config_declaration | allow_rule | grant_memory | bash_grant_memory | default）已完整区分来源且所有 audit.log 调用点都有该字段。`grant_type`（path/bash/rule）是粗粒度冗余。`saved_to`/`reason` 已由 `note` 覆盖（路径/原因）。

修正为：`grant_source` 为权威来源标注；`grant_type` 不单列为必填；`saved_to`/`reason` 不单列为必填（note 已覆盖）。

## 无代码变化

纯 spec 修正（契约对齐）。无代码行为变化——spec 对齐到代码的实际安全行为。

## Trade-offs

- **Benefit**：消除 spec 超前于实现造成的契约漂移；明确不可靠 bash 的安全边界（allow 不生效）。
- **Cost**：无（纯 spec）。
- **Risk**：无（不改变任何行为）。
