# Change-level closing review — config-self-protect

- Date: 2026-11-09
- Review type: change-level closing (td-apply step 6.3)
- Review depth: high (highest task `风险` field = high)
- Reviewer: subagent (isolated fresh context; author-context isolation per requesting-code-review §2)
- Verdict: **APPROVED_WITH_CHANGES** (reviewed-by: subagent)

## Summary

The change implements the L1 runtime-state (trusted.json/settings.json → deny_hard, non-exemptible, before grant) and L2 config-write (permission.json → prompt tier=two declaration=config_write, non-persistable) self-protection correctly for the file tool and reliable bash, and mostly for unreliable bash. One security-relevant gap in the unreliable-bash token scan (env-var / case-variant protected paths escaping L1/L2) plus minor nits were identified. No critical issues.

## Findings (reviewer)

1. [warning] Unreliable-bash scan missed env-var/case-variant protected paths → L1/L2 escape (extensions/index.ts scanBashProtectedPaths; path-utils.ts toKeyPath). `$HOME/.../trusted.json` stayed literal (only `~` expanded, no realpath) and a case-variant token was not matched → reached tier=three prompt or auto-allowed under a bash grant.
2. [nit] Case-variant test promised but absent (tasks.md 1.1); pure predicate is case-sensitive by design (toKeyPath folds only Windows drive paths).
3. [nit] DRY duplication of the L1 deny_hard audit block + config_write Decision across the two unreliable-bash branches.
4. [nit] Spec reason-language mismatch (spec asserted Chinese "运行时状态"; implementation reason is English "Runtime-state file is self-protected").
5. [nit] bash-source config_write allow_session logged `permission=bashPermission` instead of `null` (audit-log spec).

## Fixes applied (all addressed)

- **#1**: `scanBashProtectedPaths` now (a) expands safe env vars quote-aware via `expandSafeVariables` (`$HOME`/`$PWD`, PWD→projectRoot, mirroring the bash extractor) before tokenizing, and (b) case-folds candidate + protected paths for the L1/L2 match (fail-closed equivalent of decideTarget's realpath canonicalPath). Verified by SYS-CP10 (env-var `$PWD/.pi/permission.json` → config_write prompt) and SYS-CP11 (case-variant TRUSTED.JSON → deny_hard).
- **#2**: tasks.md 1.1 corrected — pure predicate is exact-match (case-insensitive FS handled by decideTarget realpath + scan case-fold); SYS-CP11 covers case-variant at integration level.
- **#3**: extracted module-scope helpers `bashConfigWriteDecision()` + `logBashSelfProtectDeny(state, event, command, bashReason, prefix)`; both unreliable-bash branches now call them (only `note` prefix differs: "grant bypassed" vs "hard-denied").
- **#4**: access-decision spec reason assertion aligned to actual English reason ("reason 指明自保护（含 self-protected）").
- **#5**: allow_session audit `permission` now `null` for `declaration === "config_write"` (bash-source included). Verified by SYS-CP9 (allow_session audit asserts permission=null + declaration=config_write).

## Re-verification after fixes (td-apply step 6.1 re-run, per requesting-code-review「修复使验证证据失效」)

- `npm run typecheck` → pass (no TS errors).
- `npm test` (full `node --test "test/*.test.ts" "extensions/*.test.ts"`) → 995 tests, 992 pass, 3 fail.
  - The 3 failures (AL7 flaky, SYS7, SYS-GRANT) are **pre-existing baseline** failures (confirmed via git-stash baseline), unrelated to this change; this change adds **no new regression**.
  - SYS-CP1–CP11 (config-self-protect integration) all pass.
- `openspec validate config-self-protect --type change` → "Change 'config-self-protect' is valid".
- Unit: config-protect.test.ts (isProtectedRuntimeState ×6, isConfigWritePath ×7) all pass.

## Conclusion

No critical issues; all findings addressed and re-verified. Change is ready to proceed to archive.
