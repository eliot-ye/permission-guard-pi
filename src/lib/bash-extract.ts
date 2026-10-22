//
// Bash command target extraction. Pure module.
//
// Design (design.md D6):
//   Return type is a discriminated union:
//     - { reliable: true, targets: [{ action, path }, ...] }  - all file targets extracted
//     - { reliable: false, rawCommand: string, reason?: string } - can't reliably parse
//
// "Unreliable" is triggered by constructs we don't want to guess at:
//   - Command substitution ($( ... ) or `...`)
//   - Subshells (...)
//   - Process substitution <(...) or >(...)
//   - Heredocs (<<EOF)
//   - Unresolved user variables ($X or ${X})
//   - Control-flow keywords (while/for/if/case) that make the flow
//     non-statically-determinable — except for literal-iteration `for`
//     loops whose bodies are read-only (see `isLiteralForLoop`).
//   - `find` invocations with write-operation flags (`-delete`, `-exec`,
//     `-execdir`, `-ok`, `-okdir`) — reason: `find_write_flag`.
//   - Forwarders (`xargs`/`parallel`/`pforeach`) whose downstream is a
//     write command or whose upstream stage is a write operation —
//     reason: `forwarding_command`. This covers the FIRST pipeline stage
//     as well (e.g. `xargs rm -rf` with no upstream).
//
// Pipelines (|) are NOT themselves a reason: each stage is extracted
// independently. Forwarders are guarded via `isForwarderStageSafe`
// (Stage A change: first-stage coverage + upstream recursion).
//
// Known supported commands (extract as file targets):
//   - Writes: rm, mv, cp, tee, install, ln -s, chmod, chown, truncate, dd of=, curl -o/--output, wget -O
//   - Reads: cat, head, tail, wc, grep, cp, mv (first arg), find (read-only form), ls, tree, stat, du, df, file, less, more
//
// Redirect operators (>, >>, 2>, 2>>) also produce write targets.
// Benign `/dev/*` targets (`/dev/null`, `/dev/stderr`, `/dev/stdout`,
// `/dev/zero`, `/dev/fd/stdin`, etc.) are exempted as shell idiom for
// silent discard / std-stream routing. Network sockets (`/dev/tcp/*`,
// `/dev/udp/*`) and numeric fd aliases (`/dev/fd/[0-9]+`) are NOT
// exempted — they are actual I/O targets.
//
// Relative paths are resolved against projectRoot.
//
// Variable expansion: $HOME, ${HOME}, $PWD, ${PWD} expanded if defined in env.
// Other variables mark as unreliable.


import { expandHome, toAbsolutePath, isInside } from "./path-utils.ts";

export type ExtractAction = "read" | "write" | "delete";

// -------- Read-only command allowlist (for bounded glob detection) --------

// Commands that have no filesystem write side effects when used in a pipeline
// stage's first position. When a bounded glob (one whose prefix is fully
// inside projectRoot) appears in a stage whose first command is in this set,
// the glob is treated as reliable (read-only access to a bounded prefix).
//
// Rationale: static analysis cannot enumerate the specific files the shell
// would expand to, but we CAN bound the search to the project's inner space,
// and we know the command doesn't write. So the safety envelope is equivalent
// to what the user could type manually by enumerating files themselves.
export const READ_ONLY_COMMANDS = new Set([
  "cat", "head", "tail", "wc", "grep",
  "ls", "tree", "stat", "du", "df", "file", "less", "more",
  // git subcommands that are read-only. Note: "git" alone is NOT here — we
  // check the first two tokens ("git log", "git show", etc.) separately.
  "git_log", "git_show", "git_diff", "git_status", "git_ls-files",
  "git_branch", "git_tag", "git_remote", "git_config",
  // Note: `find` is NOT in this set. `find` has argument-conditional
  // read-only-ness (`-delete`/`-exec`/`-execdir`/`-ok`/`-okdir` are writes),
  // so it goes through `isReadOnlyWithArgs` for a per-argument check.
]);

// Flags that make `find` perform a write/delete operation rather than
// only filtering results. Any of these in a `find` invocation's arguments
// makes the command non-read-only.
export const FIND_WRITE_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
]);

/**
 * Determine whether a `find` invocation is read-only based on its arguments.
 *
 * Returns false if any argument exactly matches one of FIND_WRITE_FLAGS.
 * Quoted literal forms (`find . -name "-delete"`) are tokens like
 * `"-delete"` with quotes preserved — they do NOT exactly match the bare
 * `-delete` string, so they are correctly treated as literals.
 */
export function isFindReadOnly(tokens: string[]): boolean {
  for (const t of tokens) {
    if (FIND_WRITE_FLAGS.has(t)) return false;
  }
  return true;
}

/**
 * Unified read-only check combining static command allowlist and
 * argument-conditional `find` analysis.
 *
 * - `find`: delegated to `isFindReadOnly` (checks for write-operation flags).
 * - Other commands: `READ_ONLY_COMMANDS.has(cmdName)`.
 *
 * This is the single entry point used by all sites that previously checked
 * `READ_ONLY_COMMANDS.has(cmdName)`, ensuring `find` gets per-argument
 * analysis in every context.
 */
export function isReadOnlyWithArgs(cmdName: string, tokens: string[]): boolean {
  if (cmdName === "find") return isFindReadOnly(tokens);
  return READ_ONLY_COMMANDS.has(cmdName);
}

/**
 * Determine whether an absolute path refers to a bash network socket or a
 * numeric file descriptor path. These are NOT covered by the `/dev/*`
 * silent-discard exemption because they are actual I/O targets:
 *
 * - `/dev/tcp/HOST/PORT` — bash TCP socket
 * - `/dev/udp/HOST/PORT` — bash UDP socket
 * - `/dev/fd/[0-9]+` — numeric file descriptor alias (e.g. `/dev/fd/3`)
 *
 * Other `/dev/*` paths (`/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`,
 * `/dev/zero`, `/dev/ptmx`, `/dev/fd/stdin`, etc.) remain exempted as
 * shell idiom for silent output discard or std-stream routing.
 */
export function isDevSocketOrFd(absPath: string): boolean {
  if (absPath.startsWith("/dev/tcp/")) return true;
  if (absPath.startsWith("/dev/udp/")) return true;
  if (absPath.startsWith("/dev/fd/")) {
    const rest = absPath.slice("/dev/fd/".length);
    // Rest must be a non-empty string of digits (and no trailing path).
    return rest.length > 0 && /^[0-9]+$/.test(rest);
  }
  return false;
}

/**
 * Determine the effective command name for a pipeline stage's first token(s).
 *
 * For multi-token commands like `git log`, `git diff`, we combine the first
 * two tokens into a `git_log` style key. For single-token commands, returns
 * the first token's basename.
 */
function getStageCommandName(stage: string): string {
  const tokens = tokenize(stage.trim());
  if (tokens.length === 0) return "";
  const base = tokens[0].split("/").pop()!;
  if (base === "git" && tokens.length >= 2) {
    // Strip leading flags to find the actual subcommand, but git allows
    // flags like `--no-pager` before the subcommand. We scan for the first
    // non-flag token after `git`.
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].startsWith("-")) continue;
      return `git_${tokens[i]}`;
    }
    return "git";
  }
  return base;
}

/**
 * Check whether every glob metacharacter in `cmd` (outside quotes and not
 * escaped) satisfies the bounded-glob safety envelope:
 *   1. The prefix before the glob char resolves to an absolute path INSIDE
 *      projectRoot.
 *   2. The command name of the enclosing pipeline stage (first token) is in
 *      READ_ONLY_COMMANDS.
 *   3. The prefix itself does not contain `../` that escapes projectRoot.
 *
 * If any glob is unbounded, returns false (caller should treat command as
 * unreliable). Returns true if every glob is bounded-safe, or if the command
 * contains no glob metacharacters at all.
 *
 * Quote-aware: single-quoted content is literal; double-quoted content is
 * literal except `\$` and `\"` which are escapes.
 */
export function isBoundedGlobSafe(cmd: string, projectRoot: string): boolean {
  // For each command fragment (split by ; / && / || / & / \n), and for each
  // pipeline stage within each fragment, we need to know:
  //   1. The command name (first token, with git subcommand folded to `git_<sub>`).
  //   2. For each unquoted glob metacharacter outside quotes, whether the
  //      token containing the glob has a prefix (chars before the glob in
  //      that same token) that is fully inside projectRoot and free of `../`.
  //
  // Each fragment is analyzed independently: a single fragment's safe bounded
  // read-only glob is not invalidated by an unrelated fragment. Fragments
  // without any glob pass trivially. Fragments whose pipeline stage's first
  // command is a write/delete command (e.g. `rm -f /tmp/*.log`) fail the
  // read-only check and cause the whole command to be treated as unreliable.
  const fragments = splitCommands(cmd);

  for (const fragment of fragments) {
    // If the fragment itself contains no glob metacharacters outside quotes,
    // skip the per-stage walk — no work to do.
    // (The scanner below will also pass through empty fragments, but the
    // explicit pre-check avoids unnecessary stage-name computation.)
    const stages = splitPipelines(fragment);
    const stageCmdNames = stages.map(getStageCommandName);

    for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
      const stage = stages[stageIdx];
      const stageCmd = stageCmdNames[stageIdx] ?? "";
      // Tokenize once so flushToken can pass the full argument list to
      // isReadOnlyWithArgs — this lets `find` get per-argument analysis
      // (write flags like `-delete`/`-exec` make the stage non-read-only).
      const stageTokens = tokenize(stage.trim());
      const stageArgs = stageTokens.slice(1);

      let quote: null | "'" | '"' = null;
      let escaped = false;
      let token = "";
      let tokenHasGlob = false;
      let tokenGlobPrefix = ""; // prefix before first glob in this token

      const flushToken = () => {
        if (tokenHasGlob) {
          // Condition 2: command must be read-only (arg-aware).
          if (!isReadOnlyWithArgs(stageCmd, stageArgs)) return false;
          // Condition 1: prefix inside projectRoot.
          if (!isBoundedPrefix(tokenGlobPrefix, projectRoot)) return false;
        }
        return true;
      };

      for (let i = 0; i < stage.length; i++) {
        const ch = stage[i];

        if (escaped) { escaped = false; token += ch; continue; }
        if (quote === "'") {
          if (ch === "'") quote = null;
          token += ch;
          continue;
        }
        if (ch === "\\") { escaped = true; token += ch; continue; }
        if (quote === '"') {
          if (ch === '"') quote = null;
          token += ch;
          continue;
        }
        if (ch === "'") { quote = "'"; token += ch; continue; }
        if (ch === '"') { quote = '"'; token += ch; continue; }

        // Whitespace = token boundary (token still may contain glob chars).
        if (/\s/.test(ch)) {
          if (token && !flushToken()) return false;
          token = "";
          tokenHasGlob = false;
          tokenGlobPrefix = "";
          continue;
        }

        token += ch;

        // Glob metachar outside quotes, unescaped: capture prefix BEFORE this
        // glob occurrence in the same token.
        if (ch === "*" || ch === "?" || ch === "[") {
          if (!tokenHasGlob) {
            tokenHasGlob = true;
            tokenGlobPrefix = token.slice(0, -1); // drop the glob char we just added
          }
          // Additional glob chars in the same token don't extend the prefix
          // check — the prefix is anchored at the first glob occurrence.
          continue;
        }
      }

      // Flush final token at end of stage.
      if (token && !flushToken()) return false;
    }
  }

  return true;
}

