// Bash extraction: shell forwarders (bash -c), wrappers, cd-chdir, forwarders (xargs).
// Pure module — no IO / no side effects.

import { splitCommands, splitPipelines, tokenize } from "./parse.ts";
import { isReadOnlyWithArgs } from "./readonly.ts";

export const FORWARDING_COMMANDS = new Set(["xargs", "parallel", "pforeach"]);

/**
 * Check whether the downstream command of a forwarder (xargs/parallel/pforeach)
 * is read-only and statically determinable. If so, the forwarder stage is
 * exempted from the `forwarding_command` unreliable classification.
 *
 * Logic (design.md D4):
 * 1. Tokenize the forwarder stage.
 * 2. Skip the forwarder itself (first token) and its flag arguments (tokens
 *    starting with `-`).
 * 3. The first non-flag token is the downstream command name.
 * 4. Check it belongs to READ_ONLY_COMMANDS (including `git_<sub>` form).
 * 5. Check the remaining downstream arguments are statically determinable:
 *    no `$` (except safe specials `$?`/`$!`/`$#`/`$$`), no backtick,
 *    no `$()`, no unquoted glob (`* ? [`).
 * 6. If all checks pass, return `true` (exempt); otherwise `false`.
 */
// (isForwarderDownstreamReadOnly removed in Stage A; superseded by
// isForwarderStageSafe which also validates upstream stages. Kept a
// short marker comment here for history.)

/**
 * Check whether the downstream command of a forwarder stage satisfies the
 * read-only exemption conditions (design.md D4). Reused by
 * `isForwarderStageSafe` to validate both the current stage's downstream
 * and each upstream stage's downstream.
 *
 * Returns true in two cases:
 * 1. The forwarder has a real downstream command that is read-only and
 *    statically determinable.
 * 2. The forwarder has only flag arguments (e.g. `xargs --help`, `xargs -n 1`
 *    with no downstream command) — no actual command execution happens.
 *
 * Returns false if the downstream command is a write operation, or if any
 * downstream argument contains `$` (non-special), backtick, `$()`, or an
 * unquoted glob character.
 */

export function isForwarderDownstreamExempt(stage: string): boolean {
  const tokens = tokenize(stage);
  if (tokens.length === 0) return false;
  // Skip forwarder (first token) and flag arguments.
  let idx = 1;
  while (idx < tokens.length && tokens[idx].startsWith("-")) {
    idx += 1;
  }
  // No downstream command — either empty (only the forwarder itself) or all
  // remaining tokens are flags (e.g. `xargs --help`). Either way, no real
  // command execution happens, so this stage is safe.
  if (idx >= tokens.length) return true;
  const downstreamCmd = tokens[idx].split("/").pop()!;
  if (!isReadOnlyWithArgs(downstreamCmd, tokens.slice(idx + 1))) return false;
  // Check remaining downstream arguments for static determinability.
  for (let j = idx + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok.includes("$")) {
      const varMatches = tok.match(/\$\w+/g);
      if (varMatches) {
        for (const vm of varMatches) {
          const varName = vm.slice(1);
          if (!["?", "!", "#", "$"].includes(varName)) return false;
        }
      }
    }
    if (tok.includes("`")) return false;
    if (tok.includes("$(")) return false;
    if (/[?*\[]/.test(tok)) return false;
  }
  return true;
}

/**
 * Check whether a forwarder stage is safe from the `forwarding_command`
 * unreliable classification. Replaces `isForwarderDownstreamReadOnly`
 * (which only checked the current stage's downstream) by additionally
 * verifying all upstream stages are read-only (design.md D4).
 *
 * Returns true (safe) iff:
 * 1. The current stage's downstream is read-only and statically determinable.
 * 2. Every upstream stage (indices 0..stageIdx-1) has a read-only leading
 *    command (via `isReadOnlyWithArgs`). Upstream stages that are
 *    themselves forwarders are recursively checked via
 *    `isForwarderDownstreamExempt`.
 *
 * An empty stages array returns true (trivially safe).
 */

