// Bash extraction: shell forwarders (bash -c), wrappers, cd-chdir, forwarders (xargs).
// Pure module — no IO / no side effects.

import { splitCommands, splitPipelines, tokenize, looksLikePath, isAmpBackgroundSeparator } from "./parse.ts";
import { isReadOnlyWithArgs, isDevSocketOrFd } from "./readonly.ts";
import { COMMAND_TABLE } from "./extractors.ts";
import { GIT_READONLY_SUBCOMMANDS } from "./git-cmds.ts";
import { isDefaultTmpPath } from "../path-utils.ts";

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

// -------- cd chdir guard (bash-hardening-round-2 L3, refined) --------

/**
 * Determine whether a token (after quote removal) is an explicit absolute
 * path: starts with `/`, or is a Windows drive path `C:\` / `C:/`.
 * `~`, `$VAR`, relative prefixes (`./`, `../`) are NOT absolute.
 */
function isExplicitAbsolutePath(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(token);
}

/**
 * Determine whether a token is a network-socket / numeric-fd redirect target.
 * These are I/O targets whose semantics are unrelated to cwd-based path
 * resolution, so they never count as exemption evidence for a cd-chdir
 * exemption. Mirrors `isDevSocketOrFd` (absolute-path form).
 */
function isNetOrFdTarget(token: string): boolean {
  return isDevSocketOrFd(token);
}

/**
 * Check whether a downstream path reference is "statically visible": the
 * token is either an explicit absolute path, OR `looksLikePath` recognises it
 * as a path-bearing token (relative path / extension word / `./` / `../`).
 * Non-path bare words (`sub`, `sub/`, `file` without extension) are NOT
 * visible — they fall through to conservative cd_chdir.
 */
function isVisiblePathRef(token: string): boolean {
  if (isExplicitAbsolutePath(token)) return true;
  return looksLikePath(token);
}

/**
 * Check whether a token contains any unquoted glob metacharacter outside
 * quotes (unescaped `*`, `?`, `[`). Quote-aware: glob inside single/double
 * quotes is literal and does not count.
 */
function containsUnquotedGlob(token: string): boolean {
  let quote: null | "'" | '"' = null;
  let escaped = false;
  for (const ch of token) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (quote === '"') { if (ch === '"') quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "*" || ch === "?" || ch === "[") return true;
  }
  return false;
}

/**
 * Check whether a token contains a cwd-anchor path reference (`.`, `..`,
 * `./`, `../`, or a relative path segment that is exactly `.` / `..`).
 * Such references anchor to the *current* cwd, which cd-tracking changes.
 */
function containsCwdAnchor(token: string): boolean {
  // Exact `.` / `..` tokens.
  if (token === "." || token === "..") return true;
  // Starts with `./` or `../`.
  if (token.startsWith("./") || token.startsWith("../")) return true;
  // Relative path with an interior `.` / `..` segment (e.g. `a/../b`).
  const segments = token.split("/");
  return segments.includes(".") || segments.includes("..");
}

/**
 * 命令类型分类（D2a 条件 9 用）：位置参数代表文件访问路径的命令。
 * 这些命令的非 flag 位置参数是路径/文件引用，其真实落点依赖 cwd；
 * 不可提取的裸词（looksLikePath=false）必须在 D2a 下排除（维持 cd_chdir）。
 * 文本参数命令（echo/printf/true/false/pwd/cd/test/[/env 等）不在此列——
 * 其位置参数是文本，文件访问只可能来自重定向（由 redirect 扫描处理）。
 */