/**
 * Check whether a path prefix (relative or absolute) is strictly inside
 * projectRoot. A prefix is bounded if:
 *   - It contains no `..` traversal segment (would escape projectRoot).
 *   - Its resolved absolute form is inside projectRoot (or equal).
 */
function hasDotDotSegment(prefix: string): boolean {
  // Normalize consecutive slashes so `a//../b` collapses to `a/../b`, then
  // split into segments and check whether `..` appears as a whole segment.
  // Strip leading/trailing slashes so we only look at real path segments.
  const normalized = prefix.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return false;
  return normalized.split("/").includes("..");
}

function isBoundedPrefix(prefix: string, projectRoot: string): boolean {
  // Empty prefix means the glob is at token start (e.g. `*` alone).
  // We conservatively reject — such a token has no path context to bind.
  if (!prefix) return false;
  if (hasDotDotSegment(prefix)) return false;
  const abs = toAbsolutePath(prefix, projectRoot);
  return isInside(abs, projectRoot);
}

export type ExtractResult =
  | { reliable: true; targets: Array<{ action: ExtractAction; path: string }> }
  | { reliable: false; rawCommand: string; reason?: string };

// -------- Quote-aware unreliable scanner (D7) --------

/**
 * Scan a bash command string for constructs that MUST be treated as
 * "unreliable" (cannot statically determine which files are accessed).
 *
 * Quote-aware: characters inside single quotes are all literal; characters
 * inside double quotes follow bash double-quote semantics (`\$`, `\``, `\"`,
 * `\\` are literal, but a bare `$(` still executes command substitution);
 * backslash outside quotes escapes the next character.
 *
 * Returns the first matching reason, or undefined if the command is safe to
 * parse.
 *
 * We do NOT check for `|` (pipeline) here — that is handled by
 * `splitPipelines`. See design.md D7.
 */

/**
 * Parse a heredoc operator `<<` at position `pos` and determine whether it
 * is quote-delimited. For quote-delimited heredocs (`<<'EOF'`, `<<"EOF"`,
 * `<<-'EOF'`, `<<-"EOF"`), the content is literal — no expansion happens.
 * In that case, returns `quoted: true` and `contentEnd` = the index just past
 * the closing delimiter line, so the caller can skip the content.
 *
 * For non-quote-delimited heredocs (`<<EOF`, `<<-EOF`), returns `quoted: false`
 * so the caller can fall back to the conservative `return "heredoc"`.
 *
 * If the closing delimiter line cannot be found, returns `quoted: false`
 * (conservative: treat as unreliable heredoc).
 */
function parseHeredocDelimiter(
  cmd: string,
  pos: number,
): { quoted: boolean; contentEnd: number } {
  let i = pos + 2; // skip `<<`
  let dash = false;
  if (cmd[i] === "-") {
    dash = true;
    i += 1;
  }
  const quoteChar = cmd[i];
  if (quoteChar !== "'" && quoteChar !== '"') {
    return { quoted: false, contentEnd: pos };
  }
  i += 1; // skip opening quote
  let delim = "";
  while (i < cmd.length && cmd[i] !== quoteChar) {
    delim += cmd[i];
    i += 1;
  }
  if (i >= cmd.length) {
    return { quoted: false, contentEnd: pos }; // no closing quote
  }
  i += 1; // skip closing quote

  // Find the end of the line containing `<<` (the heredoc body starts on
  // the next line).
  while (i < cmd.length && cmd[i] !== "\n") {
    i += 1;
  }
  if (i >= cmd.length) {
    return { quoted: false, contentEnd: pos }; // no body — malformed
  }
  i += 1; // skip the \n, now at start of heredoc body

  // Scan each line; the closing delimiter is a line that equals `delim`
  // (dash form: after stripping leading tabs).
  let lineStart = i;
  while (lineStart < cmd.length) {
    let lineEnd = lineStart;
    while (lineEnd < cmd.length && cmd[lineEnd] !== "\n") {
      lineEnd += 1;
    }
    const line = cmd.slice(lineStart, lineEnd);
    const candidate = dash ? line.replace(/^\t+/, "") : line;
    if (candidate === delim) {
      const after = lineEnd < cmd.length ? lineEnd + 1 : lineEnd;
      return { quoted: true, contentEnd: after };
    }
    if (lineEnd >= cmd.length) {
      return { quoted: false, contentEnd: pos }; // no closing delimiter
    }
    lineStart = lineEnd + 1;
  }
  return { quoted: false, contentEnd: pos };
}

/**
 * Scan a bash command for any command fragment whose leading command is
 * `find` and whose arguments contain a write-operation flag from
 * FIND_WRITE_FLAGS. Returns "find_write_flag" if found, undefined
 * otherwise.
 *
 * This guard covers isolated `find` invocations (not covered by
 * `isBoundedGlobSafe` when there is no unquoted glob, and not covered
 * by `isForwarderStageSafe` when `find` is not part of a forwarder
 * pipeline). Runs after `scanControlFlow` (so for-loop bodies with
 * `find -delete` are caught by the control-flow guard first) and before
 * `isShellForwarder`.
 *
 * Fragments are separated by `;`, `&&`, `||`, `&`, or `\n` via
 * `splitCommands`. Within each fragment, the leading command name is
 * the first token's basename; pipeline stages are not inspected here
 * (a `find` in a non-leading stage is not a write operation at the
 * fragment's leading position — and is handled by the forwarder guard
 * when it is a pipeline participant).
 */
function scanFindWriteFlags(cmd: string): string | undefined {
  const fragments = splitCommands(cmd);
  for (const fragment of fragments) {
    const tokens = tokenize(fragment.trim());
    if (tokens.length === 0) continue;
    const cmdName = tokens[0].split("/").pop()!;
    if (cmdName === "find") {
      if (!isFindReadOnly(tokens.slice(1))) return "find_write_flag";
    }
  }
  return undefined;
}

/**
 * Check if an unquoted glob metachar at position `i` in `cmd` is inside a
 * for-loop's iteration set, and that the for-loop's body is read-only.
 *
 * This is the for-loop iteration-set glob exemption (design.md D1–D5):
 * `for VAR in PREFIX<glob>; do BODY; done` where BODY is read-only should
 * be allowed to pass through as bounded-safe, because shell expansion of
 * the iteration set is statically determinable when the prefix is inside
 * projectRoot.
 *
 * The body read-only check uses `isForBodyReadOnly`, the same predicate
 * used by `isLiteralForLoop` (Change 2). The iteration-set glob prefix
 * must still pass `isBoundedPrefix` (same check as for command-argument
 * globs). Body globs (e.g. `"$d"/*.md`) are NOT exempted — they still
 * go through the normal bounded-glob check, which fails for prefixes
 * containing `$VAR`.
 *
 * Returns true if:
 *   1. The glob is inside a for-loop's iteration set.
 *   2. The for-loop structure is complete (has `; do BODY ; done`).
 *   3. The body passes `isForBodyReadOnly`.
 *   4. The glob's prefix passes `isBoundedPrefix`.
 *
 * Returns false otherwise (caller should flag `glob_expansion`).
 */
function isForLoopIterationGlobExempt(
  cmd: string,
  globPos: number,
  projectRoot: string,
): boolean {
  // Find the glob's position relative to the enclosing for-loop.
  // Walk backward from globPos to find the enclosing `for` keyword.
  // A for-loop has the form: `for VAR in WORDS; do BODY; done`
  // We need to check if globPos is inside the iteration set (between `in`
  // and `;` or the first whitespace before `; do`).

  // Find the start of the enclosing for-loop.
  let j = globPos;
  while (j >= 0) {
    // Look backward for `for` followed by whitespace.
    if (j >= 3 && cmd.slice(j - 3, j) === "for") {
      // Check that the `for` is at a command boundary (start, after `;`, `&&`,
      // `||`, `&`, `\n`, or `|`).
      const before = j - 4; // one char before `for`
      if (before < 0) {
        // `for` at start of command — valid boundary.
        break;
      }
      const prevCh = cmd[before];
      if (/\s/.test(prevCh) || prevCh === ";" || prevCh === "&" || prevCh === "|") {
        // But we need to check `&&` and `||` — a single `&` or `|` is a
        // boundary, but `&&`/`||` means the char before the first `&`/`|`
        // matters. Simplified: any of `;`, `&`, `|`, whitespace, or `\n`
        // is a valid boundary.
        break;
      }
    }
    j--;
  }
  if (j < 3 || cmd.slice(j - 3, j) !== "for") return false;

  // Parse the for-loop structure from position j-3.
  let pos = j; // `pos` is at `for` + 3 (skip `for`)
  while (pos < cmd.length && /\s/.test(cmd[pos])) pos++;
  // Skip VAR.
  while (pos < cmd.length && !/\s/.test(cmd[pos])) pos++;
  while (pos < cmd.length && /\s/.test(cmd[pos])) pos++;
  // Skip `in`.
  if (cmd.slice(pos, pos + 2) !== "in") return false;
  pos += 2;
  while (pos < cmd.length && /\s/.test(cmd[pos])) pos++;

  // pos is now at the start of the iteration set.
  const iterStart = pos;

  // Find the `;` that ends the iteration set.
  let semicolonPos = -1;
  let iterQuote: null | "'" | '"' = null;
  let iterEsc = false;
  for (; pos < cmd.length; pos++) {
    const c = cmd[pos];
    if (iterEsc) { iterEsc = false; continue; }
    if (iterQuote === "'") {
      if (c === "'") iterQuote = null;
      continue;
    }
    if (c === "\\") { iterEsc = true; continue; }
    if (iterQuote === '"') {
      if (c === '"') iterQuote = null;
      continue;
    }
    if (c === "'") { iterQuote = "'"; continue; }
    if (c === '"') { iterQuote = '"'; continue; }
    if (c === ";") { semicolonPos = pos; break; }
    // `do` without `;` (bash allows whitespace-only separator).
    if (c === " " && pos + 2 <= cmd.length && cmd.slice(pos, pos + 3) === " do") {
      // Check that `do` is followed by whitespace or end.
      if (pos + 3 >= cmd.length || /\s/.test(cmd[pos + 3])) {
        semicolonPos = pos - 1; // use pos-1 as the "end" of iteration set
        break;
      }
    }
  }
  if (semicolonPos < 0) return false;

  // globPos must be inside the iteration set.
  if (globPos < iterStart || globPos >= semicolonPos) return false;

  // Find `do` after the `;`.
  let doStart = semicolonPos + 1;
  while (doStart < cmd.length && /\s/.test(cmd[doStart])) doStart++;
  if (cmd.slice(doStart, doStart + 2) !== "do") return false;
  doStart += 2;
  if (doStart < cmd.length && !/\s/.test(cmd[doStart])) return false;
  while (doStart < cmd.length && /\s/.test(cmd[doStart])) doStart++;
  const bodyStart = doStart;

  // Find matching `done` at end.
  let donePos = -1;
  let bodyQuote: null | "'" | '"' = null;
  let bodyEsc = false;
  let scanning = false;
  let tokStart = -1;
  for (pos = bodyStart; pos < cmd.length; pos++) {
    const c = cmd[pos];
    if (bodyEsc) { bodyEsc = false; scanning = true; continue; }
    if (bodyQuote === "'") {
      if (c === "'") bodyQuote = null; else scanning = true;
      continue;
    }
    if (c === "\\") { bodyEsc = true; continue; }
    if (bodyQuote === '"') {
      if (c === '"') bodyQuote = null; else scanning = true;
      continue;
    }
    if (c === "'") { bodyQuote = "'"; scanning = true; continue; }
    if (c === '"') { bodyQuote = '"'; scanning = true; continue; }
    if (/\s/.test(c) || c === ";") {
      if (scanning) {
        if (tokStart >= 0) {
          if (cmd.slice(tokStart, pos) === "done") donePos = tokStart;
        }
        scanning = false;
        tokStart = -1;
      }
      continue;
    }
    if (!scanning) { tokStart = pos; scanning = true; }
  }
  if (scanning && tokStart >= 0) {
    if (cmd.slice(tokStart) === "done") donePos = tokStart;
  }
  if (donePos < 0) return false;

  // Extract body text.
  const body = cmd.slice(bodyStart, donePos);

  // Check body is read-only.
  if (!isForBodyReadOnly(body)) return false;

  // Extract the glob's prefix: the chars from the start of the current token
  // up to (but not including) the glob char. The token starts at the
  // beginning of the iteration set word that contains the glob.
  // Walk backward from globPos to find the start of the current token.
  let tokenStart = globPos;
  while (tokenStart > iterStart) {
    const c = cmd[tokenStart - 1];
    if (/\s/.test(c)) break;
    tokenStart--;
  }
  // But we should not go before `in ` + whitespace. Actually tokenStart
  // should be at the start of the word containing the glob, which is
  // inside the iteration set. Walk backward to find the start of the word.
  // But we need to handle quotes — the prefix is the chars before the glob
  // in the same word.
  // Simplified: prefix = cmd.slice(tokenStart, globPos).
  // But we need to check if there are quotes around parts of the prefix.
  // For now, use the raw slice — quotes would make the glob inside quotes
  // (which wouldn't be an unquoted glob, so we wouldn't be here).
  const prefix = cmd.slice(tokenStart, globPos);

  // Check prefix is inside projectRoot.
  if (!isBoundedPrefix(prefix, projectRoot)) return false;

  return true;
}

