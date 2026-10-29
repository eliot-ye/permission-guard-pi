// Bash extraction: silent commands + dev-tool read-only subcommand detection.
// Pure module — no IO / no side effects.

import { splitCommands, tokenize } from "./parse.ts";
import { isReadOnlyWithArgs } from "./readonly.ts";
import { GIT_READONLY_SUBCOMMANDS } from "./git-cmds.ts";
import { SHELL_WRAPPER_NAMES, skipWrapperTokens } from "./shell-forwarder.ts";

export const SILENT_COMMANDS: Record<string, Set<string>> = {
  // git 只读子命令单一事实源：GIT_READONLY_SUBCOMMANDS（readonly.ts）。
  // 与 shell-forwarder.ts 的 cd 链 git 写子命令判断（D2a 条件 11）共享——
  // git 子命令不在该集合即视为写子命令，两处一致。
  git: new Set(GIT_READONLY_SUBCOMMANDS),
  npm: new Set(["test", "lint", "audit"]),
  npx: new Set(),          // flag-only; `npx <pkg>` is unreliable
  yarn: new Set(["test", "lint", "audit"]),
  pnpm: new Set(["test", "lint", "audit"]),
  tsc: new Set(),          // tsc has no subcommand; all flags
  go: new Set(["version", "env", "vet", "fmt"]),
  make: new Set(),         // `make -f <file>` executes arbitrary Makefile
  rg: new Set(),           // `rg pattern <path>` reads any path
  jq: new Set(),           // `jq . <file>` reads any file
  openspec: new Set(),     // project tool — any subcommand is silent
};

// Commands whose empty allow-set means "any subcommand is silent".
// Without this marker, empty allow-set means "no positional tokens allowed"
// (the strict default for tsc/make/rg/jq/npx).

export const SILENT_ALLOW_ALL = new Set(["openspec"]);

// Unreliable commands (bash-stage-b-security-fixes, D2): commands that can
// execute arbitrary shell, read/write arbitrary files, or exfiltrate data
// over the network. Command-name exact match on any command fragment's first
// token (after env/command wrapper prefixes) triggers `unreliable_command`.
//
// These commands are NOT in COMMAND_TABLE (no static target extraction) and
// NOT in SILENT_COMMANDS — they are unconditionally flagged as unreliable so
// we don't fall through to fail-open. This closes the D6 known-design
// boundary for the subset of "we know this command is unsafe" — the
// remaining fail-open default (unknown commands → 0 target) is left for a
// future change.

export const UNRELIABLE_COMMANDS = new Set([
  // Script interpreters (execute arbitrary code via -c / -e / script path)
  "sed", "awk", "perl", "python", "python2", "python3", "python3.11",
  "python3.12", "node", "nodejs", "ruby", "php", "lua", "deno", "bun",
  // System script executors
  "osascript", "powershell", "pwsh",
  // Network / remote execution tools (can exfiltrate data or run remote cmds)
  "scp", "sftp", "rsync", "ssh", "telnet", "nc", "netcat", "ncat", "socat",
  // Container / cloud orchestration (execute arbitrary container commands)
  "kubectl", "docker", "podman", "nerdctl", "crictl",
  // Shell meta-commands (stage-a 明确留给 Stage B)
  "eval", "exec", "trap",
  // Formerly-SILENT commands moved to UNRELIABLE (their "silence" was unsafe)
  "rg", "jq", "make", "cargo", "npx",
]);

