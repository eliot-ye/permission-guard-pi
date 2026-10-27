// Bash extraction: control-flow keywords + for-loop exemptions + find write-flag.
// Pure module — no IO / no side effects.

import { splitCommands, tokenize } from "./parse.ts";
import { isBoundedPrefix, isFindReadOnly, isReadOnlyWithArgs } from "./readonly.ts";
import { HARMLESS_BUILTINS, isForBodyReadOnly } from "./silent.ts";
import { isSilentCommand } from "./silent.ts";

export function scanFindWriteFlags(cmd: string): string | undefined {
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

export const CONTROL_FLOW_KEYWORDS = new Set([
  "while", "for", "until", "if", "then", "else", "elif", "fi",
  "case", "in", "esac", "do", "done",
]);

// Quote-aware scan: returns `{ hit: true }` if any control-flow keyword
// appears as an independent token outside single/double quotes, unless the
// keyword is part of an exempted construct (currently: literal-iteration
// `for ... done`). When a `for` loop is exempted, its loop variable name is
// collected in `loopVars` so the variable-resolution pass (step 4 in
// `extractBashTargets`) treats `$VAR` as already resolved.

export function scanControlFlow(cmd: string, projectRoot?: string): {
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

export function isGlobForLoopExempt(
  cmd: string,
  pos: number,
  projectRoot: string,
): boolean {
  const info = parseGlobForLoop(cmd, pos);
  if (!info) return false;
  if (!info.iterHasGlob) return false;
  if (!info.globPrefixes.every(p => p === "" || isBoundedPrefix(p, projectRoot))) return false;
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

export function parseGlobForLoop(cmd: string, pos: number): {
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

export function isLiteralIterationWord(word: string): boolean {
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

export function isLiteralForLoop(cmd: string, pos: number): {
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