// -------- Substitution read-only exemption --------

// Commands that are safe to run inside `$(...)` — they either transform
// path strings, print to stdout, print the current directory, or perform
// pure conditional queries with no filesystem write side effects, no
// network access, and no child-process execution beyond their own
// invocation.
//
// Rationale for strict whitelist (design.md D1): commands that READ files
// (cat/grep/head/tail) are deliberately excluded — even though they are
// read-only operations, the extractor cannot predict which files they
// would touch from the substitution's argument, so exempting them would
// be a silent no-op (0 targets extracted). Commands with filesystem
// traversal (realpath -f, readlink -f, find) are also excluded because
// their arguments may reference files the extractor cannot bound.
export const SUBSTITUTION_READONLY_CMDS = new Set([
  "basename",
  "dirname",
  "echo",
  "printf",
  "pwd",
  "test",
]);

// Max nesting depth allowed for `$(...)` exemption. Anything deeper than
// 3 levels is treated as an attack surface and falls back to the
// original `command_substitution` rejection (design.md D3).
const SUBSTITUTION_MAX_DEPTH = 3;

interface SubstitutionScanResult {
  safe: boolean;
  // Index of the closing `)` of the `$(...)` block; -1 if parsing failed.
  closingParen: number;
}

/**
 * Determine whether a `$(...)` command substitution starting at `startPos`
 * (the `$` character) is safe to exempt from `command_substitution`
 * rejection.
 *
 * Returns `{ safe: true, closingParen: i }` when the substitution's
 * top-level command is in `SUBSTITUTION_READONLY_CMDS` and the argument
 * portion contains no side-effect constructs (unquoted glob, heredoc,
 * backtick, subshell, non-whitelisted nested substitution). Recursion
 * handles nested `$(...)` — a nested block must itself be exemptible.
 *
 * Returns `{ safe: false, closingParen: -1 }` when any condition fails;
 * the caller falls back to the original `command_substitution` reason.
 *
 * The state machine mirrors `scanUnreliable`'s own quote/escaped tracking
 * (single quotes preserve `\` as literal; double quotes escape `\$`, `\"`,
 * `\\`; outside quotes `\` escapes the next char) so both parsers agree
 * on where constructs live.
 */
export function isSubstitutionReadOnlyAt(
  cmd: string,
  startPos: number,
  depth: number,
): SubstitutionScanResult {
  if (depth > SUBSTITUTION_MAX_DEPTH) {
    return { safe: false, closingParen: -1 };
  }
  if (cmd[startPos] !== "$" || cmd[startPos + 1] !== "(") {
    return { safe: false, closingParen: -1 };
  }

  let i = startPos + 2; // skip "$("
  let parenDepth = 1;
  let quote: null | "'" | '"' = null;
  let escaped = false;

  while (i < cmd.length) {
    const ch = cmd[i];
    const prev = i > 0 ? cmd[i - 1] : "";
    const next = i + 1 < cmd.length ? cmd[i + 1] : "";

    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      if (ch === "$" && next === "(") {
        const nested = isSubstitutionReadOnlyAt(cmd, i, depth + 1);
        if (!nested.safe) return { safe: false, closingParen: -1 };
        i = nested.closingParen + 1;
        continue;
      }
      if (ch === "`") return { safe: false, closingParen: -1 };
      i += 1;
      continue;
    }

    // Outside any quote, unescaped.
    if (ch === "'") { quote = "'"; i += 1; continue; }
    if (ch === '"') { quote = '"'; i += 1; continue; }
    if (parenDepth > 0 && ch === "(") {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (parenDepth > 0 && ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        // Closing `)` of the current `$(...)`. Break out to post-parse check.
        i += 1;
        break;
      }
      i += 1;
      continue;
    }
    if (ch === "$" && next === "(") {
      const nested = isSubstitutionReadOnlyAt(cmd, i, depth + 1);
      if (!nested.safe) return { safe: false, closingParen: -1 };
      i = nested.closingParen + 1;
      continue;
    }
    if (ch === "`") return { safe: false, closingParen: -1 };
    if (ch === "<" && next === "<") return { safe: false, closingParen: -1 };
    // Shell-level redirects / pipelines / background / separators are
    // rejected inside `$(...)` — they introduce writes or additional
    // command executions that `extractBashTargets` cannot see through
    // the substitution boundary. Without this, `$(echo hi > /tmp/x)`
    // would be exempted as "echo is readonly" while silently writing
    // `/tmp/x`, defeating the whole point of `command_substitution`
    // gating (review finding bash-substitution-readonly-exemption#1).
    if (ch === ">" || ch === "|") return { safe: false, closingParen: -1 };
    if (ch === "&") {
      // Single `&` is background; `&&` is logical-and. Both introduce
      // additional command execution invisible to the outer extractor.
      return { safe: false, closingParen: -1 };
    }
    if (ch === ";") return { safe: false, closingParen: -1 };
    // Unquoted glob metachar → side-effect (shell expands to arbitrary
    // filenames). Exclusion per spec D4.
    if (ch === "*" || ch === "?" || ch === "[") return { safe: false, closingParen: -1 };

    i += 1;
  }

  if (parenDepth !== 0) {
    // Unbalanced — closing `)` never reached.
    return { safe: false, closingParen: -1 };
  }

  // Extract top-level command name: first token after `$(`, take path
  // basename so `basename` and `/usr/bin/basename` both match.
  const inner = cmd.slice(startPos + 2, i - 1);
  let cmdStart = 0;
  while (cmdStart < inner.length && /\s/.test(inner[cmdStart])) cmdStart += 1;
  let cmdEnd = cmdStart;
  while (cmdEnd < inner.length && !/\s/.test(inner[cmdEnd])) cmdEnd += 1;
  const rawCmd = inner.slice(cmdStart, cmdEnd);
  if (rawCmd === "") return { safe: false, closingParen: -1 };
  const cmdName = rawCmd.includes("/") ? rawCmd.split("/").pop()! : rawCmd;
  if (!SUBSTITUTION_READONLY_CMDS.has(cmdName)) {
    return { safe: false, closingParen: -1 };
  }

  return { safe: true, closingParen: i - 1 };
}

// -------- Scan for constructs that MUST be unreliable (D6) --------

function scanUnreliable(cmd: string, projectRoot?: string): string | undefined {
  let quote: null | "'" | '"' = null;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const prev = i > 0 ? cmd[i - 1] : "";
    const next = i + 1 < cmd.length ? cmd[i + 1] : "";

    // Escape handling: applies inside double quotes and outside quotes,
    // but NOT inside single quotes (bash treats \ as literal there).
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      // Inside single quotes: only the closing quote matters.
      if (ch === "'") quote = null;
      continue;
    }
    // Escape outside quotes: after the single-quote branch above (which
    // `continue`s on `quote === "'"`), TypeScript narrows `quote` to
    // `null | '"'`, so the former `&& quote !== "'"` guard was dead code.
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      // Inside double quotes, $() is still a command substitution per bash.
      // But \$ is literal (handled above via escaped flag).
      if (ch === "$" && next === "(") {
        // Substitution read-only exemption (bash-substitution-readonly-exemption):
        // if the inner command is in SUBSTITUTION_READONLY_CMDS and its
        // argument form has no side-effect constructs, skip past the
        // closing `)` and continue scanning. Fallback to
        // `command_substitution` on any mismatch — default behavior
        // unchanged for whitelist-miss forms. Depth starts at 1 so
        // nested recursions count against SUBSTITUTION_MAX_DEPTH=3.
        const sub = isSubstitutionReadOnlyAt(cmd, i, 1);
        if (sub.safe) {
          i = sub.closingParen;
          continue;
        }
        return "command_substitution";
      }
      if (ch === "`") return "backtick_substitution";
      continue;
    }
    // Outside any quote, unescaped.
    if (ch === "'") { quote = "'"; continue; }
    if (ch === '"') { quote = '"'; continue; }
    if (ch === "$" && next === "(") {
      // Substitution read-only exemption — same branch as the double-quote
      // case above, but this is the unquoted (top-level) `$(`.
      const sub = isSubstitutionReadOnlyAt(cmd, i, 1);
      if (sub.safe) {
        i = sub.closingParen;
        continue;
      }
      return "command_substitution";
    }
    if (ch === "`") return "backtick_substitution";
    if (ch === "<" && next === "(") return "process_substitution_input";
    if (ch === ">" && next === "(") return "process_substitution_output";
    if (ch === "<" && next === "<") {
      const hd = parseHeredocDelimiter(cmd, i);
      if (hd.quoted) {
        i = hd.contentEnd - 1; // -1: the for-loop will i++ to contentEnd
        continue;
      }
      return "heredoc";
    }
    // Subshell: `(...)` at top level after command separator or start.
    if ((ch === "(" || ch === ")") && /(^|[;&|\s])/.test(prev + " ")) {
      // prev is " " when ch is at position 0
      if (prev === "" || /[;&|\s]/.test(prev)) {
        return "subshell";
      }
    }
    // Glob expansion: unquoted `*`, `?`, `[` in a token (anywhere in the
    // command outside a token's non-leading position still flags as glob).
    if (ch === "*" || ch === "?" || ch === "[") {
      // Bounded-glob allowlist (D?): if the caller provided projectRoot and
      // every glob metachar in the command is bounded-safe (prefix fully
      // inside projectRoot AND the enclosing stage's command is read-only),
      // do NOT flag as unreliable — let the command flow through to normal
      // extraction. Without projectRoot or if any glob is unbounded, we fall
      // through to the conservative `glob_expansion` reason.
      if (projectRoot && isBoundedGlobSafe(cmd, projectRoot)) {
        continue;
      }
      // For-loop iteration-set glob exemption: `for VAR in PREFIX*/; do BODY; done`
      // where BODY is read-only. isBoundedGlobSafe splits by `;` and sees the
      // fragment as `for VAR in PREFIX*/` with stageCmd "for" (not in
      // READ_ONLY_COMMANDS), so it fails. This exemption handles that case
      // directly by checking the for-loop structure at the glob position.
      if (projectRoot && isForLoopIterationGlobExempt(cmd, i, projectRoot)) {
        continue;
      }
      return "glob_expansion";
    }
  }
  return undefined;
}