// Silent: { cmdName: Set<subcommand> }. `isSilentCommand` returns true when
// the command is a read-only dev-tool invocation — see SILENT_COMMANDS
// comments for the shape and semantics. `tokens` is the args list AFTER the
// cmdName (i.e. for `git status`, tokens is `["status"]`).
//
// Three modes:
//   1. Command not in SILENT_COMMANDS — return false.
//   2. Empty allow-set + NOT SILENT_ALLOW_ALL (tsc/make/rg/jq/npx):
//      strict flag-only mode. Any non-flag token (including a flag's value
//      that looks like a path) → false. This is how `make -f /tmp/evil.mk`
//      gets caught: `/tmp/evil.mk` is the value of `-f`, but for make it's
//      also the Makefile to execute.
//   3. Non-empty allow-set OR SILENT_ALLOW_ALL: the first non-flag token
//      is the subcommand; it must be in the allow-set (or any for
//      allow-all). No further positional tokens are allowed, so
//      `git log /etc/passwd` is not silent even though `log` is allowed.
//
// Change B extension (Mode 3 post-subcommand stage):
//   - `git` + read-only subcommand + positional args all matching either
//     git blob syntax or repo-relative path → silent
//     (see D2 in design.md; BT-BLOB-1..18)
//   - `npm` / `yarn` / `pnpm` + `run <script>` where script ∈ {test, lint,
//     audit} and no additional tokens → silent
//     (see D3 in design.md; BT-RUN-1..9)
//
// ---------------------------------------------------------------------------
// git blob 语法与 repo 内相对路径识别（D2 in design.md）
// ---------------------------------------------------------------------------

// Git read-only subcommands that MAY accept positional args (Change B).
// Subset of SILENT_COMMANDS.git. Only these subcommands get the post-
// subcommand extension; others (branch, tag, remote, config, ls-files)
// keep the strict "no positional after subcommand" behavior.

export const GIT_BLOB_OK_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame", "rev-parse", "rev-list", "shortlog",
]);

// Change C: go subcommands that accept repo-relative positional after the
// subcommand (D3 in design.md). `go vet` and `go fmt` are the read-only
// (or worktree-only-write) forms; all other go subcommands (build, test,
// run, mod tidy, mod download, ...) remain UNRELIABLE.

export const GO_SILENT_POSITIONAL_SUBCOMMANDS = new Set(["vet", "fmt"]);

// npm/yarn/pnpm script-name whitelist for `run <script>` form (D3).

export const NPM_RUN_OK_SCRIPTS = new Set(["test", "lint", "audit"]);

/**
 * Look for a `.` followed by alphabetic extension chars, at a position
 * where it can only appear in a file path, not a semantic version.
 *
 * Semver shape: `v1.2.3` — dots are always followed by digits.
 * File-path shape: `main.ts`, `foo.js`, `a/b.c` — a dot is followed by
 * alphabetic chars at the end of a segment.
 *
 * We walk every `.` occurrence. For each, look at the char immediately
 * after:
 *   - digit → OK (looks like semver)
 *   - alpha AND the segment from this `.` to the next `/` (or end) is
 *     short (2-4 chars, typical extension length) → looks like a file
 *     extension → this token is a path, not a revision.
 *
 * Special case: bare `HEAD`, `main`, `origin/main`, `HEAD~1^` — no `.`
 * at all → no concern.
 *
 * Special case: `HEAD.v1` — `.v` is followed by a digit, so the segment
 * length is 2, followed by a digit. This is actually a valid revision
 * (`HEAD.v1` = the commit whose tag is `v1` on `HEAD`). But under our
 * rules, `v` after `.` is not a digit, so we treat `HEAD.v1` as a file
 * extension. This is a KNOWN FALSE NEGATIVE — users who rely on this
 * revision form will hit `unreliable_command` and have to explicitly
 * allow it. Prefered over the alternative (letting `main.ts` through as
 * a revision).
 */

export function looksLikeFileExtensionAfterDot(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ".") continue;
    // Look at the char right after `.`.
    const next = s[i + 1];
    if (next === undefined) continue; // trailing dot — not a file extension
    // Digit after dot → semver candidate, not a file extension.
    if (/[0-9]/.test(next)) continue;
    // Non-alpha after dot (e.g. `HEAD.{something}`) → not a file extension.
    if (!/[A-Za-z]/.test(next)) continue;
    // Now check the segment from `.` to the next `/` or end-of-string.
    const slashIdx = s.indexOf("/", i);
    const segmentEnd = slashIdx === -1 ? s.length : slashIdx;
    const segment = s.slice(i, segmentEnd);
    // Segment length must be plausible for an extension (2-4 chars
    // including the leading dot).
    if (segment.length >= 2 && segment.length <= 5) return true;
  }
  return false;
}

