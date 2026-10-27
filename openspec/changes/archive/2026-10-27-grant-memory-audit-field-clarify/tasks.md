# Tasks: Grant-memory audit field & allow-rule boundary clarification (D3)

## T1: D3a spec 修正（不可靠 bash 只查 deny）

- [x] grant-memory spec 查询逻辑段改为明确"不可靠 bash 只查 deny，allow 不生效；可靠 bash allow/deny 均生效"
- [x] 新增场景：不可靠 bash 只查 deny / 不可靠 deny 命中 hard_deny / 可靠 allow 生效
- [x] Verify: `grep -n "只查询 deny\|不可靠.*allow.*不生效" openspec/specs/grant-memory/spec.md`（archive 后）

## T2: D3b spec 修正（grant_type 降级）

- [x] grant-memory spec 审计字段扩展段改为"grant_source 为权威；grant_type/saved_to/reason 不单列必填"
- [x] 新增场景：来源标注以 grant_source 为权威
- [x] Verify: `grep -n "grant_source 为权威" openspec/specs/grant-memory/spec.md`（archive 后）

## T3: 验证

- [x] `openspec validate grant-memory-audit-field-clarify --type change` → passed
- [x] `npm test` → 无回归（无代码变化）
- [x] `openspec validate --all` → all pass
- [x] Verify: 工作区干净，archive counter 更新