// -------- Top-level pipeline splitting (D1) --------

/**
 * Split a command into pipeline stages at top-level `|` characters.
 * Skips:
 *   - `|` inside single or double quotes
 *   - escaped `\|`
 *   - `||` (logical OR — handled by `splitCommands` as command separator)
 *
 * `|&` (GNU bash pipe stdin+stderr) is treated as a normal `|`.
 */
function splitPipelines(cmd: string): string[] {
  const stages: string[] = [];
  let cur = "";
  let quote: null | "'" | '"' = null;
  let escaped = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      cur += ch;
      escaped = true;
      i += 1;
      continue;
    }
    if (quote === '"') {
      cur += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "'") { quote = "'"; cur += ch; i += 1; continue; }
    if (ch === '"') { quote = '"'; cur += ch; i += 1; continue; }
    if (ch === "|") {
      // Skip `||` — that's logical OR, handled by splitCommands.
      if (i + 1 < cmd.length && cmd[i + 1] === "|") {
        cur += "||";
        i += 2;
        continue;
      }
      // Top-level pipe: split point.
      stages.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.length > 0) stages.push(cur);
  return stages;
}

// -------- Command classification --------

// Forwarders (D2): commands that consume stdin and pass it as arguments to
// downstream tools. Static analysis cannot enumerate the target arguments,
// so any pipeline stage whose leading command is a forwarder is unreliable.
const FORWARDING_COMMANDS = new Set(["xargs", "parallel", "pforeach"]);

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
function isForwarderDownstreamExempt(stage: string): boolean {
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
export const SILENT_COMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "status", "log", "diff", "branch", "tag", "remote", "config",
    "rev-parse", "rev-list", "shortlog", "blame", "show", "ls-files",
  ]),
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
const SILENT_ALLOW_ALL = new Set(["openspec"]);

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
const GIT_BLOB_OK_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "blame", "rev-parse", "rev-list", "shortlog",
]);

// Change C: go subcommands that accept repo-relative positional after the
// subcommand (D3 in design.md). `go vet` and `go fmt` are the read-only
// (or worktree-only-write) forms; all other go subcommands (build, test,
// run, mod tidy, mod download, ...) remain UNRELIABLE.
const GO_SILENT_POSITIONAL_SUBCOMMANDS = new Set(["vet", "fmt"]);