/**
 * A token looks like a git revision if it satisfies all four D2 rules:
 *   1. Length ≥ 1
 *   2. Doesn't start with `/`, `~`, or `.`
 *   3. Doesn't contain `..` (avoids path ambiguity)
 *   4. Doesn't contain a `.ext` shape (looks like a file path, not a revision)
 *
 * NOTE: rule 4 rejects `HEAD.v1`-style revisions as a KNOWN FALSE
 * NEGATIVE — see the helper's comment above for rationale.
 */

export function looksLikeRevision(rev: string): boolean {
  if (rev.length === 0) return false;
  const first = rev[0];
  if (first === "/" || first === "~" || first === ".") return false;
  if (rev.includes("..")) return false;
  if (looksLikeFileExtensionAfterDot(rev)) return false;
  return true;
}

/**
 * A token matches the git blob syntax `<rev>:<path>` if:
 *   - The token contains `:` at some position (Windows drive letters
 *     like `C:/foo` don't qualify because `C:` is only 2 chars and the
 *     first char is a drive letter — we treat those as repo paths
 *     anyway).
 *   - The part BEFORE the first `:` looks like a revision.
 *   - The part AFTER is non-empty (path).
 *
 * We do NOT validate the path part — git itself rejects bad paths, and
 * we're only deciding whether the command shape is safe to run.
 */

export function looksLikeGitBlobToken(token: string): boolean {
  const colonIdx = token.indexOf(":");
  if (colonIdx === -1) return false;
  // Skip Windows drive letters (e.g. `C:/path`) — that's a path form,
  // not a blob syntax.
  if (colonIdx === 1 && /^[A-Za-z]$/.test(token[0])) return false;
  const rev = token.slice(0, colonIdx);
  const path = token.slice(colonIdx + 1);
  if (path.length === 0) return false;
  return looksLikeRevision(rev);
}

/**
 * A token looks like a repo-internal relative path if:
 *   1. Doesn't start with `/` (absolute)
 *   2. Doesn't start with `~/` (home prefix)
 *   3. Doesn't contain `../` (path traversal)
 *   4. Not a Windows drive-letter path (`^[A-Za-z]:[\\/]`)
 *
 * Directories (ending with `/`) and files (any extension) are both OK.
 */

