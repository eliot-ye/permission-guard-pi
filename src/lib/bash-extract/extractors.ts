// Bash extraction: COMMAND_TABLE + 16 command-specific target extractors.
// Pure module — no IO / no side effects.

import { toAbsolutePath, expandHome } from "../path-utils.ts";

import { looksLikePath } from "./parse.ts";
import type { ExtractAction } from "./parse.ts";

export type Extractor = (tokens: string[], targets: Array<{ action: ExtractAction; path: string }>, projectRoot: string) => void;

/**
 * find 的「值不是文件路径」flag 集合（共享常量，单一事实源）。
 *
 * 这些 flag 的下一个 token 是查询条件（`-type f` 的 `f`、`-maxdepth 2` 的
 * `2`、`-name '*.ts'` 的 `*.ts`、`-size +1M` 的 `+1M`），不是文件路径引用。
 * `collectStagePathRefs`（决策侧）与 `readExtract`（提取侧）MUST 复用本集合
 * 跳过这些值——收集它们会误判为「不可提取裸词」（`looksLikePath("f")`=false）
 * 而排除 cd 跟踪豁免，导致 `cd /abs && find /abs/src -type f` 误报 `cd_chdir`。
 *
 * 刻意**不含**「值是路径引用」的 flag：`-newer`/`-newerat`/`-newerct`/
 * `-samefile`/`-fprint`/`-fprintf`（第一个值是文件引用，真实落点依赖 cwd，
 * 必须保持收集供条件 9 排除，fail-closed）——只跳过值确定非路径的 flag。
 */
export const FIND_NONPATH_FLAG_ARGS = new Set([
  "-type", "-name", "-iname", "-path", "-ipath",
  "-regex", "-iregex",
  "-maxdepth", "-mindepth",
  "-size", "-mtime", "-atime", "-ctime", "-amin", "-cmin", "-mmin",
  "-user", "-group", "-perm", "-inum", "-links",
  "-printf", "-fstype",
  "-newermt",
]);

/**
 * read-only 文件参数命令集合（共享常量，单一事实源）。
 *
 * 这些命令在 COMMAND_TABLE 注册 `readExtract`（或 `findExtract` = `readExtract`），
 * extractor 可消费 `resolveBase` 把裸词目录提取为 read target。cd 跟踪豁免
 * （D2a）适用时，这些命令的裸词目录位置参数（`src`、`dist/`、`node_modules/...`）
 * 不再被条件 9「不可提取裸词排除」排除，改经 `resolveBase` 解析为绝对 read target。
 *
 * 刻意**不含** write/delete 命令（`rm`/`mkdir`/`mv`/`cp`/`touch`/`chmod` 等）
 * 与无 extractor 命令（`sort`/`tar`/`cmp` 等）——write 裸词无法安全提取（若放行
 * 会 0-target 静默放行写），无 extractor 裸词无法消费 `resolveBase`（条件 10
 * 排除），均维持 `cd_chdir`（fail-closed）。
 *
 * 谓词 `canExtractBareDir(cmdBase)` = `BARE_DIR_EXTRACTABLE.has(cmdBase)`。
 * 决策侧（shell-forwarder 条件 9 收窄）与提取侧（entry.ts bareDirOk 传递）MUST
 * 复用本集合，避免两处判「可提取」/「不可提取」分歧导致 0-target 静默放行。
 */
export const BARE_DIR_EXTRACTABLE = new Set([
  "cat", "head", "tail", "wc", "grep", "ls", "find", "tree", "stat", "du",
  "df", "file", "less", "more",
]);

/**
 * 谓词：命令是否可把裸词目录提取为 read target（D2a 下消费 `resolveBase`）。
 * 单一事实源——决策侧（条件 9 收窄）与提取侧（entry.ts bareDirOk）共同引用。
 */
export function canExtractBareDir(cmdBase: string): boolean {
  return BARE_DIR_EXTRACTABLE.has(cmdBase);
}

/**
 * grep 的 PATTERN 参数不是路径引用（共享，单一事实源）：跳过第一个非 flag
 * 位置参数（或 -e/-f 指定的 pattern 值），只把其余位置参数当作文件引用。
 * 决策侧（collectStagePathRefs）与提取侧（readExtract.bareDirOk）复用——
 * 避免提取侧把 grep 的 PATTERN（`grep foo bar` 的 `foo`）当裸词目录 push。
 */
export function grepPatternSkipIdx(tokens: string[]): Set<number> {
  const skip = new Set<number>();
  let i = 1;
  let sawNonOpt = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-e" || t === "-f") {
      // `-e`/`-f` 已显式提供 pattern（其值跳过），后续非 flag token 是文件
      // 引用而非第一个 PATTERN——置 sawNonOpt=true 防止误跳过真实文件
      // （`grep -e pattern sub` 的 `sub` 必须收集供条件 9 / bareDirOk 提取）。
      if (i + 1 < tokens.length) skip.add(i + 1);
      sawNonOpt = true;
      i += 2;
      continue;
    }
    if ((t.startsWith("-e") && t.length > 2) || (t.startsWith("-f") && t.length > 2)) {
      // 内联 `-epattern`/`-fpattern` 同样已提供 pattern。
      sawNonOpt = true;
      i += 1;
      continue;
    }
    if (t.startsWith("-")) { i += 1; continue; }
    if (!sawNonOpt) { skip.add(i); sawNonOpt = true; }
    i += 1;
  }
  return skip;
}