const FILE_ARG_COMMANDS = new Set([
  "cat", "head", "tail", "wc", "ls", "tree", "stat", "du", "df", "file",
  "less", "more", "rm", "mkdir", "rmdir", "mv", "cp", "touch", "ln",
  "chmod", "chown", "truncate", "dd", "tee", "install",
  // grep：位置参数是 PATTERN + 文件引用（PATTERN 由 grepPatternSkipIdx 跳过）。
  "grep",
  // find / git_*：位置参数可能含路径，保守纳入（flag-value / revision 裸词
  // 会保守排除——宁可弹窗不静默）。
  "find", "git_log", "git_show", "git_diff", "git_status", "git_ls-files",
  "git_branch", "git_tag", "git_remote", "git_config",
  // 无 extractor 但位置参数是文件路径的命令（6.3 收尾 review 补漏，F2）。
  // 它们在 COMMAND_TABLE 中无 extractor（非 cd 场景 0 target），但位置参数
  // 是真实文件引用——cd 链下裸词（looksLikePath=false）真实落点依赖漂移后
  // cwd，若不被 collectStagePathRefs 收集，D2a 条件 9 看不到 → 豁免成立 +
  // 0 target 静默放行（如 `cd /etc && sort sub` 静默读 /etc/sub、`cd /etc &&
  // tar xf sub` 静默解压写 /etc/sub，与 6.3/F1 修的洞同类别）。加入后其
  // 裸词位置参数（含 tar 操作标志 xf/cf、sort -o 的裸词值）被收集，条件 9
  // 排除豁免（维持 cd_chdir），绝不静默放行。排序/压缩/比较命令的合法
  // 豁免（绝对路径位置参数）仍走 D2b，不受影响。
  "sort", "tar", "cmp", "diff", "uniq", "sha256sum", "gzip", "xz",
  // F2 补漏（6.3 收尾 review subagent 判 MUST_FIX_CRITICAL 后穷尽）：coreutils
  // 校验/比较/文本命令类——位置参数是文件引用（md5sum sub 静默读 /etc/sub）。
  // 同类别命令（无 extractor + 位置参数=文件）一律加入，绝不静默放行；绝对
  // 路径位置参数仍走 D2b 豁免（防过度修复对照）。
  // 校验和类：md5sum/sha1sum/sha224sum/sha384sum/sha512sum/b2sum/cksum/sum。
  "md5sum", "sha1sum", "sha224sum", "sha384sum", "sha512sum", "b2sum",
  "cksum", "sum",
  // 文本行处理类（读文件）：tac/nl/od/comm/join/paste/cut/sdiff。
  "tac", "nl", "od", "comm", "join", "paste", "cut", "sdiff",
  // 解压/转换类（读文件）：gunzip/unxz/bzip2/bunzip2/zcat。
  "gunzip", "unxz", "bzip2", "bunzip2", "zcat",
  // 元数据类（读文件属性）：chgrp。
  "chgrp",
  // F2 补漏第二波（f2b-recheck 复核中断前提出的残留类 + 全量扫描证实，
  // 与 F2 critical 同类别同后果）。目录列举类（读，ls 变体）：
  "dir", "vdir",
  // 文本/编码处理类（读文件）：shuf/base64/basenc/expand/unexpand/fmt/fold/
  // ptx/tsort。
  "shuf", "base64", "basenc", "expand", "unexpand", "fmt", "fold",
  "ptx", "tsort",
  // 路径元数据类（读，lstat/path 解析）：pathchk/realpath/readlink；
  // pinky 的 -f flag 读文件。
  "pathchk", "realpath", "readlink", "pinky",
  // 创建/删除类（写工作树）：mktemp（模板落 cwd）/link/unlink（硬链接与
  // 删除）/mknod/mkfifo（创建特殊文件）。
  "mktemp", "link", "unlink", "mknod", "mkfifo",
  // F2 补漏第三波（final-closeout-review 判 APPROVED_WITH_CHANGES issue 1，
  // 实测 19 命令仍静默放行）。原地覆写/分割类（写）：shred（原地覆写——
  // 最高危写形态）/split（向 cwd 写 xaa/xab…）/csplit（写 xx00…）。
  "shred", "split", "csplit",
  // 压缩/解压/归档类：bzcat/xzcat（读）、lzma/lz4/zstd/bzip3（压缩写）、
  // unzip/zip（归档解压/压缩写）。
  "bzcat", "xzcat", "lzma", "lz4", "zstd", "bzip3", "unzip", "zip",
  // 校验和/比较类：shasum/sha3sum（与 *sum 族同类）、diff3（与 diff 同类）。
  "shasum", "sha3sum", "diff3",
  // 转换/格式化/补丁类：dos2unix（原地转换写）、rev/column/pr（读文件）、
  // patch（`patch file.diff` 位置参数与 stdin 重定向形态）。
  "dos2unix", "rev", "column", "pr", "patch",
  // 注意：id/uname/tty/logname/groups/seq/factor/numfmt/basename/dirname
  // 等不在此列——其位置参数是用户名/数字/字符串操作，非 cwd 文件引用。
  // pinky 虽默认按用户名查询（与 id 同类），但其 -f flag 读文件，保守纳入
  // （`cd x && pinky <user>` 会误伤弹窗——宁可弹窗不静默，有意接受该噪音）。
  // env/nice/nohup/timeout/setsid/watch/stdbuf 等命令执行器（位置参数是
  // PATH 解析的命令名，非 cwd 文件）属另一类，见 tasks.md 已知边界记录。
  // 本清单是「已知文件参数命令」的持续清点，非形式化穷尽——清单外同类
  // 命令的残留为已知边界（tasks.md 记录），spec 以排除判据为准。
]);

