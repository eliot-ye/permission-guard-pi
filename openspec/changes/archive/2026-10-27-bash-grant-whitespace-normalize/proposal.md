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

## 系统工程影响评估

- **预期行为模型**（可验证契约）：
  1. **whitespace 等价命中**：`git status` 授权后 `git  status`（双空格）命中同一 grant——GM21（持久）+ GM22（会话）断言
  2. **参数不同不命中**：`git status` 授权后 `git status --short` 不命中（参数不同 → 不同命令）——GM21 断言
  3. **语义漂移不判等价**：`bash -c "git status"`、`cd /tmp && git status` 不命中（MUST NOT 判等价）——GM21 断言
  4. **audit/grant 键派生一致**：audit 截断记录的 `commandHash` 与 grant 侧 `commandHash` 用同一 `bashCommandHash`——AL9 断言

- **与既有架构/风格的遵循关系**：全部遵循既有约定——`path-utils.ts` 纯函数（无 IO/UI），已是 config/decision/trust 的基础模块；单一事实源（trust 与 audit 共用同一派生）避免 B5 契约漂移；等价语义与 rule 通道（config.ts normalizeWhitespace）对齐。**无偏离点**。

## 实际系统工程影响 vs 预期

（td-archive 步骤 3 强制复盘。对照 proposal 的"系统工程影响评估"节。本复盘为 audit a1 后补写——原归档时缺此节，2026-10-27 system-audit project 发现后闭合。)

- **实际影响的分系统**：`policy-core`（trust.ts hashCommand 改用共享派生）+ `side-effects`（audit.ts truncateCommand 同步）——与预期一致
- **实际整体性能变化**：零性能影响——与预期一致（`normalizeBashCommand` 为常数级 `replace`；哈希成本不变）
- **实际是局部优化还是全局协调**：局部优化（grant 键等价语义对齐 rule 通道）——与预期一致
- **局部优化的实际全局影响**：消除 grant/rule 两套等价语义的不一致；语法级等价显式排除（语义漂移不判等价）——无新安全面，**全局协调更优**（弃 AST 是 de-escalation）——与预期一致
- **模型验证**：
  1. **whitespace 等价命中** ✅ 已验证——GM21（`git  status` 匹配 `git status` 持久 grant）+ GM22（`echo  hi` 匹配 `echo hi` 会话 grant）
  2. **参数不同不命中** ✅ 已验证——GM21（`git status --short` 不命中）
  3. **语义漂移不判等价** ✅ 已验证——GM21 边界断言（`bash -c`/`cd` 不判等价）；文档注释（path-utils.ts）与 Non-Goal 对齐
  4. **audit/grant 键派生一致** ✅ 已验证——AL9（截断记录 `commandHash` 与 grant 侧派生一致）
  - **预期行为模型已验证**（4/4）

- **预期之外的副作用**：无。AL7（并发 audit 序列化）全量跑偶发 700/1——已确认 HEAD 基线既有已知竞态（`al4_af7_flaky_tests_existing`），非本 change 引入；重跑 701/0 全绿。