// Extract target paths from `mv` (2 args: src, dst).

export const mvExtract: Extractor = (tokens, targets, root) => {
  // `mv [flags] src dst`
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length >= 2) {
    const [src, dst] = args;
    if (looksLikePath(src)) targets.push({ action: "read", path: toAbsolutePath(expandHome(src), root) });
    if (looksLikePath(dst)) targets.push({ action: "write", path: toAbsolutePath(expandHome(dst), root) });
  }
};

// Extract target paths from `cp` (2 args: src, dst).

export const cpExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length >= 2) {
    const [src, dst] = args;
    if (looksLikePath(src)) targets.push({ action: "read", path: toAbsolutePath(expandHome(src), root) });
    if (looksLikePath(dst)) targets.push({ action: "write", path: toAbsolutePath(expandHome(dst), root) });
  }
};

// Extract target paths from `rm` - all args are delete targets.

export const rmExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const a of args) {
    if (looksLikePath(a)) targets.push({ action: "delete", path: toAbsolutePath(expandHome(a), root) });
  }
};

// Extract target paths from `cat`/`head`/`tail`/`wc`/`grep` and other
// read-only directory/file enumeration commands (ls, find, tree, stat, du, df,
// file, less, more). All treated as read actions.

export const readExtract: Extractor = (tokens, targets, root) => {
  // bareDirOk 是函数签名层面的可选参（非 Extractor 类型扩展，向后兼容）：
  // cd 跟踪豁免（D2a）适用时，entry.ts 按 COMMAND_TABLE[cmd] === readExtract
  // 身份分派，传 bareDirOk=true，使裸词目录（looksLikePath=false 的 src/dist）
  // 也经 resolveBase 解析为 read target。非 cd 场景默认 false，行为不变。
  readExtractWithBareDir(tokens, targets, root, false);
};

/**
 * readExtract 的实现体 + bareDirOk 扩展。
 * 与 readExtract 同逻辑；bareDirOk=true 时，裸词目录（looksLikePath=false 的
 * 无扩展名相对目录）也经 resolveBase 解析为 read target。
 *
 * 同步跳过（与决策侧 collectStagePathRefs 一致，W1/W2 收敛）：
 *  - grep：PATTERN 参数（grepPatternSkipIdx，单一事实源）不是路径引用，不 push。
 *  - find：FIND_NONPATH_FLAG_ARGS 的值（`-type f` 的 `f` 等）不是路径引用，
 *    不 push——否则 bareDirOk 会把 `f`/`2` 当裸词目录 push（目标集污染）。
 */
export function readExtractWithBareDir(
  tokens: string[],
  targets: Array<{ action: ExtractAction; path: string }>,
  root: string,
  bareDirOk: boolean,
): void {
  const cmdBase = tokens.length > 0 ? tokens[0].split("/").pop()! : "";
  const args = tokens.slice(1);
  const grepSkip = cmdBase === "grep" ? grepPatternSkipIdx(tokens) : new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    // grep PATTERN 参数（tokens 索引 = args 索引 + 1）不是路径引用。
    if (grepSkip.has(i + 1)) continue;
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
    // find 的 flag 值（`-type f` 的 `f` 等）不是路径引用——bareDirOk 下
    // 不 push（复用 FIND_NONPATH_FLAG_ARGS，与决策侧一致）。
    if (
      cmdBase === "find" &&
      i >= 1 &&
      args[i - 1].startsWith("-") &&
      FIND_NONPATH_FLAG_ARGS.has(args[i - 1])
    ) {
      continue;
    }
    if (looksLikePath(t)) {
      targets.push({ action: "read", path: toAbsolutePath(expandHome(t), root) });
    } else if (bareDirOk && t && !t.startsWith("-") && !isRedirectTargetToken(t)) {
      // 裸词目录（src/dist/node_modules/...）：D2a 下经 resolveBase 解析为
      // read target。排除重定向形态 token（`2>/dev/null` 等，其目标已由
      // extractRedirects 提取）与 flag 值。
      targets.push({ action: "read", path: toAbsolutePath(expandHome(t), root) });
    }
  }
}

/**
 * 是否为重定向形态 token（`2>/dev/null`、`>foo`、`2>&1`、`<in`、`<<EOF` 等，
 * tokenize 不拆分这些形态）。bareDirOk 下把裸词目录 push 为 read target 前，
 * 需排除这类 token——其重定向目标已由 extractRedirects 单独提取，push 整串
 * 会把 `2>/dev/null` 当 `/cd目标/2>/dev/null` 假目标（目标集污染）。
 */