/**
 * curl/wget 的输出写目标 flag 表（F1 修复）。
 *
 * 这些命令的 URL 位置参数是网络路径而非文件引用（不收集），但输出写目标
 * flag 值（`-o`/`--output`/`-O`/`--output-document`）是真实文件写目标，
 * 必须收集供 D2a 条件 9 的裸词排除（否则 `cd /etc && curl -o sub url` 的
 * `sub` 不可提取、豁免成立 → reliable:true + 0 target 静默放行写 /etc/sub）。
 *
 * `withArg`：flag 后一个 token 即写目标路径；`noArg`：无参 flag（curl -O）
 * 写目标为 URL basename，未知但必然相对当前 cwd —— 用哨兵表达。
 */
const OUTPUT_FLAG_COMMANDS: Record<string, { withArg: string[]; noArg: string[] }> = {
  curl: { withArg: ["-o", "--output"], noArg: ["-O"] },
  wget: { withArg: ["-O", "--output-document"], noArg: [] },
};

// 哨兵：非绝对、非网络/fd、looksLikePath=false 的裸词，供条件 9 排除。
// 真实 shell 参数不可能含 NUL，故不会与用户输入撞名。
const OUTPUT_NOARG_SENTINEL = "\0output-noarg";

/**
 * grep 的 PATTERN 参数不是路径引用：跳过第一个非 flag 位置参数（或
 * -e/-f 指定的 pattern 值），只把其余位置参数当作文件引用。
 */
function grepPatternSkipIdx(tokens: string[]): Set<number> {
  const skip = new Set<number>();
  let i = 1;
  let sawNonOpt = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-e" || t === "-f") { if (i + 1 < tokens.length) skip.add(i + 1); i += 2; continue; }
    if ((t.startsWith("-e") && t.length > 2) || (t.startsWith("-f") && t.length > 2)) { i += 1; continue; }
    if (t.startsWith("-")) { i += 1; continue; }
    if (!sawNonOpt) { skip.add(i); sawNonOpt = true; }
    i += 1;
  }
  return skip;
}

/**
 * Collect the path-bearing tokens from a pipeline stage: positional args
 * (excluding flags and grep pattern) plus redirect targets.
 *
 * Returns the list of "path reference" tokens in the stage. Redirect targets
 * are extracted by scanning the raw stage string for redirect operators
 * (`>` / `>>` / `2>` / `2>>` / `<`), mirroring `extractRedirects` semantics.
 *
 * 注意：位置参数收集**不做** `looksLikePath` 过滤——不可提取的裸词
 * （`sub`、`sub/`、`src`）也返回，供 D2a 条件 9 排除（它们在 cd 链下真实
 * 落点依赖 cwd 但无法提取为 target，豁免会静默放行）。仅文件参数命令
 * （FILE_ARG_COMMANDS）收集位置参数；文本参数命令（echo 等）的位置参数
 * 是文本，不收集，其文件访问只来自重定向。
 */