export function isForwarderStageSafe(stageIdx: number, stages: string[]): boolean {
  if (stages.length === 0) return true;
  if (stageIdx < 0 || stageIdx >= stages.length) return false;
  if (!isForwarderDownstreamExempt(stages[stageIdx])) return false;
  for (let i = 0; i < stageIdx; i++) {
    const tokens = tokenize(stages[i].trim());
    if (tokens.length === 0) continue;
    const base = tokens[0].split("/").pop()!;
    if (FORWARDING_COMMANDS.has(base)) {
      if (!isForwarderDownstreamExempt(stages[i])) return false;
    } else {
      const tokensForArgs = tokens.slice(1);
      if (!isReadOnlyWithArgs(base, tokensForArgs)) return false;
    }
  }
  return true;
}

// Silent commands (D8, structured since bash-stage-b-security-fixes):
// development-tool commands whose filesystem side effects are constrained to
// the project worktree — PROVIDED the subcommand itself is a read-only one.
// They are treated as 0-target silent: even if they take file-like arguments,
// we do NOT extract them as targets because their semantics differ from the
// generic shell tools.
//
// IMPORTANT: keep disjoint from COMMAND_TABLE. Commands already in
// COMMAND_TABLE (tree/du/df/file/less/more) take precedence and are NOT in
// SILENT_COMMANDS.
//
// Structure: `{ cmdName: Set<subcommand> }`. Commands with empty allow-set
// mean "no subcommand required — flag-only invocation is silent, but any
// bare positional token is not". `SILENT_ALLOW_ALL` marks commands whose
// empty allow-set means "any subcommand is silent" (openspec is our own
// project tool).
//
// This is a deliberate narrowing of the pre-Stage-B command-name-only
// whitelist: `npm run build`, `git log /etc/passwd`, `rg pattern /etc/shadow`,
// `jq . /etc/shadow`, `make -f /tmp/evil.mk`, `cargo run --manifest-path ...`
// are no longer silent (they can read/write outside the worktree).

export const SHELL_NAMES = new Set(["bash", "sh", "dash", "zsh"]);

// Wrapper commands that are env modifiers: they may prefix a shell forwarder
// (or an unreliable command) without changing the inner command's semantics.
// - `env`, `command`: classic env modifiers (see skipWrapperTokens docs).
// - `sudo`: privilege elevation — inner command runs unchanged.
// - `nohup`: ignore SIGHUP — inner command runs unchanged.
// - `timeout`: wall-clock limit — takes a duration as a positional arg.
// - `watch`: periodic loop — inner command runs unchanged.
// - `nice`: priority adjustment — takes a level via `-n LEVEL`.
// bash-hardening-round-2 (L2) added the last five: they were previously
// invisible to both the shell-forwarder guard and the unreliable-command
// guard, letting `sudo bash -c '...'` / `timeout 5 bash -c '...'` /
// `nice -n 10 bash -c '...'` slip through as silent passes.

export const SHELL_WRAPPER_NAMES = new Set([
  "env", "command",
  "sudo", "nohup", "timeout", "watch", "nice",
]);

// Duration / priority value-taking flags that skipWrapperTokens must consume
// an extra token for. Each entry is a wrapperName → set of short flags that
// take a value. Kept separate from the generic "short flag without value"
// branch (which does NOT consume the following token) so `timeout 5 bash -c
// ...` and `nice -n 10 bash -c ...` are not mis-tokenized (L2 sub-task
// D2.1 in design.md).

export const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  // `timeout` duration is a POSITIONAL (not a flag), handled separately.
  // `nice -n LEVEL` — only `-n` takes a value; the other nice flags (-a, -e,
  // -i, -m, -N, -p, -r, -w, -W) are value-less.
  nice: new Set(["-n"]),
};

/**
 * Skip a wrapper (`env` or `command`) and its argument tokens, returning
 * the index of the first non-wrapper argument. Shared by
 * `isAnyUnreliableCommand` and `isShellForwarder` — they had identical
 * logic that had drifted apart, causing `command -v sed` and `env -u FOO
 * bash /tmp/x.sh` to be misclassified (see phase 10.4b).
 *
 * The flag-skip rules differ by wrapper:
 *
 *   `command` builtin:
 *     - `-v NAME`, `-V NAME` — query flags that take a name argument.
 *       The name is a QUERY TARGET, not a command invocation. So `command
 *       -v sed` prints where sed is; sed is NOT executed.
 *     - `-p` — no value; next non-flag token IS the command to invoke.
 *     - Otherwise (no flags or `-p`): next non-flag token is the invocation.
 *
 *   `env`:
 *     - `-u NAME`, `-C DIR`, `-P ARG`, `-S SCRIPT`, `-I SCRIPT` — take a
 *       value (NAME/DIR/ARG/SCRIPT). The value is NOT a command invocation.
 *     - `-i`, `-v`, `-V`, `-a`, `-0` — no value.
 *     - After skipping flags/values: next non-flag token is the invocation.
 *
 * Common to both:
 *     - `KEY=VAL` assignments (env-style) — consume as-is
 *     - `--flag` / `--flag=value` — consume as-is
 *     - `-flag=value` form — consume as-is
 *
 * @param tokens Token array (one fragment's tokens).
 * @param startIdx Index of the first token AFTER the wrapper name.
 * @param wrapperName The basename of the wrapper (`"env"` or `"command"`).
 * @returns Index of the first non-wrapper argument (the actual command).
 */

