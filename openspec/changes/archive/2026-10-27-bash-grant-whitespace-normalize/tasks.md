# Tasks: Bash grant whitespace normalization (P1 e2)

## T1: Add shared normalizeBashCommand + bashCommandHash to path-utils.ts

- [x] Add `normalizeBashCommand(rawCommand): string` (whitespace collapse + trim)
- [x] Add `bashCommandHash(rawCommand): string` (sha256 of normalized)
- [x] Document equivalence boundary in the module comment (lexical only, no grammar-level)
- [x] Verify: `grep -n "normalizeBashCommand" src/lib/path-utils.ts`

## T2: Update trust.ts hashCommand to use shared derivation

- [x] Import `bashCommandHash` from `./path-utils.ts`
- [x] `hashCommand(rawCommand)` delegates to `bashCommandHash(rawCommand)`
- [x] Remove unused `createHash` import
- [x] Verify: `grep -n "bashCommandHash" src/lib/trust.ts`; `grep -n "createHash" src/lib/trust.ts` → no match

## T3: Update audit.ts truncateCommand to use shared derivation

- [x] Import `bashCommandHash` from `./path-utils.ts`
- [x] `commandHash` derivation uses `bashCommandHash(cmd)`
- [x] Remove unused `createHash` import
- [x] Verify: `grep -n "bashCommandHash" src/lib/audit.ts`; `grep -n "createHash" src/lib/audit.ts` → no match

## T4: TDD — RED then GREEN

- [x] RED: GM21 (persistent whitespace equivalence) + GM22 (session whitespace equivalence) fail before
- [x] GREEN: GM21/GM22 pass after; AL9 (audit commandHash consistency) still passes
- [x] Verify: `node --test test/trust.test.ts test/audit.test.ts` → 0 fail

## T5: Spec delta — grant-memory

- [x] Add requirements: whitespace equivalence / args-differ / semantic-drift / audit-grant consistency
- [x] Add scenarios: whitespace hit / args-differ miss / semantic-drift miss
- [x] Verify: `openspec validate bash-grant-whitespace-normalize --type change` → passed

## T6: Docs — security-boundary-docs + README

- [x] Update Non-Goal "不做完整 shell 解析" with P1 e2 equivalence boundary (lexical only)
- [x] Verify: `grep -n "normalizeBashCommand" docs/security/permission-model.md`

## T7: Full validation

- [x] `npm test` → 701/701 pass
- [x] typecheck → 0 new errors
- [x] `openspec validate --all` → all pass
- [x] Verify: full suite green, working tree clean after commit