function collectStagePathRefs(stage: string): string[] {
  const refs: string[] = [];
  const tokens = tokenize(stage);
  if (tokens.length > 0) {
    const cmdBase = tokens[0].split("/").pop()!;
    if (FILE_ARG_COMMANDS.has(cmdBase)) {
      const grepSkip = cmdBase === "grep" ? grepPatternSkipIdx(tokens) : new Set<number>();
      for (let i = 1; i < tokens.length; i++) {
        if (grepSkip.has(i)) continue;
        const t = tokens[i];
        if (t.startsWith("-")) continue;
        // tar：第一个位置参数（i===1，不带 `-`）若是纯字母操作标志（xf/cf/tf/
        // xzf/czf 等），它不是路径引用——跳过。flag 形式（`tar -xvf ...`）下
        // 操作标志以 `-` 开头已被上方跳过，第一个非 flag 位置参数是真实文件
        // （不跳过，如 `tar -xvf sub` 的 `sub` 必须收集供条件 9 排除）。仅当
        // i===1 时跳过，避免误跳过后续真实文件（`tar xf sub` 中 `sub` 是归档
        // 文件，必须收集）。`tar xf /tmp/a.tar` 的 `xf` 跳过、`/tmp/a.tar` 收集
        // → D2b 豁免成立（绝对归档），不误伤。
        if (cmdBase === "tar" && i === 1 && /^[a-zA-Z]+$/.test(t) && !isExplicitAbsolutePath(t) && !looksLikePath(t)) {
          continue;
        }
        refs.push(t);
      }
    } else if (OUTPUT_FLAG_COMMANDS[cmdBase]) {
      // F1：curl/wget 的输出写目标 flag 值是真实文件写目标，必须收集供
      // D2a 条件 9 的裸词排除（URL 位置参数是网络路径而非文件引用，不收集）。
      // 无参 flag（curl -O）写目标为 URL basename，未知但必然相对当前 cwd，
      // 用哨兵表达（非绝对、非网络/fd、looksLikePath=false → 条件 9 排除）。
      const spec = OUTPUT_FLAG_COMMANDS[cmdBase];
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (spec.withArg.includes(t)) {
          if (i + 1 < tokens.length) {
            const v = tokens[i + 1];
            if (!v.startsWith("-")) refs.push(v);
          }
          i += 1;
          continue;
        }
        // 内联 `--output=<path>`（curl）/ `--output-document=<path>`（wget）。
        const m =
          cmdBase === "curl" ? t.match(/^--output=(.+)$/) : t.match(/^--output-document=(.+)$/);
        if (m && m[1] && !m[1].startsWith("-")) {
          refs.push(m[1]);
          continue;
        }
        if (spec.noArg.includes(t)) {
          refs.push(OUTPUT_NOARG_SENTINEL);
          continue;
        }
      }
    }
  }
  // Redirect targets: scan raw string for operators.
  let i = 0;
  while (i < stage.length) {
    const ch = stage[i];
    if (ch === "<") {
      if (stage[i + 1] === "<") { i += 2; continue; } // heredoc
      i += 1;
      while (i < stage.length && /\s/.test(stage[i])) i += 1;
      let target = "";
      while (i < stage.length && !/[\s;|>&<]/.test(stage[i])) { target += stage[i]; i += 1; }
      if (target) refs.push(target);
      continue;
    }
    if (ch === "2" && stage[i + 1] === ">" && stage[i + 2] === "&") { i += 3; while (i < stage.length && /[0-9]/.test(stage[i])) i += 1; continue; }
    if (ch === "2" && stage[i + 1] === ">" && stage[i + 2] === ">") { i += 3; while (i < stage.length && /\s/.test(stage[i])) i += 1; let target = ""; while (i < stage.length && !/[\s;|>&<]/.test(stage[i])) { target += stage[i]; i += 1; } if (target) refs.push(target); continue; }
    if (ch === "2" && stage[i + 1] === ">") { i += 2; while (i < stage.length && /\s/.test(stage[i])) i += 1; let target = ""; while (i < stage.length && !/[\s;|>&<]/.test(stage[i])) { target += stage[i]; i += 1; } if (target) refs.push(target); continue; }
    if (ch === ">" && stage[i + 1] === ">") { i += 2; while (i < stage.length && /\s/.test(stage[i])) i += 1; let target = ""; while (i < stage.length && !/[\s;|>&<]/.test(stage[i])) { target += stage[i]; i += 1; } if (target) refs.push(target); continue; }
    if (ch === ">" && stage[i + 1] === "&") { i += 2; continue; }
    if (ch === ">") { i += 1; while (i < stage.length && /\s/.test(stage[i])) i += 1; let target = ""; while (i < stage.length && !/[\s;|>&<]/.test(stage[i])) { target += stage[i]; i += 1; } if (target) refs.push(target); continue; }
    i += 1;
  }
  return refs;
}