export function skipWrapperTokens(tokens: string[], startIdx: number, wrapperName: string): number {
  const isCommandBuiltin = wrapperName === "command";
  // `timeout` accepts exactly ONE positional argument before the inner
  // command (the duration: `5`, `1m`, `1h30m`, ...). We track whether we
  // have consumed it so the branch fires only once; after that, scanning
  // resumes the normal path and the next non-flag token IS the command.
  // (bash-hardening-round-2 L2 D2.1 in design.md.)
  let consumedTimeoutDuration = false;
  let i = startIdx;
  while (i < tokens.length) {
    const tok = tokens[i];
    // KEY=VAL assignment
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { i += 1; continue; }
    // Long flag
    if (tok.startsWith("--")) { i += 1; continue; }
    // `timeout` duration is a POSITIONAL (not a flag) — first non-flag,
    // non-assignment token right after the wrapper name is consumed as the
    // duration, then scanning continues to find the inner command. Without
    // this special-case, `timeout 5 bash -c '...'` would treat `5` as the
    // inner command and isShellForwarder would miss the bash forwarder.
    if (
      wrapperName === "timeout" &&
      !consumedTimeoutDuration &&
      !tok.startsWith("-")
    ) {
      consumedTimeoutDuration = true;
      i += 1;
      continue;
    }
    // `-v NAME` / `-V NAME` on `command` — consume the name as query target.
    if (isCommandBuiltin && (tok === "-v" || tok === "-V")) {
      i += 2;
      continue;
    }
    // `env` flags that take a value: -u NAME, -C DIR, -P ARG, -S SCRIPT, -I SCRIPT.
    // (Deliberately excludes -i, -v, -V, -a, -0 which are value-less.)
    if (!isCommandBuiltin &&
        (tok === "-u" || tok === "-C" || tok === "-P" || tok === "-S" || tok === "-I")) {
      i += 2;
      continue;
    }
    // Wrapper-specific value-taking short flags. Only `nice -n LEVEL` and
    // `watch -n DELAY` today; both take a duration/level as the next token,
    // which is NOT the command. Without this, `nice -n 10 bash -c '...'`
    // would leave `10` as the apparent inner command and miss the forwarder
    // (L2 D2.1 in design.md).
    const wrapperValueFlags = WRAPPER_VALUE_FLAGS[wrapperName];
    if (wrapperValueFlags?.has(tok)) {
      i += 2;
      continue;
    }
    // Other short flags — consume as-is (no value).
    if (tok.startsWith("-")) { i += 1; continue; }
    // Non-flag, non-assignment token — the actual command of this fragment.
    break;
  }
  return i;
}

// Detects `bash -c "..."` / `sh -c` / `dash -c` / `zsh -c`, INCLUDING
// `bash /tmp/x.sh` (script path as positional arg) and `source` / `.`
// (dot-source), plus `env KEY=VAL bash -c "..."` and option clusters
// like `-xc`. Non-flag positional args count as script paths — anything
// that runs file contents is a shell forwarder.
//
// Compound commands (`&&`, `||`, `;`, `&`, `\n`) are split first so a
// shell forwarder in any fragment is caught, not just the first.
// (Phase 10.4a: fixed `echo hi && bash /tmp/evil.sh` bypass.)