export function looksLikeRepoRelativePath(token: string): boolean {
  if (token.length === 0) return false;
  if (token.startsWith("/")) return false;
  if (token.startsWith("~/")) return false;
  if (token.includes("../")) return false;
  // Windows drive letter.
  if (/^[A-Za-z]:[\\/]/.test(token)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Change C: tsc / go vet / go fmt / npx --no-install silent forms.
// ---------------------------------------------------------------------------

// tsc entry flags: MUST be the FIRST flag token for the special path
// to activate (D2 in design.md).

export const TSC_ENTRY_FLAGS = new Set(["--noEmit", "--version", "--help", "-h"]);

// tsc allowed-with-value flags. Both `--flag=<v>` and `--flag <v>` forms
// are accepted; `<v>` must be a non-flag token (non-`--`).

export const TSC_FLAG_TAKES_VALUE = new Set([
  "-p", "--project",
  "--pretty",
  "--target", "--module", "--moduleResolution",
  "--jsx",
  "--esModuleInterop", "--resolveJsonModule",
  "--noImplicitAny", "--noImplicitReturns",
  "--strictNullChecks", "--strictFunctionTypes",
  "--noUncheckedIndexedAccess", "--useDefineForClassFields",
  "--forceConsistentCasingInFileNames",
]);

// tsc allowed-without-value flags (boolean toggles).

export const TSC_FLAG_BOOL = new Set([
  "--incremental", "--strict", "--skipLibCheck",
  "--watch", "-w",
]);

// tsc REJECTED flags: emit-related, path-related, --build/-b. Any
// occurrence → return false from isSilentTsc (D2 in design.md).

export const TSC_REJECTED_FLAGS = new Set([
  "--outDir", "--declarationDir", "--rootDir",
  "--declaration", "--declarationMap", "--sourceMap", "--outFile",
  "--emitDeclarationOnly", "--emitDecoratorMetadata", "--isolatedDeclarations",
  "--noCheck", "--build", "-b",
]);

/**
 * Classify a tsc flag name (already stripped of any `=<value>` suffix).
 * Returns one of "entry" | "safe" | "safe-value" | "rejected" | "unknown".
 */

export function classifyTscFlag(name: string): "entry" | "safe" | "safe-value" | "rejected" | "unknown" {
  if (TSC_ENTRY_FLAGS.has(name)) return "entry";
  if (TSC_REJECTED_FLAGS.has(name)) return "rejected";
  if (TSC_FLAG_BOOL.has(name)) return "safe";
  if (TSC_FLAG_TAKES_VALUE.has(name)) return "safe-value";
  return "unknown";
}

/**
 * Evaluate the `tsc` special case (Change C, D2).
 *
 * Returns true iff:
 *   1. First flag token is an entry flag (`--noEmit`, `--version`,
 *      `--help`, `-h`).
 *   2. Every flag is on the allowed list (entry, safe-bool, or
 *      safe-value) in either `--flag` or `--flag=<value>` form.
 *   3. If a safe-value flag appears without `=<value>`, the immediately-
 *      next token is a non-flag, non-`--` value.
 *   4. No positional tokens.
 *   5. No rejected flag appears anywhere.
 */

export function isSilentTsc(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  // Up-front: reject any rejected flag anywhere.
  for (const t of tokens) {
    if (t.startsWith("-")) {
      const name = t.indexOf("=") === -1 ? t : t.slice(0, t.indexOf("="));
      if (TSC_REJECTED_FLAGS.has(name)) return false;
    }
  }
  // First flag must be an entry flag.
  const first = tokens[0];
  if (!first.startsWith("-")) return false;
  const firstName = first.indexOf("=") === -1 ? first : first.slice(0, first.indexOf("="));
  if (classifyTscFlag(firstName) !== "entry") return false;

  // Walk remaining tokens.
  let skipNextValue = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (skipNextValue) {
      // Value token for a `--flag <value>` form.
      skipNextValue = false;
      if (t.startsWith("-") || t === "--") return false;
      continue;
    }
    if (t === "--") return false; // no `--` separators
    if (t.startsWith("-")) {
      const eqIdx = t.indexOf("=");
      const name = eqIdx === -1 ? t : t.slice(0, eqIdx);
      const kind = classifyTscFlag(name);
      if (kind === "rejected" || kind === "unknown") return false;
      if (kind === "safe-value" && eqIdx === -1) {
        skipNextValue = true;
        continue;
      }
      continue;
    }
    // Positional token → not silent.
    return false;
  }
  // Loop ended. If we expected a value token but got none, reject.
  if (skipNextValue) return false;
  return true;
}

// ---------------------------------------------------------------------------
// go silent-form evaluation (Change C, D3)
// ---------------------------------------------------------------------------

/**
 * Evaluate the `go` command (Change C, D3):
 *
 * Returns true iff ALL of the following hold:
 *   1. tokens[0] is one of {version, env, vet, fmt}.
 *   2. For `version` and `env`, no further positional tokens are allowed.
 *      (`go version`, `go env` alone are silent; `go env GOFLAGS=...`
 *      allows a KEY=VAL assignment as a single positional — see below.)
 *   3. For `vet` and `fmt`, every positional token must satisfy
 *      looksLikeRepoRelativePath.
 *   4. Flags: any well-formed flag token is accepted. For `fmt`, the
 *      `-w` flag's VALUE must itself be repo-relative (this is the
 *      worktree-write guard — `go fmt -w /tmp/evil.go` is UNRELIABLE).
 *   5. No `--` separators are allowed.
 */

export function isSilentGo(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const sub = tokens[0];
  const subOk = SILENT_COMMANDS["go"].has(sub);
  if (!subOk) return false;

  let skipNextValue = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (skipNextValue) {
      skipNextValue = false;
      // Value must not be a flag or `--`.
      if (t.startsWith("-") || t === "--") return false;
      // `go fmt -w <path>` — the value must be repo-relative.
      if (sub === "fmt" && t !== "--") {
        if (!looksLikeRepoRelativePath(t)) return false;
      }
      continue;
    }
    if (t === "--") return false;
    if (t.startsWith("-")) {
      // Flag token. If it doesn't have `=`, it may consume the next
      // token as a value. Track that.
      if (!t.includes("=")) {
        // -w specifically: consume next and validate as repo-relative.
        // For other flags, still consume the next token as a value
        // (conservative — any flag taking a value in go is either
        // analysis-related or path-taking; we validate the value).
        skipNextValue = true;
      }
      continue;
    }
    // Positional token (or the last unconsumed value token).
    // `go version`/`go env` — no positional at all.
    if (sub === "version" || sub === "env") {
      // Exception: `go env KEY=VAL` is a legitimate form.
      if (sub === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
      return false;
    }
    // vet / fmt — positional must be repo-relative.
    if (!looksLikeRepoRelativePath(t)) return false;
  }
  // If we ended mid-value (flag took a value but no value token), reject.
  if (skipNextValue) return false;
  return true;
}

// ---------------------------------------------------------------------------
// npx silent-form evaluation (Change C, D4)
// ---------------------------------------------------------------------------

// npx allowed flags in the `--no-install` special form (D4).
// These are value-less (boolean) OR value-taking with an unrestricted value
// type (not path, not package).

export const NPX_FLAG_BOOL = new Set([
  "--yes", "-y",
  "--silent", "--quiet",
  "--no-fund", "--no-timing", "--no-update-notifier",
  "--offline", "--prefer-offline",
]);

// npx allowed flags with a value: `--cache=<path>`, `--color=<mode>`,
// `--loglevel=<level>`, `--cache <path>`, `--color <mode>`,
// `--loglevel <level>`. Value is NOT validated further (npm CLI
// accepts a wide range of levels/modes).

export const NPX_FLAG_TAKES_VALUE = new Set([
  "--cache", "--color", "--loglevel",
]);

// npx REJECTED flags: --prefix (cwd change), --package (multi-value
// package injection), --call/-c (arbitrary script execution).

export const NPX_REJECTED_FLAGS = new Set([
  "--prefix", "--package", "--call", "-c",
]);

/**
 * Evaluate the `npx` command (Change C, D4):
 *
 * Returns true iff ALL of the following hold:
 *   1. `--no-install` appears at least once.
 *   2. Every flag token (except `--no-install`) is either on the
 *      allowed list (`NPX_FLAG_BOOL` or `NPX_FLAG_TAKES_VALUE`).
 *      Rejected flags (`NPX_REJECTED_FLAGS`) → return false.
 *   3. Exactly one positional token appears after `--no-install`.
 *   4. No positional tokens before `--no-install`.
 *   5. No positional tokens after the single package name.
 *   6. No `--` separators.
 */

export function isSilentNpx(tokens: string[]): boolean {
  if (tokens.length === 0) return false;

  // Count and locate --no-install.
  let noInstallCount = 0;
  let noInstallIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--no-install") {
      noInstallCount++;
      if (noInstallIdx === -1) noInstallIdx = i;
    }
  }
  if (noInstallCount === 0) return false;

  // Reject any rejected flag anywhere.
  for (const t of tokens) {
    if (t.startsWith("-")) {
      const name = t.indexOf("=") === -1 ? t : t.slice(0, t.indexOf("="));
      if (NPX_REJECTED_FLAGS.has(name)) return false;
    }
  }

  // Walk tokens, tracking state.
  let seenNoInstall = false;
  let packageNameSeen = false;
  let packageNameIdx = -1;
  let skipNextValue = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (skipNextValue) {
      skipNextValue = false;
      // Value token for a value-taking flag.
      if (t.startsWith("-") || t === "--") return false;
      continue;
    }
    if (t === "--") return false;
    if (t === "--no-install") {
      seenNoInstall = true;
      continue;
    }
    if (t.startsWith("-")) {
      const eqIdx = t.indexOf("=");
      const name = eqIdx === -1 ? t : t.slice(0, eqIdx);
      if (NPX_FLAG_BOOL.has(name)) continue;
      if (NPX_FLAG_TAKES_VALUE.has(name)) {
        if (eqIdx === -1) {
          // `--flag <value>` form.
          skipNextValue = true;
          continue;
        }
        // `--flag=<value>` form.
        continue;
      }
      // Unknown flag → reject.
      return false;
    }
    // Positional token (potential package name).
    if (!seenNoInstall) return false; // positional before --no-install
    if (packageNameSeen) return false; // multiple positionals
    // After packageName, if we're already past the packageName, any
    // further positional token would have been rejected by the
    // `packageNameSeen` check above.
    if (!seenNoInstall || packageNameSeen) return false;
    // This is the package name.
    packageNameSeen = true;
    packageNameIdx = i;
    // Any further token → positional (rejected above) or flag (accepted
    // per above rules). The loop continues.
  }

  if (!packageNameSeen) return false;

  // No tokens after the package name are allowed as positionals, but
  // flags can still appear after the package name per npm semantics
  // (`npx --no-install eslint --color=always` is legit — flags apply
  // to npx, not to eslint, though npm treats trailing `--<flag>` as
  // package args). To keep this conservative: reject any token after
  // the package name that isn't a --no-install or a known npx flag.
  // The loop already handles this: any positional after packageNameSeen
  // is rejected via `packageNameSeen` check.
  void packageNameIdx;
  return true;
}