// npm/yarn/pnpm script-name whitelist for `run <script>` form (D3).
const NPM_RUN_OK_SCRIPTS = new Set(["test", "lint", "audit"]);

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
function looksLikeFileExtensionAfterDot(s: string): boolean {
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
function looksLikeRevision(rev: string): boolean {
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
function looksLikeGitBlobToken(token: string): boolean {
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
function looksLikeRepoRelativePath(token: string): boolean {
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
const TSC_ENTRY_FLAGS = new Set(["--noEmit", "--version", "--help", "-h"]);

// tsc allowed-with-value flags. Both `--flag=<v>` and `--flag <v>` forms
// are accepted; `<v>` must be a non-flag token (non-`--`).
const TSC_FLAG_TAKES_VALUE = new Set([
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
const TSC_FLAG_BOOL = new Set([
  "--incremental", "--strict", "--skipLibCheck",
  "--watch", "-w",
]);

// tsc REJECTED flags: emit-related, path-related, --build/-b. Any
// occurrence → return false from isSilentTsc (D2 in design.md).
const TSC_REJECTED_FLAGS = new Set([
  "--outDir", "--declarationDir", "--rootDir",
  "--declaration", "--declarationMap", "--sourceMap", "--outFile",
  "--emitDeclarationOnly", "--emitDecoratorMetadata", "--isolatedDeclarations",
  "--noCheck", "--build", "-b",
]);

/**
 * Classify a tsc flag name (already stripped of any `=<value>` suffix).
 * Returns one of "entry" | "safe" | "safe-value" | "rejected" | "unknown".
 */
function classifyTscFlag(name: string): "entry" | "safe" | "safe-value" | "rejected" | "unknown" {
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
function isSilentTsc(tokens: string[]): boolean {
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
function isSilentGo(tokens: string[]): boolean {
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
const NPX_FLAG_BOOL = new Set([
  "--yes", "-y",
  "--silent", "--quiet",
  "--no-fund", "--no-timing", "--no-update-notifier",
  "--offline", "--prefer-offline",
]);

// npx allowed flags with a value: `--cache=<path>`, `--color=<mode>`,
// `--loglevel=<level>`, `--cache <path>`, `--color <mode>`,
// `--loglevel <level>`. Value is NOT validated further (npm CLI
// accepts a wide range of levels/modes).
const NPX_FLAG_TAKES_VALUE = new Set([
  "--cache", "--color", "--loglevel",
]);

// npx REJECTED flags: --prefix (cwd change), --package (multi-value
// package injection), --call/-c (arbitrary script execution).
const NPX_REJECTED_FLAGS = new Set([
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
function isSilentNpx(tokens: string[]): boolean {
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
export function tokenizeBashCommand(command: string): string[] {
  return tokenize(command);
}

// Whether a token looks like a filesystem path (bare or home-prefixed).
// Deliberately conservative: rejects anything with `$` (unresolved variable
// reference), shell operators, or flags.
export function looksLikePathToken(token: string): boolean {
  if (!token) return false;
  if (token.includes("$")) return false;
  if (token === ";" || token === "&&" || token === "||" || token === "|") return false;
  if (token.startsWith("-")) return false;
  return looksLikePath(token);
}

// -------- Variable check --------

const SAFE_VARS = new Set(["HOME", "PWD"]);

// Shell special parameters whose expansion does NOT affect filesystem path
// resolution. They are pure numeric / scalar values whose runtime value does
// not change which paths a command touches, so they are treated as "understood"
// rather than flagged as unresolved:
//   $?  -> last exit status (0-255, numeric)
//   $!  -> last background process PID (numeric)
//   $#  -> positional arg count (numeric)
//   $$  -> current process PID (numeric)
// In contrast $@ $* $- $0..$9 MAY expand into paths (positional arguments can
// be file paths the user intends to `cat`/`rm`), so those remain unreliable.
const INERT_SPECIAL_PARAMS = new Set(["?", "!", "#", "$"]);

/**
 * Quote-aware variable scanner. Walks through the command tracking single
 * quote, double quote, and escape state. Returns the first unresolved
 * variable (indirect, arithmetic, path-bearing special, or regular), or
 * undefined.
 *
 * Inside single quotes: `$` is literal, so `$VAR` does not expand.
 * Inside double quotes: `\$` is literal, but bare `$VAR` still expands.
 * Outside quotes: `\$` is literal, bare `$VAR` expands.
 *
 * Inert special params ($? $! $# $$) are treated as understood — they do not
 * affect filesystem path resolution.
 */
function findUnresolvedVariable(cmd: string, loopVars: string[] = []): string | undefined {
  let quote: null | "'" | '"' = null;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) { escaped = false; continue; }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue; // $ inside single quotes is literal
    }
    if (ch === "\\") { escaped = true; continue; }
    // Open single quote: enter single-quote mode. Without this branch the
    // scanner never enters `quote === "'"` state, so `$` inside single
    // quotes (e.g. `awk '{print $6}'`, `echo '$HOME'`) is falsely flagged
    // as an unresolved variable. Mirrors the paired open/close pattern used
    // by scanUnreliable, splitPipelines, tokenize, splitCommands, and
    // expandSafeVariables.
    if (ch === "'") { quote = "'"; continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      // $VAR inside double quotes still expands
    }
    // Only check for $ when outside single quotes.
    if (quote === "'" || ch !== "$") continue;

    const rest = cmd.slice(i);
    // 1. Indirect expansion: ${!X}
    let m = /^\$\{!([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
    if (m) return `indirect:${m[1]}`;
    // 2. Arithmetic: $(( ... ))
    if (/^\$\(\(/.test(rest)) return "arithmetic";
    // 3. Special params: $@ $* $- $? $! $0..$9.
    //    Inert ones ($? $! $# $$) do not affect path resolution — treat as
    //    understood. Path-bearing ones ($@ $* $- $0..$9) still flag.
    m = /^\$([@*\-?!#0-9$])/.exec(rest);
    if (m) {
      const p = m[1];
      if (INERT_SPECIAL_PARAMS.has(p)) continue; // skip, keep scanning
      return `special:${p}`;
    }
    // 4. Regular variable: $VAR or ${VAR}
    m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(rest);
    if (m && !SAFE_VARS.has(m[1]) && !loopVars.includes(m[1])) return m[1];
  }
  return undefined;
}

// -------- Variable expansion --------

/**
 * Quote-aware safe variable expansion. Only substitutes `$HOME`, `${HOME}`,
 * `$PWD`, `${PWD}` — and only when they appear outside single quotes (where
 * `$` is literal) or as unescaped `$` inside double quotes / outside quotes.
 *
 * Does NOT expand inside single quotes, and does NOT expand `\$` (escaped).
 */
function expandSafeVariables(cmd: string, env: NodeJS.ProcessEnv): string {
  let out = "";
  let quote: null | "'" | '"' = null;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    // Only try to expand $ outside single quotes (single-quote branch above
    // already `continue`s, so TypeScript narrows `quote` to `null | '"'`).
    if (ch === "$") {
      // Match $HOME, ${HOME}, $PWD, ${PWD}
      const rest = cmd.slice(i);
      const m = /^\$\{?(HOME|PWD)\}?/.exec(rest);
      if (m) {
        out += env[m[1]] ?? "";
        i += m[0].length - 1; // -1 because loop increments
        continue;
      }
    }
    if (ch === "'") { quote = "'"; out += ch; continue; }
    if (ch === '"') { quote = quote === '"' ? null : '"'; out += ch; continue; }
    out += ch;
  }
  return out;
}

// -------- Command splitting --------

// Split compound commands by `;` or `&&` or `||`. Quote-aware: does NOT split
// inside single or double quotes, and does NOT split after backslash escapes.
function splitCommands(cmd: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: null | "'" | '"' = null;
  let escaped = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];

    if (escaped) {
      cur += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      cur += ch;
      escaped = true;
      i += 1;
      continue;
    }
    if (quote === '"') {
      cur += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "'") { quote = "'"; cur += ch; i += 1; continue; }
    if (ch === '"') { quote = '"'; cur += ch; i += 1; continue; }

    // Only split on top-level separators.
    if (cmd.startsWith("&&", i)) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      i += 2;
      continue;
    }
    if (cmd.startsWith("||", i)) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      i += 2;
      continue;
    }
    if (ch === ";") {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    // Background separator `&` — but NOT `&>` (stdout+stderr redirect),
    // `N>&N` (fd-dup) or `N>&-` (fd-close), where the `&` is preceded by a
    // digit and followed by `>`. In those cases the `&` is part of a redirect
    // operator, not a background operator.
    if (ch === "&") {
      const prev = i > 0 ? cmd[i - 1] : "";
      const next = i + 1 < cmd.length ? cmd[i + 1] : "";
      const isFdRedirect = /[0-9]/.test(prev) && next === ">";
      const isStdoutStderrRedirect = next === ">";
      if (!isFdRedirect && !isStdoutStderrRedirect) {
        if (cur.trim()) parts.push(cur.trim());
        cur = "";
        i += 1;
        continue;
      }
    }
    // Newline is also a command separator (multi-line commands pasted from
    // terminal output, or formatted scripts). Inside quotes the quote/escape
    // branches above already `continue`, so we never reach here for quoted
    // newlines.
    if (ch === "\n") {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// -------- Tokenizer --------

function tokenize(command: string): string[] {
  // Simple whitespace tokenizer with single/double-quote handling.
  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  let quote: string | null = null;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// -------- Path validity --------

// A "path" for our purposes is something that looks like a filesystem path:
//   - starts with / or ~ or C:\ or ./ or ../
//   - or has an extension (foo.txt, bar.log, etc.)
//   - or is a plain relative token like `src/main.ts`
//
// It's NOT a path if:
//   - it looks like a URL (http://, https://, ftp://)
//   - it starts with a dash (flag)
//   - it looks like a device path (/dev/*) - though we DO want /dev targets,
//     they usually indicate /dev/null etc. which we can ignore silently
function looksLikePath(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("-")) return false;
  if (/^[a-z]+:\/\//i.test(token)) return false; // URL
  if (token.startsWith("/")) return true;
  if (token.startsWith("~")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (token.startsWith("./") || token.startsWith("../")) return true;
  // Anything with a dot and not too many chars could be a relative file
  if (/\.\w+$/.test(token) && token.length < 256) return true;
  return false;
}

// -------- Redirect extraction --------

function extractRedirects(command: string, targets: Array<{ action: ExtractAction; path: string }>, projectRoot: string) {
  // Scan the command for redirect operators followed by a target path.
  // Operators we handle:
  //   writes: 2>> , 2> , >> , > , >& , 2>&1 (skip - refers to fd, not file)
  //   reads:  < (input redirect; NOT << which is heredoc, NOT <(...) which is
  //           process substitution — both handled by scanUnreliable).
  //
  // Strategy: use a scanner that walks char-by-char and identifies an operator
  // followed by whitespace and a token. This is more robust than a single regex
  // because operators overlap (2>> vs 2> vs >>).
  let i = 0;
  while (i < command.length) {
    const start = i;
    // Detect operator.
    let op = "";
    let action: ExtractAction = "write";
    // `<` input redirect — check BEFORE heredoc/process-substitution so
    // that a bare `<` (not `<<`, not `<(`) reaches the redirect logic.
    if (command[i] === "<") {
      if (command[i + 1] === "<") {
        // Heredoc start — not a redirect. Skip the `<<` pair.
        i += 2;
        continue;
      }
      // `<` alone (optionally preceded by an fd number, which we do not
      // parse here — `0<`/`1<` etc. all mean "read from file").
      op = "<";
      action = "read";
      i += 1;
    } else if (command[i] === "2" && command[i + 1] === ">" && command[i + 2] === ">") {
      op = "2>>";
      i += 3;
    } else if (command[i] === "2" && command[i + 1] === ">" && command[i + 2] === "&") {
      // 2>&N refers to a file descriptor, not a file path - skip entirely.
      i += 3;
      // Skip the number
      while (i < command.length && /[0-9]/.test(command[i])) i += 1;
      continue;
    } else if (command[i] === "2" && command[i + 1] === ">") {
      op = "2>";
      i += 2;
    } else if (command[i] === ">" && command[i + 1] === ">") {
      op = ">>";
      i += 2;
    } else if (command[i] === ">" && command[i + 1] === "&") {
      op = ">&";
      i += 2;
    } else if (command[i] === ">") {
      op = ">";
      i += 1;
    } else {
      i += 1;
      continue;
    }

    // Skip whitespace after operator.
    while (i < command.length && /\s/.test(command[i])) i += 1;

    // Read path token until whitespace or another special char.
    let path = "";
    while (i < command.length && !/[\s;|>&<]/.test(command[i])) {
      path += command[i];
      i += 1;
    }

    if (!path) continue;
    if (!looksLikePath(path)) continue;
    const abs = toAbsolutePath(expandHome(path), projectRoot);

    if (action === "read") {
      // Read target — no /dev/* exemption for reads; `/dev/tcp/*` etc.
      // still don't make sense as input redirects, so we simply record
      // what we saw. The caller (extractBashTargets) will decide policy.
      targets.push({ action: "read", path: abs });
      continue;
    }

    // Write target path (default branch, preserved from before this change).
    if (abs.startsWith("/dev/")) {
      if (isDevSocketOrFd(abs)) {
        targets.push({ action: "write", path: abs });
      }
      // Non-socket, non-numeric-fd `/dev/*` paths: skip silently.
      continue;
    }
    targets.push({ action: "write", path: abs });
    void start; // (retained for clarity)
    void op;    // op records which operator; not used for downstream branching
  }
}

// -------- Command-specific extractors --------

type Extractor = (tokens: string[], targets: Array<{ action: ExtractAction; path: string }>, projectRoot: string) => void;

// Extract target paths from `mv` (2 args: src, dst).
const mvExtract: Extractor = (tokens, targets, root) => {
  // `mv [flags] src dst`
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length >= 2) {
    const [src, dst] = args;
    if (looksLikePath(src)) targets.push({ action: "read", path: toAbsolutePath(expandHome(src), root) });
    if (looksLikePath(dst)) targets.push({ action: "write", path: toAbsolutePath(expandHome(dst), root) });
  }
};

// Extract target paths from `cp` (2 args: src, dst).
const cpExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length >= 2) {
    const [src, dst] = args;
    if (looksLikePath(src)) targets.push({ action: "read", path: toAbsolutePath(expandHome(src), root) });
    if (looksLikePath(dst)) targets.push({ action: "write", path: toAbsolutePath(expandHome(dst), root) });
  }
};

// Extract target paths from `rm` - all args are delete targets.
const rmExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const a of args) {
    if (looksLikePath(a)) targets.push({ action: "delete", path: toAbsolutePath(expandHome(a), root) });
  }
};

// Extract target paths from `cat`/`head`/`tail`/`wc`/`grep` and other
// read-only directory/file enumeration commands (ls, find, tree, stat, du, df,
// file, less, more). All treated as read actions.
const readExtract: Extractor = (tokens, targets, root) => {
  // Skip the command; then skip leading flags and their values.
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith("-")) {
      // Flags like -n, -l, --line-numbers, --bytes N etc. Skip one arg if
      // it looks like a flag that takes an argument.
      if (/^-[bns][0-9]+$/.test(t)) {
        // e.g. -n5: no separate arg
        continue;
      }
      if (/^--(?:bytes|lines|count)=/.test(t)) {
        // e.g. --bytes=5
        continue;
      }
      if (/^--(?:bytes|lines|count|ignore-case)$/.test(t)) {
        // --bytes 5, --lines 10 - skip next arg (number)
        i += 1;
        continue;
      }
      continue;
    }
    if (looksLikePath(t)) {
      targets.push({ action: "read", path: toAbsolutePath(expandHome(t), root) });
    }
  }
};

// Extract target paths from `mkdir`. Every non-flag arg is a directory
// to be created - classify as write.
const mkdirExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const a of args) {
    if (looksLikePath(a)) targets.push({ action: "write", path: toAbsolutePath(expandHome(a), root) });
  }
};

// Extract target paths from `touch` - every non-flag arg is a file to create.
const touchExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const a of args) {
    if (looksLikePath(a)) targets.push({ action: "write", path: toAbsolutePath(expandHome(a), root) });
  }
};

// Extract target paths from `test`/`[` - the first path arg is read (existence check).
const testExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith("-")) {
      // `-e path` / `-f path` etc. take a next-arg path.
      if (/^-[efLsSbcpkru]$/.test(t)) {
        const next = args[i + 1];
        if (next && looksLikePath(next)) {
          targets.push({ action: "read", path: toAbsolutePath(expandHome(next), root) });
        }
        i += 1;
      }
      continue;
    }
    // Plain `test path` or `test -e path` - single arg case.
    if (looksLikePath(t)) {
      targets.push({ action: "read", path: toAbsolutePath(expandHome(t), root) });
    }
  }
};

// Extract target paths from `tee`.
const teeExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const a of args) {
    if (looksLikePath(a)) targets.push({ action: "write", path: toAbsolutePath(expandHome(a), root) });
  }
};

// Extract target paths from `ln -s src dst`.
const lnExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length >= 2) {
    const [src, dst] = args;
    if (looksLikePath(dst)) targets.push({ action: "write", path: toAbsolutePath(expandHome(dst), root) });
    // src is the link target (typically a path that doesn't need to exist yet)
    if (looksLikePath(src)) targets.push({ action: "write", path: toAbsolutePath(expandHome(src), root) });
  }
};

// Extracts target paths from `chmod` / `chown`.
const metaExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1);
  // Skip leading flags and mode/owner args (non-path tokens).
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith("-")) continue;
    if (looksLikePath(t)) {
      targets.push({ action: "write", path: toAbsolutePath(expandHome(t), root) });
    }
    // Non-path tokens like "600" or "eliot" are mode/owner - skip.
  }
};

// Extract target paths from `truncate`.
const truncateExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith("-")) continue;
    // truncate -s SIZE file
    if (/^--size=/.test(t) || /^-[sSnN]+\d/.test(t)) continue;
    if (looksLikePath(t)) {
      targets.push({ action: "write", path: toAbsolutePath(expandHome(t), root) });
    }
  }
};

// Extract target paths from `dd of=...`.
const ddExtract: Extractor = (tokens, targets, root) => {
  for (const t of tokens.slice(1)) {
    const m = t.match(/^of=(.+)$/);
    if (m && looksLikePath(m[1])) {
      targets.push({ action: "write", path: toAbsolutePath(expandHome(m[1]), root) });
    }
  }
};