/**
 * Check whether a downstream stage has a path-bearing positional argument or
 * redirect target that is NOT an explicit absolute path (i.e. is cwd-relative
 * or otherwise cwd-dependent). Used to reject the all-absolute-downstream
 * exemption when any relative reference is present.
 */
function hasCwdRelativePathRef(stage: string): boolean {
  const refs = collectStagePathRefs(stage);
  for (const ref of refs) {
    // Network/fd targets never count as exemption evidence.
    if (isNetOrFdTarget(ref)) continue;
    if (!isExplicitAbsolutePath(ref)) return true;
  }
  return false;
}

/**
 * Check whether a downstream stage contains an explicit absolute path
 * reference (positional or redirect target) that is NOT a network/fd target.
 */
function hasExplicitAbsPathRef(stage: string): boolean {
  const refs = collectStagePathRefs(stage);
  for (const ref of refs) {
    if (isNetOrFdTarget(ref)) continue;
    if (isExplicitAbsolutePath(ref)) return true;
  }
  return false;
}

/**
 * Whether a downstream fragment's command is a git WRITE subcommand.
 *
 * git subcommand classification 单一事实源：GIT_READONLY_SUBCOMMANDS
 *（git-cmds.ts，与 SILENT_COMMANDS.git 一致）。git 子命令不在该集合即视为
 * 写子命令（rm/add/commit/checkout/clean/mv/reset/revert/stash 等），与
 * entry.ts 4b 的 `SILENT_COMMANDS[cmdName].has(t)` 语义一致——写子命令
 * 修改工作树文件（删除/覆盖），不是只读 pathspec 查询。
 *
 * git 写子命令的路径参数是「git 内部管理的 pathspec」（git 访问 .git 对象
 * 数据库 + 工作树，路径参数不直接作为 shell cwd 相对文件引用被本解析器
 * 读取），但真实落点（rm 删除的文件、checkout 覆盖的文件）仍依赖 cd 后
 * cwd。用户（总体设计部）拍板：git 写子命令在 cd 链下，cd 落点非默认
 * tmp 目录时保守排除（cd_chdir），cd 落点在默认 tmp 目录时静默放行
 * （tmp 无持久安全价值）。
 */
function isGitWriteSubcommand(stage: string): boolean {
  const tokens = tokenize(stage.trim());
  if (tokens.length === 0) return false;
  const base = tokens[0].split("/").pop()!;
  if (base !== "git") return false;
  // git 允许子命令前有 flag（如 `--no-pager`），与 getStageCommandName 一致：
  // 扫第一个非 flag token 作为子命令。
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].startsWith("-")) continue;
    return !GIT_READONLY_SUBCOMMANDS.has(tokens[i]);
  }
  return false; // 只有 git（无子命令）→ 非写子命令，不额外排除
}

/**
 * Analyze a compound command for `cd` usage and the two exemption paths.
 *
 * Returns `{ hasCd, d2a, d2b }`:
 *   - `hasCd`: any fragment's leading token (basename) is `cd`.
 *   - `d2a` (cd-tracking exemption): pure `&&` chain + all cd targets explicit
 *     absolute + cd fragments single-stage + downstream pipeline stages pass
 *     per-stage checks (no cwd-anchor refs, no unquoted glob, no network/fd
 *     redirect targets, no unextractable non-absolute refs, no
 *     `$PWD`/`$OLDPWD`, no no-extractor non-absolute positionals, no git write
 *     subcommand at a non-tmp cd landing). When true, downstream relative
 *     paths may be resolved against a tracked cwd; pipeline stages are allowed
 *     and checked per stage (condition 3 relaxed by bash-cd-chain-pipeline-exempt).
 *   - `d2b` (all-absolute-downstream exemption): every downstream stage's
 *     path refs are all explicit absolute (and at least one exists, and no
 *     network/fd target, and no relative ref).
 */