export function isSilentCommand(cmdName: string, tokens: string[]): boolean {
  const allowSet = SILENT_COMMANDS[cmdName];
  if (!allowSet) return false;
  const isAllowAll = SILENT_ALLOW_ALL.has(cmdName);

  // Change C: `tsc` special path (Mode 2 extension).
  if (cmdName === "tsc" && allowSet.size === 0 && !isAllowAll) {
    return isSilentTsc(tokens);
  }

  // Change C: `go` special path — short-circuit to isSilentGo for a
  // single source of truth shared with 4b. This preserves the exact
  // semantics from Change B (git-blob-positional and npm-run-form
  // branches below are no longer reachable for go) and adds the
  // repo-relative-path and `-w <path>` guards per D3.
  if (cmdName === "go") {
    return isSilentGo(tokens);
  }

  // Change C: `npx` special path (Mode 2 extension). `npx` has an empty
  // allow-set; `npx <pkg>` (no --no-install) is UNRELIABLE per D4.
  if (cmdName === "npx" && allowSet.size === 0 && !isAllowAll) {
    return isSilentNpx(tokens);
  }

  // Strict flag-only mode (mode 2): no positional token at all.
  if (allowSet.size === 0 && !isAllowAll) {
    for (const t of tokens) {
      if (t.startsWith("-")) continue;
      if (t === "--") continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // KEY=VAL env-style
      return false; // any positional token
    }
    return true;
  }

  // Subcommand mode (mode 3).
  let phase = "pre";  // pre-subcommand → post-subcommand
  let skipNext = false; // consume `-x val` as a unit
  let subcommandSeen: string | null = null; // D5/D6 Change B: track which subcommand was accepted
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (skipNext) { skipNext = false; continue; }
    if (t === "--") continue;
    if (t.startsWith("-")) {
      if (!t.includes("=")) {
        const next = tokens[i + 1];
        if (
          next !== undefined &&
          !next.startsWith("-") &&
          next !== "--" &&
          !/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)
        ) {
          skipNext = true;
        }
      }
      continue;
    }
    // Positional token
    if (phase === "pre") {
      if (isAllowAll) { phase = "post"; continue; }
      if (!allowSet.has(t)) return false;
      subcommandSeen = t;
      phase = "post";
      continue;
    }
    // phase === "post"
    if (isAllowAll) continue;
    // Change B: git read-only subcommand with a blob-syntax or repo-relative
    // positional. D2 rules apply per positional.
    if (cmdName === "git" && subcommandSeen !== null && GIT_BLOB_OK_SUBCOMMANDS.has(subcommandSeen)) {
      if (looksLikeGitBlobToken(t) || looksLikeRepoRelativePath(t)) continue;
      return false;
    }
    // Change C: go vet / go fmt accept repo-relative positional. D3 rules
    // apply per positional. Only for the specific subcommands; go build,
    // test, run, mod tidy, mod download all remain UNRELIABLE.
    if (cmdName === "go" && subcommandSeen !== null && GO_SILENT_POSITIONAL_SUBCOMMANDS.has(subcommandSeen)) {
      if (looksLikeRepoRelativePath(t)) continue;
      return false;
    }
    // Change B: npm/yarn/pnpm `run <script>` form. D3 rules:
    // - first positional must be `run`
    // - second positional must be a whitelisted script name
    // - no further tokens allowed
    if ((cmdName === "npm" || cmdName === "yarn" || cmdName === "pnpm") && subcommandSeen === null) {
      // This is the first positional — treat it as the implicit "run" keyword.
      if (t === "run") {
        // Consume `run` and look at what follows.
        // Reset subcommandSeen state to a dedicated marker for the run-form.
        subcommandSeen = "__run_form__";
        continue;
      }
      // Not `run` — fall through to the existing allowSet check.
      if (!allowSet.has(t)) return false;
      subcommandSeen = t;
      continue;
    }
    // Change B: after `npm/yarn/pnpm run`, expect a whitelisted script name.
    if ((cmdName === "npm" || cmdName === "yarn" || cmdName === "pnpm") && subcommandSeen === "__run_form__") {
      if (NPM_RUN_OK_SCRIPTS.has(t)) {
        // Consumed the script name. Now we require zero more tokens — the
        // rest of the loop will reject any extra positional via the
        // "extra positional after subcommand" default below.
        subcommandSeen = "__run_form_scripted__";
        continue;
      }
      return false;
    }
    return false; // extra positional after subcommand
  }
  // Change B: `npm run` must be followed by a whitelisted script name.
  if (subcommandSeen === "__run_form__") return false;
  return true;
}