// Extract target paths from `curl -o <path>` or `--output <path>`.
const curlExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "-o" || t === "--output" || t === "-O") {
      const next = args[i + 1];
      if (next && !next.startsWith("-") && looksLikePath(next)) {
        targets.push({ action: "write", path: toAbsolutePath(expandHome(next), root) });
      } else if (t === "-O") {
        // -O with no arg means use URL's filename - we don't know it. Skip.
      }
      i += 1;
      continue;
    }
    const m = t.match(/^--output=(.+)$/);
    if (m && looksLikePath(m[1])) {
      targets.push({ action: "write", path: toAbsolutePath(expandHome(m[1]), root) });
    }
    // URL args: skip (they're not filesystem paths).
  }
};

// Extract target paths from `wget -O <path>`.
const wgetExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "-O" || t === "--output-document") {
      const next = args[i + 1];
      if (next && !next.startsWith("-") && looksLikePath(next)) {
        targets.push({ action: "write", path: toAbsolutePath(expandHome(next), root) });
      }
      i += 1;
      continue;
    }
    const m = t.match(/^--output-document=(.+)$/);
    if (m && looksLikePath(m[1])) {
      targets.push({ action: "write", path: toAbsolutePath(expandHome(m[1]), root) });
    }
  }
};

// Extract target paths from `find`. Delegate to `readExtract` for the
// path-reading behavior. The reliability check for `find` write flags
// (`-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`) is done earlier by
// `scanFindWriteFlags` in the main extraction flow, so by the time we
// reach the extractor, the command has already been validated as either
// read-only or marked unreliable.
const findExtract: Extractor = readExtract;

// Extract target paths from `install`.
const installExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length >= 2) {
    const [src, dst] = args;
    if (looksLikePath(src)) targets.push({ action: "read", path: toAbsolutePath(expandHome(src), root) });
    if (looksLikePath(dst)) targets.push({ action: "write", path: toAbsolutePath(expandHome(dst), root) });
  }
};

// -------- Command table --------

const COMMAND_TABLE: Record<string, Extractor> = {
  rm: rmExtract,
  mv: mvExtract,
  cp: cpExtract,
  cat: readExtract,
  head: readExtract,
  tail: readExtract,
  wc: readExtract,
  grep: readExtract,
  // Read-only directory/file enumeration commands. Each path arg is treated
  // as a read target so that outer-non-sensitive reads get audited through
  // the standard pipeline (silent auto-allow by default).
  ls: readExtract,
  find: findExtract,
  tree: readExtract,
  stat: readExtract,
  du: readExtract,
  df: readExtract,
  file: readExtract,
  less: readExtract,
  more: readExtract,
  test: testExtract,
  "[": testExtract,
  tee: teeExtract,
  ln: lnExtract,
  chmod: metaExtract,
  chown: metaExtract,
  truncate: truncateExtract,
  dd: ddExtract,
  curl: curlExtract,
  wget: wgetExtract,
  install: installExtract,
  mkdir: mkdirExtract,
  touch: touchExtract,
};

// -------- Meta commands: control flow + shell forwarders --------

// Control-flow keywords make a command's runtime behavior non-statically-
// determinable (loop variables, branch conditions). Treat the whole command
// as unreliable when any of these appear as a standalone token outside quotes.
const CONTROL_FLOW_KEYWORDS = new Set([
  "while", "for", "until", "if", "then", "else", "elif", "fi",
  "case", "in", "esac", "do", "done",
]);

// Quote-aware scan: returns `{ hit: true }` if any control-flow keyword
// appears as an independent token outside single/double quotes, unless the
// keyword is part of an exempted construct (currently: literal-iteration
// `for ... done`). When a `for` loop is exempted, its loop variable name is
// collected in `loopVars` so the variable-resolution pass (step 4 in
// `extractBashTargets`) treats `$VAR` as already resolved.
function scanControlFlow(cmd: string, projectRoot?: string): {
  hit: boolean;
  loopVars: string[];
} {
  let quote: null | "'" | '"' = null;
  let escaped = false;
  let tokenStart = -1; // index in cmd where current token began (-1 = no token)
  const loopVars: string[] = [];

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    // Escape handling: applies inside double quotes and outside quotes,
    // but NOT inside single quotes.
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'") { quote = "'"; continue; }
    if (ch === '"') { quote = '"'; continue; }

    // Outside any quote. Track tokens.
    const isBoundary = /[\s;&|()]/.test(ch);

    if (isBoundary) {
      // End of current token. Check if we were accumulating a keyword.
      if (tokenStart >= 0) {
        const token = cmd.slice(tokenStart, i);
        if (token === "for") {
          const forResult = isLiteralForLoop(cmd, tokenStart);
          if (forResult.exempt) {
            loopVars.push(forResult.varName!);
            i = forResult.doneEnd! - 1; // for-loop i++ will land at doneEnd
            tokenStart = -1;
            continue;
          }
          // Glob-iteration exemption: if the for-loop has a glob in its
          // iteration set, body is read-only, and the glob prefix is bounded,
          // skip the loop as a whole (same as literal exemption).
          if (projectRoot && isGlobForLoopExempt(cmd, tokenStart, projectRoot)) {
            const loopInfo = parseGlobForLoop(cmd, tokenStart);
            if (loopInfo) {
              loopVars.push(loopInfo.varName);
              i = loopInfo.doneEnd - 1;
              tokenStart = -1;
              continue;
            }
          }
          // Not exempt: `for` is a control-flow keyword.
          return { hit: true, loopVars };
        }
        if (token.length > 0 && CONTROL_FLOW_KEYWORDS.has(token)) {
          return { hit: true, loopVars };
        }
        tokenStart = -1;
      }
      continue;
    }

    // Non-boundary character: extend or start a token.
    if (tokenStart < 0) tokenStart = i;
  }

  // Handle final token at end of command.
  if (tokenStart >= 0) {
    const token = cmd.slice(tokenStart);
    if (token === "for") {
      const forResult = isLiteralForLoop(cmd, tokenStart);
      if (forResult.exempt) {
        loopVars.push(forResult.varName!);
        return { hit: false, loopVars };
      }
      if (projectRoot && isGlobForLoopExempt(cmd, tokenStart, projectRoot)) {
        const loopInfo = parseGlobForLoop(cmd, tokenStart);
        if (loopInfo) {
          loopVars.push(loopInfo.varName);
          return { hit: false, loopVars };
        }
      }
      return { hit: true, loopVars };
    }
    if (CONTROL_FLOW_KEYWORDS.has(token)) return { hit: true, loopVars };
  }

  return { hit: false, loopVars };
}

/**
 * Check if a for-loop at `pos` qualifies for the glob-iteration exemption.
 * The loop must have a glob in its iteration set, a read-only body, and the
 * glob prefix must be inside projectRoot. Returns true if exempt.
 */
function isGlobForLoopExempt(
  cmd: string,
  pos: number,
  projectRoot: string,
): boolean {
  const info = parseGlobForLoop(cmd, pos);
  if (!info) return false;
  if (!info.iterHasGlob) return false;
  if (!info.globPrefixes.every(p => isBoundedPrefix(p, projectRoot))) return false;
  if (!isForBodyReadOnly(info.body)) return false;
  return true;
}

/**
 * Parse a for-loop beginning at `pos` (the `for` keyword index) to extract
 * the loop variable name, iteration set, body, and glob prefixes.
 * Returns null if the structure is invalid.
 *
 * This is a lighter parser than `isLiteralForLoop`: it does NOT check whether
 * iteration-set words are literals. It only extracts the structure so the
 * caller can check glob prefixes and body read-only status.
 */
