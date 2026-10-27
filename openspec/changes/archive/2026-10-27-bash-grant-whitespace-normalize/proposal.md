# Change: Bash grant whitespace normalization (P1 e2)

## Metadata
- **Status**: proposal
- **Change Type**: behavior (boundary refinement)
- **Spec Driven**: yes
- **Source**: P1 design decision (g1 — adopt e2 whitespace normalization, drop AST)
- **Related Change**: `audit-bash-grant-boundary-hygiene` (B2-B6), `permission-enable-toggle`

## Why

The permission guard has two bash-command channels with **divergent equivalence semantics**:
| Channel | Match semantic | Location |
|---|---|---|
| Bash grant (session/persistent) | **Exact** `sha256(rawCommand)` | `trust.ts` `bashKey` |
| Bash rule (tool+pattern) | **Whitespace-normalized** `replace(/\s+/g," ").trim()` | `config.ts` `normalizeWhitespace` |

Same system, two equivalence judgments. A user who authorized `git status` (single space) gets re-prompted for `git  status` (double space), while the rule channel treats them as equivalent. This is a real user-facing inconsistency — the grant channel is needlessly strict relative to the rule channel.

## What (behavior change)

`hashCommand` (the grant key derivation) now normalizes whitespace **before** hashing, matching the rule channel. Equivalence is **lexical whitespace only** — no grammar-level equivalence.

### The AST question (explored, rejected)

We explored building a full AST-based equivalence (e3). **Rejected**:

- Bash grants only persist for **unreliable** bash commands (`extractBashTargets` returns `reliable: false`). These are exactly the commands static analysis **cannot** reliably parse (control flow, shell forwarders, unresolved variables).
- The grammar-level equivalences an AST would enable (`bash -c "git status"` ≡ `git status`, `cd /tmp && git status` ≡ `git status`) are **semantic drifts** — treating them as equivalent would **wrongly auto-allow** (a user authorizing `git status` would then also auto-allow `cd /etc && git status`).
- **Net: AST has negative security value.** The safe equivalences (`;`-joining, redirect stripping) are achievable at the lexical level; the unsafe ones are exactly the ones AST would enable.
- AST also directly conflicts with Non-Goal "不做完整 shell 解析" (security-boundary-docs), requiring a doc rewrite for negative benefit.

### Equivalence boundary (settled)

- `git  status` (double space) ≡ `git status`
- `  git status  ` (padding) ≡ `git status`
- `git status` ≢ `git status --short` (args differ)
- `bash -c "git status"` ≢ `git status` (shell-forwarder semantic drift — NOT equivalent)
- `cd /tmp && git status` ≢ `git status` (cwd drift — NOT equivalent)

## What Changes

- Grant key derivation normalizes whitespace before hashing (matching rule channel).
- Audit channel uses the same shared key derivation (B5 consistency).
- Equivalence is lexical whitespace only; grammar-level equivalence explicitly excluded.

## Impact

- **Callers of `hashCommand`**: internal to `trust.ts` (`bashKey`, `addBashPersistentGrant`). No public API change — the function name/arity is unchanged, only the key derivation normalizes whitespace.
- **Audit channel** (`audit.ts` `truncateCommand`): switched to the same shared `bashCommandHash` so audit records match grants (preserves B5 contract).
- **Existing trusted.json grants**: common-case grants (single-spaced rawCommand) still match because `normalize(raw) === raw`. Only grants with irregular whitespace (double-space, tabs, padding) need re-authorization — user re-prompts once. **Graceful migration, no schema change.**

## Caller impact analysis

- `trust.ts`: `bashKey`, `addBashPersistentGrant` — updated to shared derivation.
- `audit.ts`: `truncateCommand` — updated to shared derivation.
- `extensions/index.ts`: callers of `hasBashSessionGrant`/`hasBashPersistentGrant`/`addBashPersistentGrant` — unchanged API; behavior is transparently more lenient on whitespace.

## Risk

- **Low**. The change is a strict relaxation on whitespace only. Grammar-level equivalence (the risky kind) is explicitly excluded.
- A user granting `git status` will now also match `git  status` — this is the intended fix, not a vulnerability (the extra space does not change command semantics for whitespace-separated commands).

## Verification

- RED: GM21/GM22 (whitespace equivalence, session + persistent) fail before, pass after.
- AL9 (audit commandHash) still passes — shared derivation is consistent.
- Full suite: 701/701 pass.
- typecheck: 0 new errors.
- Spec validation: `openspec validate --all`.

## System Engineering Assessment

- **Subsystem**: policy-core (grant memory) + side-effects (audit).
- **Tier**: medium (grant key semantics is a policy-core concern; audit consistency is side-effects).
- **Impact scope**: behavior refinement, no schema change, graceful migration.
- **Actual impact vs expected**: The change removes a real inconsistency (grant vs rule equivalence). No new security surface — grammar-level equivalence explicitly excluded. This is a **de-escalation** of complexity (rejected AST), aligning with "最小安全等价".