// Check whether any command fragment's first command name is in
// UNRELIABLE_COMMANDS. Wrapper prefixes (`env`, `command`) are skipped, so
// `env FOO=1 sed -i ...` still catches sed. Path-prefixed commands
// (`/usr/bin/sed`) match by basename. Compound commands (`;`/`&&`/`||`/`&`)
// are split first so any fragment's first-command match is caught.

export function isAnyUnreliableCommand(rawCommand: string): boolean {
  const fragments = splitCommands(rawCommand);
  for (const frag of fragments) {
    if (!frag.trim()) continue;
    const tokens = tokenize(frag);
    if (tokens.length === 0) continue;
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      const base = tok.split("/").pop()!;
      if (SHELL_WRAPPER_NAMES.has(base)) {
        // Skip wrapper's KEY=VAL and flag args, land on the actual command.
        i = skipWrapperTokens(tokens, i + 1, base);
        continue;
      }
      // Reached the actual command name of this fragment.
      if (UNRELIABLE_COMMANDS.has(base)) return true;
      break; // this fragment's first-command is not unreliable; try next fragment
    }
  }
  return false;
}

// Quote-aware tokenizer for C5 bare-path token scanning (extension layer).
// Exposes the same tokenizer used internally so extension code can scan a
// raw bash command string.

