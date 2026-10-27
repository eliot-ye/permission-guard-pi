# Design: Bash grant whitespace normalization (P1 e2)

## D1: Shared key derivation — single source of truth

The grant channel (`trust.ts`) and audit channel (`audit.ts`) both derive a `commandHash` from a bash command. Previously they had **duplicated** derivation logic (both `sha256(raw)`), which is a drift risk. This change introduces a **single shared function** so the two channels can never diverge.

**Location**: `src/lib/path-utils.ts` (pure functions, no pi imports, already a foundation module for config/decision/trust).

```ts
export function normalizeBashCommand(rawCommand: string): string {
  return rawCommand.replace(/\s+/g, " ").trim();
}

export function bashCommandHash(rawCommand: string): string {
  return createHash("sha256").update(normalizeBashCommand(rawCommand)).digest("hex");
}
```

`path-utils.ts` already imports `createHash` (for `hashProject`), so no new dependency.

## D2: trust.ts changes

`hashCommand(rawCommand)` now delegates to `bashCommandHash(rawCommand)` (normalized). `bashKey` unchanged (`${projectHash}|${hashCommand(rawCommand)}`). `addBashPersistentGrant` unchanged (it calls `hashCommand(grant.rawCommand)`).

The `createHash` import in trust.ts becomes unused → remove it.

## D3: audit.ts changes

`truncateCommand`'s `commandHash` derivation switches from `createHash("sha256").update(cmd)` to `bashCommandHash(cmd)`. The `createHash` import becomes unused → remove it.

**Consistency contract**: audit `commandHash` now matches grant `commandHash` for the same command, because both use `bashCommandHash`. This is essential for the B5 contract (audit record must be matchable to the authorizing grant).

## D4: Migration — graceful, no schema change

Existing `trusted.json` grants store `commandHash = sha256(rawCommand)` (un-normalized). After this change, lookups use `sha256(normalized(rawCommand))`.

- **Common case** (single-spaced, no padding): `normalize(raw) === raw`, so stored hash still matches → **no migration needed**.
- **Irregular-whitespace grants** (double-space, tabs, padding): stored hash no longer matches → user re-prompts once. Acceptable; rare, and re-authorization is the safe default.

No `trusted.json` rewrite or schema change. This is a **graceful** migration, not a breaking one.

## D5: AST — explored, rejected

Full grammar-level equivalence (e3) was explored and rejected (see proposal). The safe equivalences are lexical; the grammar-level ones are semantic drifts that would wrongly auto-allow. No AST parser is added. This preserves Non-Goal "不做完整 shell 解析".

## D6: Equivalence boundary (documented)

- `git  status` ≡ `git status` (whitespace)
- `  git status  ` ≡ `git status` (padding)
- `git status` ≢ `git status --short` (args differ)
- `bash -c "git status"` ≢ `git status` (shell-forwarder drift)
- `cd /tmp && git status` ≢ `git status` (cwd drift)

## D7: Test strategy

- **GM21** (persistent whitespace equivalence): `git  status` matches `git status` grant; `git status --short` does not.
- **GM22** (session whitespace equivalence): `echo  hi` matches `echo hi` session grant.
- **AL9** (audit commandHash consistency): long command truncation still stamps the correct `bashCommandHash`.

## Trade-offs

- **Benefit**: removes real grant-vs-rule inconsistency; single source of truth for key derivation.
- **Cost**: negligible — one shared function, two call sites updated.
- **Risk**: strict relaxation on whitespace only. Grammar-level equivalence (the risky kind) excluded. Graceful migration.