export function isShellForwarder(cmd: string): boolean {
  // Split compound commands first, then each fragment's pipeline stages.
  for (const fragment of splitCommands(cmd)) {
    if (!fragment.trim()) continue;
    const stages = splitPipelines(fragment);
    for (const stage of stages) {
      const trimmed = stage.trim();
      if (!trimmed) continue;
      const tokens = tokenize(trimmed);
      if (tokens.length === 0) continue;

      if (isShellForwarderTokenStream(tokens)) return true;
    }
  }
  return false;
}

/**
 * Scan a single token stream (one pipeline stage) for a shell forwarder
 * pattern. Extracted from `isShellForwarder` so we can call it per stage.
 */

export function isShellForwarderTokenStream(tokens: string[]): boolean {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const base = tok.split("/").pop()!; // strip path prefix

    if (SHELL_WRAPPER_NAMES.has(base)) {
      // Skip wrapper's own arguments: KEY=VAL assignments and short/long flags.
      i = skipWrapperTokens(tokens, i + 1, base);
      continue;
    }

    if (SHELL_NAMES.has(base)) {
      // Look ahead for a `-c` flag OR a non-flag positional (script path).
      // Any positional argument means "execute this file's contents", which
      // is a shell forwarder (bash /tmp/x.sh, bash -x /tmp/x.sh, etc.).
      // Long flags (`--posix`, `--norc`, `--noprofile`, `--rcfile FILE`,
      // etc.) are legal bash options that do NOT disable `-c` — the scan
      // must skip them and keep looking (`bash --posix -c '...'` is
      // equivalent to `bash -c '...'` in POSIX mode). Breaking on the
      // first long flag was the L1 bypass in bash-hardening-round-2.
      for (let j = i + 1; j < tokens.length; j++) {
        const arg = tokens[j];
        if (arg === "-c") return true;
        // Option cluster like `-xc`, `-lc`, `-xec`: single `-` followed by
        // letters, one of which is `c`. (bash parses `-xc` as `-x -c`.)
        if (/^-[A-Za-z]*c/.test(arg)) return true;
        // Long flag — skip and keep scanning for a following -c.
        if (arg.startsWith("--")) continue;
        // Positional arg to shell — script path. Trigger forwarder.
        if (arg && !arg.startsWith("-")) return true;
      }
      return false;
    }

    // `source <path>` and `.` (dot-source) execute a script file — same
    // semantics as `bash /tmp/x.sh`. Match only when followed by a
    // positional argument.
    if (base === "source" || base === ".") {
      for (let j = i + 1; j < tokens.length; j++) {
        const arg = tokens[j];
        if (arg.startsWith("-")) continue;
        return true;
      }
      return false;
    }

    // Neither a shell name nor a wrapper nor source/dot — not a shell forwarder.
    return false;
  }

  return false;
}

// -------- `cd` chdir guard (bash-hardening-round-2 L3) --------

// Detect compound commands whose `cd` builtin would silently change cwd for
// subsequent fragments. Static analysis resolves every relative path
// against projectRoot, so `cd /etc && rm -rf .` would be misinterpreted as
// deleting `<projectRoot>/.` when the shell would actually delete `/etc`.
//
// Semantics:
//   - Runs AFTER `scanUnreliable` / `scanControlFlow` (they catch more
//     general constructs first) and BEFORE `isShellForwarder` (both are
//     unrelated constructs — order doesn't matter for correctness, but
//     `cd_chdir` is more specific so it wins on reason reporting).
//   - Only fires on COMPOUND commands (≥ 2 fragments after splitting on
//     `;` / `&&` / `||` / `&` / `\n`). A lone `cd /etc` (no separator)
//     has no downstream fragment whose path resolution is affected and
//     must NOT be flagged.
//   - Fires when ANY fragment's leading token (basename, path prefix
//     stripped) is `cd` — matching how bash's `cd` builtin appears in
//     real usage. Absolute paths (`/usr/bin/cd`) are matched by
//     basename for consistency with `getStageCommandName` / `isShellForwarder`.
//
// Returns `"cd_chdir"` when the guard fires, otherwise `undefined`.

export function scanCdChdir(cmd: string): string | undefined {
  const fragments = splitCommands(cmd);
  if (fragments.length < 2) return undefined;
  for (const frag of fragments) {
    const trimmed = frag.trim();
    if (!trimmed) continue;
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) continue;
    const firstBase = tokens[0].split("/").pop()!;
    if (firstBase === "cd") return "cd_chdir";
  }
  return undefined;
}

// -------- Main extraction --------
