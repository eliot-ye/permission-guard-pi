# Tasks: Audit auto-allow record completeness (D1/D2)

## T1: D4 — bash hard_deny 补 authorization

- [x] index.ts:749 可靠 bash hard_deny 补 `authorization: "presumed"`
- [x] SYS-B2a RED→GREEN
- [x] Verify: `node --test --test-name-pattern=SYS-B2a extensions/index.test.ts` → pass

## T2: D2 — 文件工具 auto_allow 补审计

- [x] index.ts:838 auto_allow 分支，非例外（reasonCode !== in_project_default_allowed）补 `audit.log({ event: "auto_allow", ... })`
- [x] SYS-B2b RED→GREEN
- [x] Verify: `node --test --test-name-pattern=SYS-B2b extensions/index.test.ts` → pass

## T3: D3 — 可靠 bash auto_allow 补审计

- [x] index.ts:768 per-target 循环补命令级 `audit.log`（autoAllowLogged 标志，once per call）
- [x] SYS-B2c RED→GREEN
- [x] Verify: `node --test --test-name-pattern=SYS-B2c extensions/index.test.ts` → pass

## T4: Spec delta — audit-log

- [x] 新增「auto_allow 决策记录完整性」+「bash hard_deny 携带授权来源标注」requirement
- [x] Verify: `openspec validate audit-autorecord-completeness --type change` → passed

## T5: 全量验证

- [x] `npm test` → 704/704 pass
- [x] typecheck → 0 new errors
- [x] Verify: `openspec validate --all` → all pass；工作区干净