function parseGlobForLoop(cmd: string, pos: number): {
  varName: string;
  iterHasGlob: boolean;
  globPrefixes: string[];
  body: string;
  doneEnd: number;
} | null {
  let i = pos + 3; // skip `for`

  // --- skip whitespace to VAR ---
  while (i < cmd.length && /\s/.test(cmd[i])) i++;
  const varStart = i;
  while (i < cmd.length && !/\s/.test(cmd[i])) i++;
  const varName = cmd.slice(varStart, i);
  if (!varName) return null;

  // --- expect `in` ---
  while (i < cmd.length && /\s/.test(cmd[i])) i++;
  const inStart = i;
  while (i < cmd.length && !/\s/.test(cmd[i])) i++;
  if (cmd.slice(inStart, i) !== "in") return null;

  // --- scan iteration-set words until `;` or `do` ---
  const globPrefixes: string[] = [];
  let iterHasGlob = false;
  let iterQuote: null | "'" | '"' = null;
  let iterEscaped = false;
  let iterEnd = -1;
  let iterStart = i;
  let wordStart = -1;

  while (i < cmd.length) {
    const ch = cmd[i];
    if (iterEscaped) { iterEscaped = false; i++; continue; }
    if (iterQuote) {
      if (ch === iterQuote) iterQuote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { iterQuote = ch; i++; continue; }
    if (ch === "\\") { iterEscaped = true; i++; continue; }
    if (/\s/.test(ch)) {
      if (wordStart >= 0) {
        // End of a word in the iteration set.
        wordStart = -1;
      }
      i++;
      continue;
    }
    if (ch === ";") {
      if (wordStart >= 0) {
        // Check if this word has a glob.
        const word = cmd.slice(wordStart, i);
        if (/[?*\\[]/.test(word)) {
          iterHasGlob = true;
          // Extract prefix: chars before first glob char in this word.
          const globIdx = word.search(/[?*\\[]/);
          globPrefixes.push(word.slice(0, globIdx));
        }
        wordStart = -1;
      }
      iterEnd = i;
      break;
    }
    if (ch === "*" || ch === "?" || ch === "[") {
      // Glob found in iteration set.
      iterHasGlob = true;
      // Extract prefix from word start to this glob char.
      if (wordStart >= 0) {
        globPrefixes.push(cmd.slice(wordStart, i));
      }
    }
    if (wordStart < 0) wordStart = i;
    i++;
  }
  if (iterEnd < 0) return null; // never hit `;`

  // --- find `do` ---
  let j = iterEnd + 1;
  let doPos = -1;
  while (j < cmd.length) {
    while (j < cmd.length && /\s/.test(cmd[j])) j++;
    const k = j;
    while (j < cmd.length && !/\s/.test(cmd[j])) j++;
    if (cmd.slice(k, j) === "do") { doPos = k; break; }
    return null; // not a valid for-loop
  }
  if (doPos < 0) return null;

  // --- find matching `done` ---
  let depth = 1;
  let bodyTokenStart = -1;
  let bodyQuote: null | "'" | '"' = null;
  let bodyEscaped = false;
  let doneEnd = -1;
  i = doPos + 2; // skip `do`
  while (i < cmd.length && depth > 0) {
    const ch = cmd[i];
    if (bodyEscaped) { bodyEscaped = false; i++; continue; }
    if (ch === "\\") { bodyEscaped = true; i++; continue; }
    if (bodyQuote) {
      if (ch === bodyQuote) bodyQuote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { bodyQuote = ch; i++; continue; }
    if (/\s/.test(ch)) {
      if (bodyTokenStart >= 0) {
        const tok = cmd.slice(bodyTokenStart, i);
        if (tok === "done") {
          depth--;
          if (depth === 0) doneEnd = i + 1;
        }
        bodyTokenStart = -1;
      }
      i++;
      continue;
    }
    if (bodyTokenStart < 0) bodyTokenStart = i;
    i++;
  }
  if (depth > 0 && bodyTokenStart >= 0) {
    const tok = cmd.slice(bodyTokenStart);
    if (tok === "done") {
      depth--;
      if (depth === 0) doneEnd = cmd.length;
    }
  }
  if (doneEnd < 0) return null;

  // --- extract body ---
  const body = cmd.slice(doPos + 2, doneEnd - 4).trim();

  return { varName, iterHasGlob, globPrefixes, body, doneEnd };
}

/**
 * Check whether a word in a for-iteration set is a literal (no expansion).
 * Returns true if the word contains no `$` (except inert specials `$?`/`$!`/`$#`/`$$`),
 * no backtick, no `$()`, and no unquoted glob (`* ? [`).
 * Quoted words are handled by the caller (this function sees the raw word).
 */
function isLiteralIterationWord(word: string): boolean {
  // Check for `$` outside inert specials.
  const dollarMatches = word.match(/\$\w+/g);
  if (dollarMatches) {
    for (const m of dollarMatches) {
      const varName = m.slice(1);
      if (!["?", "!", "#", "$"].includes(varName)) return false;
    }
  }
  // Check for backtick.
  if (word.includes("`")) return false;
  // Check for command substitution $().
  if (word.includes("$(")) return false;
  // Check for unquoted glob (`* ? [`).
  if (/[?*\\[]/.test(word)) return false;
  return true;
}

// Harmless builtins: commands that produce output or manage state but do
// NOT touch filesystem paths (no read/write/delete). Allowed in for-loop
// bodies alongside READ_ONLY_COMMANDS and SILENT_COMMANDS.
const HARMLESS_BUILTINS = new Set([
  "echo", "printf", "true", "false", "pwd", "cd", "test", "[",
  ":", "sleep", "export", "set", "unset", "type", "which", "hash",
  "seq", "basename", "dirname",
]);

/**
 * Check whether a for-loop body consists only of read-only/harmless commands.
 * The body string is the text between `do` and `done` (excluding them).
 */
function isForBodyReadOnly(body: string): boolean {
  if (!body.trim()) return true; // empty body is OK (no commands)
  // Split by top-level command separators (`;`, `&&`, `||`, `&`, `\n`).
  // This groups each body command as one part (e.g. `grep "$f"`), so we can
  // extract the leading command name with tokenize.
  const parts = splitCommands(body);

  for (const part of parts) {
    if (!part.trim()) continue;
    const tokens = tokenize(part);
    if (tokens.length === 0) continue;
    const cmdName = tokens[0].split("/").pop();
    // `isReadOnlyWithArgs` gives `find` per-argument analysis (write flags
    // like `-delete`/`-exec` make the body non-read-only). Other commands
    // fall through to READ_ONLY_COMMANDS via isReadOnlyWithArgs.
    if (!isReadOnlyWithArgs(cmdName, tokens.slice(1)) && !isSilentCommand(cmdName, tokens.slice(1)) && !HARMLESS_BUILTINS.has(cmdName)) {
      return false;
    }
  }
  return true;
}

/**
 * Analyze a `for ... done` block beginning at `pos` (the `for` keyword index)
 * to decide whether it qualifies for the literal-iteration exemption.
 *
 * Conditions (design.md D6):
 *   1. Structure: `for VAR in WORD1 ... WORDN ; do BODY ; done`.
 *   2. Iteration set: every WORD is a literal (see isLiteralIterationWord).
 *   3. Loop body: each body command's leading name is in READ_ONLY_COMMANDS
 *      or SILENT_COMMANDS (see isForBodyReadOnly).
 *
 * Returns `{ exempt: true, varName, doneEnd }` when exempt, where `doneEnd`
 * is the index just past `done` (the caller's `i++` lands exactly on
 * `doneEnd`, resuming the scan after the block). Otherwise `{ exempt: false }`.
 */
function isLiteralForLoop(cmd: string, pos: number): {
  exempt: boolean;
  varName?: string;
  doneEnd?: number;
} {
  let i = pos + 3; // skip `for`

  // --- skip whitespace to VAR ---
  while (i < cmd.length && /\s/.test(cmd[i])) i += 1;
  const varStart = i;
  while (i < cmd.length && !/\s/.test(cmd[i])) i += 1;
  const varName = cmd.slice(varStart, i);
  if (!varName) return { exempt: false };

  // --- expect `in` ---
  while (i < cmd.length && /\s/.test(cmd[i])) i += 1;
  const inStart = i;
  while (i < cmd.length && !/\s/.test(cmd[i])) i += 1;
  if (cmd.slice(inStart, i) !== "in") return { exempt: false };

  // --- scan iteration-set words until `;` ---
  const words: string[] = [];
  let wordStart = -1;
  let iterQuote: null | "'" | '"' = null;
  let iterEscaped = false;
  let iterEnd = -1;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (iterEscaped) { iterEscaped = false; i += 1; continue; }
    if (ch === "\\") { iterEscaped = true; i += 1; continue; }
    if (iterQuote) {
      if (ch === iterQuote) iterQuote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') { iterQuote = ch; i += 1; continue; }
    if (/\s/.test(ch)) {
      if (wordStart >= 0) {
        words.push(cmd.slice(wordStart, i));
        wordStart = -1;
      }
      i += 1;
      continue;
    }
    if (ch === ";") {
      if (wordStart >= 0) words.push(cmd.slice(wordStart, i));
      iterEnd = i;
      break;
    }
    // `(` starts subshell/process-subst → iteration set not literal
    if (ch === "(") return { exempt: false };
    if (wordStart < 0) wordStart = i;
    i += 1;
  }
  if (iterEnd < 0) return { exempt: false }; // never hit `;`

  // --- each iteration-set word must be literal ---
  for (const w of words) {
    if (!isLiteralIterationWord(w)) return { exempt: false };
  }

  // --- find `do` (first non-whitespace token after `;`) ---
  let j = iterEnd + 1;
  let doPos = -1;
  while (j < cmd.length) {
    while (j < cmd.length && /\s/.test(cmd[j])) j += 1;
    const k = j;
    while (j < cmd.length && !/\s/.test(cmd[j])) j += 1;
    if (cmd.slice(k, j) === "do") { doPos = k; break; }
    // If the token is not `do`, this is not a valid for-loop
    return { exempt: false };
  }
  if (doPos < 0) return { exempt: false };

  // --- find matching `done` at body top level ---
  let depth = 1;
  let bodyTokenStart = -1;
  let bodyQuote: null | "'" | '"' = null;
  let bodyEscaped = false;
  let doneEnd = -1;
  i = doPos + 2; // skip `do`
  while (i < cmd.length && depth > 0) {
    const ch = cmd[i];
    if (bodyEscaped) { bodyEscaped = false; i += 1; continue; }
    if (ch === "\\") { bodyEscaped = true; i += 1; continue; }
    if (bodyQuote) {
      if (ch === bodyQuote) bodyQuote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') { bodyQuote = ch; i += 1; continue; }
    if (/\s/.test(ch)) {
      if (bodyTokenStart >= 0) {
        const tok = cmd.slice(bodyTokenStart, i);
        if (tok === "done") {
          depth -= 1;
          if (depth === 0) doneEnd = i + 1;
        }
        bodyTokenStart = -1;
      }
      i += 1;
      continue;
    }
    if (bodyTokenStart < 0) bodyTokenStart = i;
    i += 1;
  }
  // Flush final token (done at end of command without trailing whitespace).
  if (depth > 0 && bodyTokenStart >= 0) {
    const tok = cmd.slice(bodyTokenStart);
    if (tok === "done") {
      depth -= 1;
      if (depth === 0) doneEnd = cmd.length;
    }
  }
  if (doneEnd < 0) return { exempt: false }; // no matching done

  // --- body must be read-only only ---
  // body is between `do` (doPos+2, i.e. after "do") and `done` (doneEnd-4).
  const body = cmd.slice(doPos + 2, doneEnd - 4).trim();
  if (!isForBodyReadOnly(body)) return { exempt: false };

  return { exempt: true, varName, doneEnd };
}

// Shell names that, when followed by -c, execute a command from a string.
const SHELL_NAMES = new Set(["bash", "sh", "dash", "zsh"]);

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
const SHELL_WRAPPER_NAMES = new Set([
  "env", "command",
  "sudo", "nohup", "timeout", "watch", "nice",
]);

// Duration / priority value-taking flags that skipWrapperTokens must consume
// an extra token for. Each entry is a wrapperName → set of short flags that
// take a value. Kept separate from the generic "short flag without value"
// branch (which does NOT consume the following token) so `timeout 5 bash -c
// ...` and `nice -n 10 bash -c ...` are not mis-tokenized (L2 sub-task
// D2.1 in design.md).
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
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
function skipWrapperTokens(tokens: string[], startIdx: number, wrapperName: string): number {
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
function isShellForwarder(cmd: string): boolean {
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
function isShellForwarderTokenStream(tokens: string[]): boolean {
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
function scanCdChdir(cmd: string): string | undefined {
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

export function extractBashTargets(rawCommand: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): ExtractResult {
  // 0. `find` write flag guard: `find -delete` / `-exec` / `-execdir` /
  // `-ok` / `-okdir` at the leading position of any command fragment is a
  // write operation. Runs FIRST so its reason takes precedence over
  // `glob_expansion` when both are triggered (e.g. `find src/*.ts -delete`).
  // Runs before `scanControlFlow` so isolated `find` in a compound command
  // is caught even if the compound command doesn't itself contain a
  // control-flow keyword. (For-loop bodies are still handled by
  // `scanControlFlow` first, but a literal-iteration `for f in a b; do
  // find "$f" -delete; done` where the body is `find -delete` reaches this
  // guard — but note `scanControlFlow` runs after scanUnreliable so the
  // ordering between the two is: find_write_flag → scanUnreliable →
  // scanControlFlow → shell_forwarder.)
  if (scanFindWriteFlags(rawCommand)) {
    return { reliable: false, rawCommand, reason: "find_write_flag" };
  }

  // 1. Quote-aware scan for constructs that MUST be unreliable. Pass
  // projectRoot so the scanner can apply the bounded-glob allowlist (D6a).
  const reason = scanUnreliable(rawCommand, projectRoot);
  if (reason) {
    return { reliable: false, rawCommand, reason };
  }

  // 2. Control-flow keyword guard: keywords like while/for/if/case make the
  // command's flow non-statically-determinable. Runs BEFORE pipeline splitting
  // AND before variable checks — a control-flow command makes static analysis
  // of variables/filenames moot.
  const cfResult = scanControlFlow(rawCommand, projectRoot);
  if (cfResult.hit) {
    return { reliable: false, rawCommand, reason: "control_flow" };
  }

  // 2b. `cd` chdir guard (bash-hardening-round-2 L3): any compound command
  // whose fragment starts with `cd` cannot have its relative-path targets
  // resolved statically, because `cd` changes the cwd baseline for all
  // downstream fragments. Runs BEFORE `isShellForwarder` so a `cd` command
  // that also contains `bash -c` reports `cd_chdir` (the more specific
  // reason) rather than `shell_forwarder`. A lone `cd /etc` is exempt.
  if (scanCdChdir(rawCommand) === "cd_chdir") {
    return { reliable: false, rawCommand, reason: "cd_chdir" };
  }

  // 3. Shell-forwarder guard: `bash -c "..."` etc. run a command from a string
  // argument, which our tokenizer cannot see through. Runs BEFORE pipeline
  // splitting so `bash -c "cmd" | head` still triggers.
  if (isShellForwarder(rawCommand)) {
    return { reliable: false, rawCommand, reason: "shell_forwarder" };
  }

  // 4. Unreliable-command guard (bash-stage-b-security-fixes D2): commands
  // like sed/python3/node/scp/ssh that can execute arbitrary code or read
  // arbitrary files are unconditionally unreliable. Runs AFTER shell_forwarder
  // so `bash -c 'sed -i …'` correctly reports shell_forwarder (the outer
  // shell, not the inner interpreter, is what we can't parse).
  if (isAnyUnreliableCommand(rawCommand)) {
    // Change C: `npx --no-install <pkg>` is a static-safe form — even
    // though `npx` is in UNRELIABLE_COMMANDS, this specific form has
    // no network access (npm CLI's `--no-install` guarantees local-
    // package-only execution). Skip the UNRELIABLE_COMMANDS rejection
    // for npx iff isSilentNpx passes.
    if (!(SILENT_COMMANDS["npx"] && isSilentNpx(tokenize(rawCommand).slice(1)))) {
      return { reliable: false, rawCommand, reason: "unreliable_command" };
    }
    // npx --no-install silent form — proceed to 4b (which will also
    // short-circuit via isSilentNpx and skip the generic loop).
  } else {
    // Non-UNRELIABLE command — proceed normally.
    void 0;
  }

  // Change C: for the `npx --no-install` special form that skipped
  // 4a above, return silently immediately (bypassing 4b's generic
  // check which would otherwise reject any positional). This keeps
  // the 4a/4b interaction simple — 4b's own `npx` short-circuit
  // (isSilentNpx) still runs for other npx forms reached via the
  // isAnyUnreliableCommand=false path, but that path can only be
  // reached if npx is NOT in UNRELIABLE_COMMANDS, which is not the
  // current state. So the practical flow is:
  //   npx <silent-safe form> → 4a bypass → return silently here
  //   npx <other form>       → 4a rejects → UNRELIABLE_COMMAND
  if (isAnyUnreliableCommand(rawCommand) && SILENT_COMMANDS["npx"] && isSilentNpx(tokenize(rawCommand).slice(1))) {
    return { reliable: true, targets: [] };
  }

  // 4b. Silent-command form-check (bash-stage-b-security-fixes D1): if the
  // leading command of a SIMPLE single-command invocation is a SILENT_COMMANDS
  // key but does NOT match the narrowed form (e.g. `git log /etc/passwd`
  // where `log` is allowed but a path follows; `npm run build` where `run`
  // isn't in npm's allow-set), it is not silent. Instead of falling through
  // to fail-open (0-target reliable), flag it as unreliable_command — the
  // command is a dev-tool but invoked in a form that CAN read/write
  // outside the worktree, so the user should see a prompt rather than a
  // silent pass.
  //
  // Only applies to "simple" commands: no compound separators (`&&`, `||`,
  // `;`, `&`, `\n`) and no pipeline (`|`). We use `splitCommands` and
  // `splitPipelines` — the same quote-aware splitting used elsewhere —
  // instead of a naive character scan. This means compound commands like
  // `git status && rm -rf /etc/passwd` are delegated to the per-fragment
  // loop below, not misclassified by 4b's silent-form rule.
  //
  // For `git`, the post-subcommand phase is more permissive than the base
  // `isSilentCommand` rule: git accepts revision references (`HEAD`, `main`,
  // `HEAD~1`) and revision-like bare words after `log`/`diff`/`show`/etc.,
  // and those must not trip the "extra positional" check. We still reject
  // path-like tokens (`/etc/passwd`, `~/x`, `./x`, `../x`, `x.txt`).
  {
    // Fast bail: only simple single-command invocations (one fragment, one stage)
    // enter the silent-form check. Everything else is delegated to the
    // per-fragment pipeline below.
    const cmdFragments = splitCommands(rawCommand);
    if (cmdFragments.length === 1 && splitPipelines(cmdFragments[0]).length === 1) {
      const tks = tokenize(rawCommand);
      if (tks.length > 0) {
        const cmdName = tks[0].split("/").pop()!;
        if (SILENT_COMMANDS[cmdName]) {
          // Change C: `tsc` / `go` / `npx` short-circuit to their
          // dedicated silent-form evaluators to guarantee 4b and
          // isSilentCommand agree. If they return false, this command
          // is UNRELIABLE (the generic loop below would otherwise let
          // e.g. `tsc --outDir /tmp/x`, `go vet ./...`, or
          // `npx --no-install eslint src/**` pass through for various
          // reasons). If they return true, skip the generic loop
          // entirely.
          let skippedGeneric = false;
          if (cmdName === "tsc") {
            if (!isSilentTsc(tks.slice(1))) {
              return { reliable: false, rawCommand, reason: "unreliable_command" };
            }
            skippedGeneric = true;
          } else if (cmdName === "go") {
            if (!isSilentGo(tks.slice(1))) {
              return { reliable: false, rawCommand, reason: "unreliable_command" };
            }
            skippedGeneric = true;
          } else if (cmdName === "npx") {
            if (!isSilentNpx(tks.slice(1))) {
              return { reliable: false, rawCommand, reason: "unreliable_command" };
            }
            skippedGeneric = true;
          }
          if (skippedGeneric) {
            // Command is silent per its dedicated evaluator. Fall
            // through to step 5+ without running the generic loop.
          } else {
          const isAllowAll = SILENT_ALLOW_ALL.has(cmdName);
          const isStrict = !isAllowAll && cmdName !== "git";
          let sawSub: boolean | "__run_form__" | "__run_form_scripted__" = false;
          let seenGitSub: string | null = null;
          let skipNext = false;
          let ok = true;
          for (let i = 1; i < tks.length; i++) {
            const t = tks[i];
            if (skipNext) { skipNext = false; continue; }
            if (t === "--") continue;
            if (t.startsWith("--")) {
              // Long flag. Only consumes a next token if the form is `--flag value`
              // (no `=`) AND the next token is not another flag or `=` assignment.
              if (!t.includes("=")) {
                const next = tks[i + 1];
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
            if (t.startsWith("-")) {
              // Short flag (single dash). May be a value-taking flag
              // (e.g. `-n 10`) or a value-less flag (`-v`).
              if (!t.includes("=")) {
                const next = tks[i + 1];
                if (next !== undefined && !next.startsWith("-") && next !== "--" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
                  skipNext = true;
                }
              }
              continue;
            }
            if (!sawSub) {
              // Change B: allow `npm/yarn/pnpm run <script>` form here so
              // that the "second positional" (the script name) can be
              // checked against NPM_RUN_OK_SCRIPTS in the branch below.
              if ((cmdName === "npm" || cmdName === "yarn" || cmdName === "pnpm") && t === "run") {
                sawSub = "__run_form__";
                continue;
              }
              if (isAllowAll) { sawSub = true; continue; }
              if (!SILENT_COMMANDS[cmdName].has(t)) { ok = false; break; }
              if (cmdName === "git") { seenGitSub = t; }
              sawSub = true;
            } else if (sawSub === "__run_form__") {
              // Change B: expect a whitelisted script name after `run`.
              if (NPM_RUN_OK_SCRIPTS.has(t)) {
                sawSub = "__run_form_scripted__";
              } else {
                ok = false;
                break;
              }
            } else {
              // Extra positional after subcommand.
              if (isAllowAll) continue; // allow-all accepts any positional
              if (isStrict) { ok = false; break; }
              // git permissive mode. Under Change B, we allow any positional
              // that matches either the git blob syntax or a repo-relative
              // path. The strict "reject path-like token" rule from
              // pre-Change B is superseded by the more precise rules below.
              // Gated on GIT_BLOB_OK_SUBCOMMANDS so write subcommands
              // (branch/tag/config/ls-files/remote) do NOT get the permissive
              // path — they fall through to strict rejection. This mirrors
              // the same gate in isSilentCommand to keep the two paths in sync.
              if (
                cmdName === "git" &&
                seenGitSub !== null &&
                GIT_BLOB_OK_SUBCOMMANDS.has(seenGitSub)
              ) {
                if (looksLikeGitBlobToken(t) || looksLikeRepoRelativePath(t)) continue;
              }
              ok = false;
              break;
            }
          }
          // Change B: `npm run` without a whitelisted script name is not silent.
          if (sawSub === "__run_form__") { ok = false; }
          if (!ok) {
            return { reliable: false, rawCommand, reason: "unreliable_command" };
          }
          }  // end else (skip generic loop for tsc/go short-circuit)
        }
      }
    }
  }

  // 5. Check for unresolved user variables.
  const unresolved = findUnresolvedVariable(rawCommand, cfResult.loopVars);
  if (unresolved) {
    return { reliable: false, rawCommand, reason: `unresolved variable: ${unresolved}` };
  }

  // 3. Expand safe variables.
  const expanded = expandSafeVariables(rawCommand, env);

  // 4. Split compound commands by ; / && / ||.
  const commands = splitCommands(expanded);

  // 5. For each command fragment, split into pipeline stages and process each.
  const targets: Array<{ action: ExtractAction; path: string }> = [];
  for (const cmd of commands) {
    const stages = splitPipelines(cmd);

    // Check for forwarder in ANY stage (including first stage) BEFORE
    // extraction (D2, D8). Starting at i=0 covers the first stage —
    // a first-stage `xargs rm -rf` is a write operation that the
    // non-first-stage loop would have missed. Each forwarder stage is
    // checked via isForwarderStageSafe, which validates both the current
    // stage's downstream (read-only + statically determinable) and all
    // upstream stages (read-only, or recursively exempt forwarder).
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i].trim();
      const stageTokens = tokenize(stage);
      if (stageTokens.length > 0) {
        const stageCmdName = stageTokens[0].split("/").pop()!;
        if (FORWARDING_COMMANDS.has(stageCmdName)) {
          if (!isForwarderStageSafe(i, stages)) {
            return { reliable: false, rawCommand, reason: "forwarding_command" };
          }
          // Exempt: current stage's downstream and all upstreams are safe.
          // Fall through to normal stage extraction.
        }
      }
    }

    // Extract targets from each stage.
    for (const stage of stages) {
      const trimmed = stage.trim();
      if (!trimmed) continue;

      // Redirects.
      extractRedirects(trimmed, targets, projectRoot);

      // Command-specific extractor or SILENT_COMMANDS.
      const tokens = tokenize(trimmed);
      if (tokens.length === 0) continue;
      const cmdName = tokens[0].split("/").pop()!;
      // COMMAND_TABLE takes precedence over SILENT_COMMANDS.
      const extractor = COMMAND_TABLE[cmdName];
      if (extractor) {
        extractor(tokens, targets, projectRoot);
      } else if (isSilentCommand(cmdName, tokens.slice(1))) {
        // Silent: 0 target, no unreliable flag.
      }
      // Otherwise: unknown command, 0 target (D6).
    }
  }

  return { reliable: true, targets };
}