export function analyzeCd(cmd: string): { hasCd: boolean; d2a: boolean; d2b: boolean } {
  const fragments = splitCommands(cmd);
  if (fragments.length < 2) return { hasCd: false, d2a: false, d2b: false };

  const cdFragments: Array<{ frag: string; cdTarget: string }> = [];
  for (const frag of fragments) {
    const trimmed = frag.trim();
    if (!trimmed) continue;
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) continue;
    const firstBase = tokens[0].split("/").pop()!;
    if (firstBase === "cd") {
      const cdTarget = tokens[1] ?? "";
      cdFragments.push({ frag: trimmed, cdTarget });
    }
  }
  if (cdFragments.length === 0) return { hasCd: false, d2a: false, d2b: false };

  const hasCd = true;
  let d2a = true;
  let d2b = true;

  // --- D2a: cd-tracking exemption ---
  // Condition 1: pure `&&` chain (all separators between fragments are `&&`).
  {
    const pureAnd = (() => {
      let i = 0;
      let expectAnd = false;
      while (i < cmd.length) {
        const ch = cmd[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "'") { i += 1; while (i < cmd.length && cmd[i] !== "'") i += 1; i += 1; continue; }
        if (ch === '"') { i += 1; while (i < cmd.length && cmd[i] !== '"') i += 1; i += 1; continue; }
        if (cmd.startsWith("&&", i)) { i += 2; expectAnd = false; continue; }
        if (cmd.startsWith("||", i)) { return false; }
        // 复用 parse.ts 的 & 分隔符判定——`2>&1`（fd-dup）/`N>&-`（fd-close）/
        // `&>`/`& >` 的 `&` 是重定向操作符，不是后台分隔符，不构成非纯 `&&` 链
        // 的证据（spec 条件 1 要求复用 splitCommands 的 quote-aware 扫描）。
        if (ch === "&") {
          if (isAmpBackgroundSeparator(cmd, i)) { return false; }
          i += 1;
          continue;
        }
        if (ch === ";" || ch === "\n") return false;
        i += 1;
      }
      return !expectAnd;
    })();
    if (!pureAnd) d2a = false;
  }

  // Condition 2: all cd targets explicit absolute (no `~`, `$`, glob, relative).
  if (d2a) {
    for (const cd of cdFragments) {
      const t = cd.cdTarget;
      if (!t || !isExplicitAbsolutePath(t)) { d2a = false; break; }
      if (t.includes("~") || t.includes("$")) { d2a = false; break; }
      if (containsUnquotedGlob(t)) { d2a = false; break; }
      if (t.startsWith("./") || t.startsWith("../")) { d2a = false; break; }
    }
  }

  // Condition 3: cd fragments must themselves be single-stage. Downstream
  // fragments MAY contain pipelines: each pipeline stage inherits the post-cd
  // cwd, so its path semantics are identical to a downstream fragment, and the
  // per-stage checks in conditions 4-11 below apply to every stage. A cd
  // fragment with its own pipeline (`cd a | b`) is not statically
  // determinable and stays rejected. 放宽理由（bash-cd-chain-pipeline-exempt）：
  // 原「无管道」一刀切对 `cd <abs> && npm test 2>&1 | tail -25` 这类零路径
  // 引用纯 stdin 管道误弹 cd_chdir，与无管道等价命令（静默放行）不等价；
  // 管道 stage 逐项走条件 4~11 检查后无安全增量。
  if (d2a) {
    for (const cd of cdFragments) {
      if (splitPipelines(cd.frag).length !== 1) { d2a = false; break; }
    }
  }

  // Determine downstream stages (pipeline stages of fragments AFTER a cd
  // fragment). 条件 3 放宽后下游片段允许管道——每个 pipeline stage 继承
  // cd 后 cwd，路径语义与下游片段一致，故展平为 stage 粒度作为条件 4~11
  // 与 D2b 的判定单元（fragment 全文喂入会把 `|` 后内容超范围当路径引用，
  // stage 级为准更精确）。
  const downstreamStages: string[] = [];
  {
    let cdSeen = false;
    for (const frag of fragments) {
      const trimmed = frag.trim();
      if (!trimmed) continue;
      const tokens = tokenize(trimmed);
      if (tokens.length === 0) continue;
      const firstBase = tokens[0].split("/").pop()!;
      if (firstBase === "cd") { cdSeen = true; continue; }
      if (cdSeen) {
        for (const st of splitPipelines(trimmed)) {
          const stTrimmed = st.trim();
          if (stTrimmed) downstreamStages.push(stTrimmed);
        }
      }
    }
  }

  // Condition 4 (D2a): no cwd-anchor path refs in downstream stages.
  // Condition 5 (D2a): no unquoted glob in downstream stages.
  // Condition 6 (D2a): no network/fd redirect targets in downstream stages.
  // Condition 8 (D2a): no `$PWD` / `$OLDPWD` in downstream stages.
  // Condition 9 (D2a): no unextractable non-absolute path reference. A bare
  // word (e.g. `sub`, `sub/`, `src`) that `looksLikePath` rejects is NOT
  // extracted as a target, yet its real location depends on the tracked cwd
  // (`cd /etc && echo x > sub` really writes `/etc/sub`). If the exemption
  // applied, the command would be `reliable:true` with 0 targets — silently
  // allowing the access. So any non-absolute, non-network/fd ref that is not
  // `looksLikePath`-extractable rejects the exemption (falls back to cd_chdir).
  // This covers both positional args (`cat sub`) and redirect targets
  // (`echo x > sub`), fixing the critical gap where condition 7 only checked
  // write/delete positional args.
  if (d2a) {
    for (const stage of downstreamStages) {
      const refs = collectStagePathRefs(stage);
      for (const ref of refs) {
        if (containsCwdAnchor(ref)) { d2a = false; break; }
        if (containsUnquotedGlob(ref)) { d2a = false; break; }
        if (isNetOrFdTarget(ref)) { d2a = false; break; }
        // 条件 9：非绝对 + 非网络/fd + 不可提取裸词 → 排除。
        if (!isExplicitAbsolutePath(ref) && !isNetOrFdTarget(ref) && !looksLikePath(ref)) { d2a = false; break; }
      }
      if (stage.includes("$PWD") || stage.includes("$OLDPWD")) { d2a = false; break; }
      // Also scan whole raw stage for unquoted glob (not just path refs).
      if (containsUnquotedGlob(stage)) { d2a = false; break; }
      // Also scan for any cwd anchor in raw stage text (e.g. `rm -rf .`).
      if (containsCwdAnchor(stage)) { d2a = false; break; }
    }
  }

  // Condition 7 (D2a): write/delete commands must have all positionals either
  // absolute or looksLikePath-extractable. Reject unextractable relative args.
  if (d2a) {
    const WRITE_DELETE = new Set(["rm", "mkdir", "rmdir", "mv", "cp", "touch", "ln", "chmod", "chown", "truncate", "dd", "tee", "install"]);
    for (const stage of downstreamStages) {
      const tokens = tokenize(stage);
      if (tokens.length === 0) continue;
      const cmdBase = tokens[0].split("/").pop()!;
      if (WRITE_DELETE.has(cmdBase)) {
        for (let i = 1; i < tokens.length; i++) {
          const t = tokens[i];
          if (t.startsWith("-")) continue;
          // Skip flag values (approximate: flag followed by a non-flag token).
          if (/^-[a-zA-Z]/.test(t) && i + 1 < tokens.length && !tokens[i + 1].startsWith("-") && !isVisiblePathRef(tokens[i + 1])) {
            i += 1;
            continue;
          }
          if (!isVisiblePathRef(t)) { d2a = false; break; }
        }
        if (!d2a) break;
      }
    }
  }

  // Condition 10 (D2a): no cwd-relative positional args to commands WITHOUT an
  // extractor. A command with no extractor (e.g. `sort`, `tar`, `git_log`)
  // cannot consume `resolveBase` to extract its real post-cd path — its
  // positional args are never added to `targets` (entry.ts: COMMAND_TABLE
  // miss → D6 unknown command → 0 target). If the D2a exemption applied, the
  // command would be `reliable:true` with 0 targets, silently allowing the
  // access (e.g. `cd /tmp/x && sort data.txt` really reads `/tmp/x/data.txt`
  // but extracts 0 targets). So any downstream fragment whose command has no
  // extractor AND has a non-absolute positional path reference rejects the
  // exemption (falls back to cd_chdir). Absolute-only no-extractor commands
  // (e.g. `cd /etc && sort /tmp/data.txt`) still pass D2b and are exempt.
  if (d2a) {
    for (const stage of downstreamStages) {
      const tokens = tokenize(stage);
      if (tokens.length === 0) continue;
      const cmdBase = tokens[0].split("/").pop()!;
      if (COMMAND_TABLE[cmdBase]) continue; // has extractor → resolveBase works
      // No extractor: collect its positional args (FILE_ARG_COMMANDS) and
      // reject if any is non-absolute (cwd-dependent).
      if (!FILE_ARG_COMMANDS.has(cmdBase)) continue; // text cmd (echo etc.) → no positional path refs
      const grepSkip = cmdBase === "grep" ? grepPatternSkipIdx(tokens) : new Set<number>();
      for (let i = 1; i < tokens.length; i++) {
        if (grepSkip.has(i)) continue;
        const t = tokens[i];
        if (t.startsWith("-")) continue;
        if (cmdBase === "tar" && i === 1 && /^[a-zA-Z]+$/.test(t) && !isExplicitAbsolutePath(t) && !looksLikePath(t)) {
          continue; // tar 操作标志，非路径引用
        }
        if (!isExplicitAbsolutePath(t)) { d2a = false; break; }
      }
      if (!d2a) break;
    }
  }

  // Condition 11 (D2a): git WRITE subcommands with a non-tmp cd landing.
  // 用户（总体设计部）拍板：git 只读子命令（log/show/diff/status 等，pathspec
  // 是 git 内部管理的查询条件，非 shell cwd 文件引用）静默放行正确——条件
  // 11 不排除它们；git 写子命令（rm/add/commit/checkout/clean/mv 等，修改
  // 工作树文件）在 cd 链下若 cd 最终落点不在默认 tmp 目录，则保守排除豁免
  // （回退 cd_chdir——真实删除/覆盖的文件依赖漂移后 cwd，但本解析器不把
  // git 路径参数提取为 target，豁免会 0 target 静默放行）；cd 落点在默认
  // tmp 目录（/tmp、/private/tmp、/var/tmp）时静默放行（tmp 无持久安全
  // 价值，与 decision.ts step 2c 的 tmp_default_allowed 语义一致）。
  if (d2a) {
    const lastCd = cdFragments[cdFragments.length - 1];
    const cdLanding = lastCd && lastCd.cdTarget ? lastCd.cdTarget : "";
    const cdInTmp = cdLanding !== "" && isDefaultTmpPath(cdLanding);
    if (!cdInTmp) {
      for (const stage of downstreamStages) {
        if (isGitWriteSubcommand(stage)) { d2a = false; break; }
      }
    }
  }

  // --- D2b: all-absolute-downstream exemption ---
  if (d2b) {
    let anyAbsRef = false;
    for (const stage of downstreamStages) {
      if (hasExplicitAbsPathRef(stage)) anyAbsRef = true;
      // Any relative (cwd-dependent) ref blocks the exemption.
      if (hasCwdRelativePathRef(stage)) { d2b = false; break; }
      // Any network/fd target blocks the exemption.
      const refs = collectStagePathRefs(stage);
      for (const ref of refs) {
        if (isNetOrFdTarget(ref)) { d2b = false; break; }
      }
      if (!d2b) break;
    }
    if (d2b && !anyAbsRef) d2b = false;
  }

  return { hasCd, d2a, d2b };
}

/**
 * Whether the compound command qualifies for cwd tracking (cd-tracking
 * exemption, D2a). When true, the extractor should maintain a simulated cwd
 * starting at projectRoot and update it at each absolute cd target, resolving
 * downstream relative paths against the tracked cwd.
 */
export function shouldTrackCdCwd(cmd: string): boolean {
  return analyzeCd(cmd).d2a;
}

/**
 * Scan a compound command for `cd` fragments and decide whether to fire
 * `cd_chdir`.
 *
 * Fires when:
 *   - any fragment's leading token (basename) is `cd`, AND
 *   - neither the cd-tracking exemption (D2a) nor the all-absolute-downstream
 *     exemption (D2b) applies.
 *
 * A lone `cd /etc` (no separator) has no downstream fragment and is NOT
 * flagged. Returns `"cd_chdir"` when the guard fires, otherwise `undefined`.
 */
export function scanCdChdir(cmd: string): string | undefined {
  const { hasCd, d2a, d2b } = analyzeCd(cmd);
  if (!hasCd) return undefined;
  if (d2a || d2b) return undefined;
  return "cd_chdir";
}

// -------- Main extraction --------