function isRedirectTargetToken(token: string): boolean {
  if (!token) return false;
  if (/^[0-9]*>&(?:[0-9]+|-)$/.test(token)) return true; // fd 复制/关闭
  if (/^[0-9]*(?:>>|>|<).+/.test(token) && !token.includes("&") && !/^[0-9]*<</.test(token)) return true;
  return false;
}

// Extract target paths from `sed` (bash-sed-readonly-exempt, D2). Only reached
// when the sed read-only exemption holds (write/exec forms are intercepted by
// entry.ts step 4a before reaching COMMAND_TABLE). Skips ALL script sources
// (each `-e`/`--expression` value, `-f`/`--file` value, and the first non-flag
// positional when neither `-e` nor `-f` is present) plus `-n`; remaining
// non-flag positionals that look like paths become read targets.
//
// Deliberately does NOT reuse `readExtract`: the sed script (e.g. `a.b`) can
// look like a path (looksLikePath("a.b") === true) and readExtract would
// mis-collect it as a read target. The script argument is not a file path and
// must be explicitly skipped.

export const sedExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1);
  const hasE = args.some((a) => a === "-e" || a === "--expression" || a.startsWith("--expression="));
  const hasF = args.some((a) => a.startsWith("-f") || a.startsWith("--file"));
  let sawScript = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "-e" || t === "--expression") { i += 1; continue; }
    if (t.startsWith("--expression=")) continue;
    if (t === "-f" || t === "--file") { i += 1; continue; }
    if (t.startsWith("--file=")) continue;
    if (t.startsWith("-")) continue; // -n and other flags
    // First non-flag positional is the script ONLY when neither `-e` nor `-f`
    // is present; otherwise it is a file operand.
    if (!hasE && !hasF && !sawScript) { sawScript = true; continue; }
    if (looksLikePath(t)) {
      targets.push({ action: "read", path: toAbsolutePath(expandHome(t), root) });
    }
  }
};

// Extract target paths from `mkdir`. Every non-flag arg is a directory
// to be created - classify as write.

export const mkdirExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const a of args) {
    if (looksLikePath(a)) targets.push({ action: "write", path: toAbsolutePath(expandHome(a), root) });
  }
};

// Extract target paths from `touch` - every non-flag arg is a file to create.

export const touchExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const a of args) {
    if (looksLikePath(a)) targets.push({ action: "write", path: toAbsolutePath(expandHome(a), root) });
  }
};

// Extract target paths from `test`/`[` - the first path arg is read (existence check).

export const testExtract: Extractor = (tokens, targets, root) => {
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

export const teeExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const a of args) {
    if (looksLikePath(a)) targets.push({ action: "write", path: toAbsolutePath(expandHome(a), root) });
  }
};

// Extract target paths from `ln -s src dst`.

export const lnExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length >= 2) {
    const [src, dst] = args;
    if (looksLikePath(dst)) targets.push({ action: "write", path: toAbsolutePath(expandHome(dst), root) });
    // src is the link target (typically a path that doesn't need to exist yet)
    if (looksLikePath(src)) targets.push({ action: "write", path: toAbsolutePath(expandHome(src), root) });
  }
};

// Extracts target paths from `chmod` / `chown`.

export const metaExtract: Extractor = (tokens, targets, root) => {
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

export const truncateExtract: Extractor = (tokens, targets, root) => {
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

export const ddExtract: Extractor = (tokens, targets, root) => {
  for (const t of tokens.slice(1)) {
    const m = t.match(/^of=(.+)$/);
    if (m && looksLikePath(m[1])) {
      targets.push({ action: "write", path: toAbsolutePath(expandHome(m[1]), root) });
    }
  }
};

// Extract target paths from `curl -o <path>` or `--output <path>`.

export const curlExtract: Extractor = (tokens, targets, root) => {
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

export const wgetExtract: Extractor = (tokens, targets, root) => {
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

export const findExtract: Extractor = readExtract;

// Extract target paths from `install`.

export const installExtract: Extractor = (tokens, targets, root) => {
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length >= 2) {
    const [src, dst] = args;
    if (looksLikePath(src)) targets.push({ action: "read", path: toAbsolutePath(expandHome(src), root) });
    if (looksLikePath(dst)) targets.push({ action: "write", path: toAbsolutePath(expandHome(dst), root) });
  }
};

// -------- Command table --------

export const COMMAND_TABLE: Record<string, Extractor> = {
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
  // sed: read-only form exemption (bash-sed-readonly-exempt). Only reached
  // when entry.ts step 4a's sed exemption holds (write/exec forms are
  // intercepted there as unreliable_command). `sedExtract` skips all script
  // sources and collects file positionals as read targets.
  sed: sedExtract,
};

// -------- Meta commands: control flow + shell forwarders --------

// Control-flow keywords make a command's runtime behavior non-statically-
// determinable (loop variables, branch conditions). Treat the whole command
// as unreliable when any of these appear as a standalone token outside quotes.
