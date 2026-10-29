// Bash extraction: read-only command detection + bounded glob analysis.
// Pure module — no IO / no side effects.

import { toAbsolutePath, isInside } from "../path-utils.ts";

import { splitCommands, splitPipelines, tokenize } from "./parse.ts";
import { isForBodyReadOnly } from "./silent.ts";

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

// git 只读子命令（裸子命令名）：从 git-cmds.ts 单一事实源导入。
// 重新导出供本文件消费方（isReadOnlyWithArgs 的 git_* 折叠判定）使用。
export { GIT_READONLY_SUBCOMMANDS } from "./git-cmds.ts";

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

export function getStageCommandName(stage: string): string {
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
          // 情形 B（空 prefix 只读 glob 豁免）：glob 前缀为空（glob 在 token
          // 起始，如 `ls *.md`、`ls *`）时，命令只读（上文 isReadOnlyWithArgs
          // 已通过）即视为 cwd-relative 并 bounded 于 projectRoot——cwd ==
          // projectRoot 假设下，空 prefix glob 展开结果完全位于 projectRoot 内，
          // 且命令只读无写副作用风险。空前缀意味着 token 首个字符就是 glob
          // 元字符本身，不可能以 `/`、`~`、Windows 盘符开头，故无需重复绝对
          // 标志检查；写命令（`rm *.log`、`tar xzf *.tgz`）因 isReadOnlyWithArgs
          // 未通过而在此前已拒绝。与既有 `isForLoopIterationGlobExempt` 的
          // 空 prefix 豁免同构（窄条件豁免）。
          if (tokenGlobPrefix === "") return true;
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

export function hasDotDotSegment(prefix: string): boolean {
  // Normalize consecutive slashes so `a//../b` collapses to `a/../b`, then
  // split into segments and check whether `..` appears as a whole segment.
  // Strip leading/trailing slashes so we only look at real path segments.
  const normalized = prefix.replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return false;
  return normalized.split("/").includes("..");
}

export function isBoundedPrefix(prefix: string, projectRoot: string): boolean {
  // Empty prefix means the glob is at token start (e.g. `*` alone).
  // We conservatively reject — such a token has no path context to bind.
  if (!prefix) return false;
  if (hasDotDotSegment(prefix)) return false;
  const abs = toAbsolutePath(prefix, projectRoot);
  return isInside(abs, projectRoot);
}

export function isForLoopIterationGlobExempt(
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

  // Empty prefix: glob is the entire iteration word (e.g. `*.log`, `*`).
  // Under the cwd == projectRoot assumption, the shell expands such a glob
  // inside projectRoot, so it is bounded-safe. Absolute and home paths
  // (e.g. `/etc/*.conf`, `~/*.conf`, `C:/*.conf`) have non-empty prefixes
  // (tokenStart < globPos) and are rejected by isBoundedPrefix below — they
  // never reach this branch.
  if (!prefix) return true;

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
