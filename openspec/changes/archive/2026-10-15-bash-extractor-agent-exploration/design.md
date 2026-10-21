## Context

See proposal.md for motivation - don't restate it.

This change modifies three existing capabilities in the permission system:
1. `bash-target-extraction`: core bash command target extraction logic
2. `grant-memory`: authorization memory storage
3. `approval-flow`: permission prompt UI

The root problem is two-fold:
- False positives in write target extraction for benign `/dev/` redirects
- Over-broad unreliable classification for safe read-only glob patterns in project-scoped commands
- Lack of command-scoped memory for bash prompts, forcing users to repeatedly allow identical command strings

## Goals / Non-Goals

**Goals:**
- Eliminate false positive write target extraction for fd/device redirects to `/dev/*`
- Implement bounded glob detection to auto-allow read-only commands with project-scoped glob patterns
- Add bash-command-scoped memory channel to grant-memory, allowing session-scoped and persistent remembers of identical command strings
- Update approval-flow to show contextual subtitles for bash command prompts and support bash-command memory grant flow
- Maintain backward compatibility: existing behavior for all other command patterns unchanged
- No changes to config schema, decision engine, audit log structure (only additive fields)

**Non-Goals:**
- Do not change the core three-tier memory model (projectHash|action|absPath) for path-based grants
- Do not introduce command glob pattern matching or command prefix wildcards (e.g., "remember all `git log` commands")
- Do not alter the semantics of existing `reason` values (only add new ones)
- Do not modify sensitive path detection or trust store file format beyond additive grant types
- Do not change prompt UI beyond adding new subtitle cases and remembering bash command strings

## Decisions

### Bounded Glob Detection Logic
**Chosen**: In `scanUnreliable`, before flagging a glob metacharacter as unreliable, compute the prefix path up to the glob character, expand `~`, resolve to absolute, and check if it is strictly inside projectRoot and contains no `../`. If yes, and if the pipeline stage's first command is in the read-only allowlist, then skip unreliable flagging.
**Alternatives considered**:
- Always allow globs inside projectRoot for any command: rejected because write/delete commands with globs (e.g., `rm -rf /tmp/*.log`) remain risky.
- Allowlist based on command name only: rejected because some read-only commands (like `cat`) can still be dangerous if pointed at sensitive files, but the glob prefix check already bounds the risk to project inner.
- Post-extraction filtering: rejected because unreliable flagging happens early to avoid unnecessary work; better to prevent the flag entirely.

### Device Redirect Skipping
**Chosen**: In `extractRedirects`, after computing the absolute path of a redirect target, if the path starts with `/dev/` (case-sensitive), skip pushing it as a write target.
**Alternatives considered**:
- Skip all special files under `/dev`, `/proc`, `/sys`: rejected because `/dev` is the conventional sink for fd redirects in shell (`>/dev/null`, `2>&1` etc); `/proc` and `/sys` are less common and may carry security implications if written to (though rare).
- Use a configurable list of "null sink" paths: rejected because `/dev/*` is a well-established convention and configurability adds complexity for little gain.
- Skip based on file type (character device, etc): rejected because requires syscall (stat) which breaks the pure function nature of the extractor.

### Bash Command Memory Key Design
**Chosen**: Use `projectHash|SHA256(rawCommand)` as the session/persistent grant key for bash commands. Store an additional `grant_type` field to distinguish path vs command grants in trust store and audit.
**Alternatives considered**:
- Use full rawCommand as key: rejected because keys would be very long and unwieldy in trusted.json and memory maps.
- Normalize the command (e.g., collapse whitespace, expand ~): rejected because normalization is lossy and may change semantics; rawCommand preserves exact user input for audit and reproducibility.
- Separate trust store for bash commands: rejected because adds complexity; better to extend existing trust store with a type discriminator.

### Allowlist of Read-Only Commands
**Chosen**: Explicit enumerated list based on common developer tools and unix utilities that are predominantly read-only: `cat`, `head`, `tail`, `wc`, `grep`, `find`, `ls`, `tree`, `stat`, `du`, `df`, `file`, `less`, `more`, `git log`, `git show`, `git diff`, `git status`, `git ls-files`, `git branch`, `git tag`, `git remote`, `git config`.
**Alternatives considered**:
- Derive from COMMAND_TABLE by checking if command lacks write target extraction: rejected because some commands like `git` have subcommands that are read/write (e.g., `git rm`), and the extractor doesn't know subcommand semantics.
- Use a heuristic: "commands that don't appear in write target command list": rejected because too broad and would include unsafe commands like `echo` (which can write via redirection).
- Empty allowlist (i.e., no auto-allow for any glob): rejected because defeats the purpose of reducing UX friction for AI exploration.

## Risks / Trade-offs

**Risk**: Bounded glob detection may incorrectly allow a glob whose prefix is inside projectRoot but whose actual expansion includes sensitive files outside (e.g., via symlink chain).
**Mitigation**: The glob prefix check is conservative: it only allows when the prefix is inside projectRoot and the command is read-only. Even if expansion leaves projectRoot via symlink, the command is read-only so cannot modify files. Worst case is disclosure of outer-sensitive content via read-only command, which is already possible by directly specifying the outer path; the glob does not increase risk beyond what a user could manually type.

**Risk**: Device redirect skipping may miss other sink paths like `/dev/full` (which returns ENOSPC on write).
**Mitigation**: `/dev/full` is rare and writing to it fails with ENOSPC, which is not a security concern. The goal is to eliminate false positives for the extremely common `/dev/null`, `/dev/zero`, `/dev/stderr` patterns. Adding `/dev/full` would be safe but adds little value.

**Risk**: Bash command memory may allow a dangerous command string to be auto-allowed in a new session if the user previously chose "总是允许".
**Mitigation**: This is by design and mirrors the existing path-level "总是允许" behavior. Users are expected to understand that "总是允许" means persistent across sessions. Audit logs record the grant type and command hash for review.

**Risk**: Adding new `reason` values (`bounded_glob`, `device_redirect`) may break consumers that hardcode reason strings.
**Mitigation**: The only consumer in the codebase is `extensions/index.ts:346` which uses `${extraction.reason}` dynamically for audit logging. No hardcoded matches exist. Future consumers should be warned to treat reason as an open set.

**Risk**: Increased code complexity in bash-extract.ts.
**Mitigation**: The changes are localized and well-tested. The bounded glob logic adds ~20 lines; device redirect skipping adds ~5 lines. Both are pure functions with no side effects.

## Open Questions

None.

## Migration Plan

This change is additive and backward compatible. No migration steps are required.

At archive time:
1. Update `src/lib/bash-extract.ts` with bounded glob and device redirect logic
2. Update `src/lib/trust.ts` with bash grant memory functions and Grant type field
3. Update `extensions/index.ts` to check and write bash command memory
4. Update test files to cover new scenarios
5. Update specs in `openspec/specs/` via the normal spec promotion flow

## Open Questions

None.

