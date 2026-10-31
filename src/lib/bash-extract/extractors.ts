// Bash extraction: COMMAND_TABLE + 16 command-specific target extractors.
// Pure module — no IO / no side effects.

import { toAbsolutePath, expandHome } from "../path-utils.ts";

import { looksLikePath } from "./parse.ts";
import type { ExtractAction } from "./parse.ts";

export type Extractor = (tokens: string[], targets: Array<{ action: ExtractAction; path: string }>, projectRoot: string) => void;

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
