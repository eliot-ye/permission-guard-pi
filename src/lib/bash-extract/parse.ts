// Bash extraction: parsing primitives (tokenize, split, redirects, variables).
// Pure module — no IO / no side effects.

import { expandHome, toAbsolutePath, isInside } from "../path-utils.ts";

import { isDevSocketOrFd } from "./readonly.ts";

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

export function splitPipelines(cmd: string): string[] {
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

export const SAFE_VARS = new Set(["HOME", "PWD"]);

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

export const INERT_SPECIAL_PARAMS = new Set(["?", "!", "#", "$"]);

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

export function findUnresolvedVariable(cmd: string, loopVars: string[] = []): string | undefined {
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

export function expandSafeVariables(cmd: string, env: NodeJS.ProcessEnv): string {
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

export function splitCommands(cmd: string): string[] {
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

export function tokenize(command: string): string[] {
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

export function looksLikePath(token: string): boolean {
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

export function extractRedirects(command: string, targets: Array<{ action: ExtractAction; path: string }>, projectRoot: string) {
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
