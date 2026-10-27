// Bash extraction: quote-aware unreliable-command scanner.
// Detects constructs that make static analysis impossible.
// Pure module — no IO / no side effects.

import { isBoundedGlobSafe, isForLoopIterationGlobExempt } from "./readonly.ts";

export function parseHeredocDelimiter(
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

export const SUBSTITUTION_MAX_DEPTH = 3;

export interface SubstitutionScanResult {
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

export function scanUnreliable(cmd: string, projectRoot?: string): string | undefined {
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