export const HARMLESS_BUILTINS = new Set([
  "echo", "printf", "true", "false", "pwd", "cd", "test", "[",
  ":", "sleep", "export", "set", "unset", "type", "which", "hash",
  "seq", "basename", "dirname",
]);

/**
 * Check whether a for-loop body consists only of read-only/harmless commands.
 * The body string is the text between `do` and `done` (excluding them).
 */

export function isForBodyReadOnly(body: string): boolean {
  if (!body.trim()) return true; // empty body is OK (no commands)
  // Split by top-level command separators (`;`, `&&`, `||`, `&`, `\n`).
  // This groups each body command as one part (e.g. `grep "$f"`), so we can
  // extract the leading command name with tokenize.
  const parts = splitCommands(body);

  for (const part of parts) {
    if (!part.trim()) continue;
    const tokens = tokenize(part);
    if (tokens.length === 0) continue;
    const cmdName = tokens[0]?.split("/").pop() ?? "";
    // `isReadOnlyWithArgs` gives `find` per-argument analysis (write flags
    // like `-delete`/`-exec` make the body non-read-only). Other commands
    // fall through to READ_ONLY_COMMANDS via isReadOnlyWithArgs.
    if (!isReadOnlyWithArgs(cmdName, tokens.slice(1)) && !isSilentCommand(cmdName, tokens.slice(1)) && !HARMLESS_BUILTINS.has(cmdName)) {
      return false;
    }
  }
  return true;
}
