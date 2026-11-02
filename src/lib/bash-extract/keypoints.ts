//
// Bash grant keypoints derivation (bash-grant-keypoints change).
// Pure module — no IO / no side effects.
//
// The bash grant key is derived from "command keypoints" instead of the
// whole raw command. A keypoint keeps only the tokens that determine
// "which files are accessed and what action" — it drops tokens that
// provably do NOT change the access set or action (pure-read flags, fd
// redirects, text command args, plain text). Two commands with the same
// keypoints access the same files with the same actions, so granting one
// safely covers the other (same access set + same action → auto-allow).
//
// Equivalence class = same access set + same action (narrow boundary).
// Tokens that decide the access set / action are ALWAYS kept:
//   - command name (CMD:)
//   - path positionals (PATH:, resolved against tracked cwd)
//   - write-redirect targets (WRITE:)
//   - write/uncertain flags (FLAG: + FLAGVAL:)
//   - shell-glob positionals (GLOB:, NOT find internal-match flag values)
//   - bare words (WORD:, conservative keep)
//   - cd landing (cd:, tracked cwd; $VAR → cd-var: downgrade)
//
// Explicit boundary (aligns with security-boundary-docs Non-Goal "不做完整
// shell 解析"): NO grammar-level equivalence. `bash -c "git status"` and
// `cd /tmp && git status` are semantic drifts (shell-forwarder / cwd) and
// are NOT equivalent to `git status`.

import { toAbsolutePath, normalizeBashCommand } from "../path-utils.ts";
import {
  splitCommands,
  splitPipelines,
  tokenize,
  looksLikePath,
} from "./parse.ts";

// -------- Pure-read flag whitelists (finite, design.md Decision 3) --------
//
// A pure-read flag does NOT change the access set or the action. Its value
// is a filter parameter (`-type f`, `-name '*.ts'`) — but whether the value
// is consumed by the flag matters:
//
//   - VALUE flags: the flag takes a value that is a filter parameter. The
//     value (even with a glob, e.g. find `-name '*.ts'` internal match)
//     does NOT change the access set — skip flag name + value.
//   - BOOL flags: the flag is a switch with NO value. The next token is a
//     POSITIONAL (path arg), which DOES decide the access set — skip only
//     the flag name, never consume the next token. Otherwise `cat -n *.ts`
//     would eat `*.ts` as `-n`'s value and wrongly equate `cat -n *.go`.
//
// This is the critical distinction: find `-name '*.ts'` (value flag, skip
// value) vs `cat *.ts` (positional glob, keep GLOB:) — two different `*.ts`
// semantics that MUST NOT be conflated.
//
// Flags OUTSIDE the whitelist (write flags like -delete, uncertain flags
// like sed -n) are kept as FLAG: + FLAGVAL: (conservative keep → prompt,
// never silently allow).

interface PureReadFlags {
  /** value-taking flags: skip flag name + its value. */
  value: Set<string>;
  /** boolean flags: skip flag name only, never the next token. */
  bool: Set<string>;
}

const FIND_FLAGS: PureReadFlags = {
  // value flags (filter parameter, value never changes access set)
  value: new Set([
    "type", "name", "iname", "path", "ipath", "size", "mtime", "mmin",
    "newer", "regex", "iregex", "xtype", "maxdepth", "mindepth", "inum",
    "links", "perm", "user", "group",
  ]),
  // boolean flags (switch, no value; next token is a positional)
  bool: new Set([
    "L", "H", "P", "depth", "daystart", "empty", "false", "true",
    "print", "printf", "fprint", "fprint0", "not", "nouser", "nogroup",
    "readable", "writable", "executable",
  ]),
};

const HEAD_TAIL_FLAGS: PureReadFlags = {
  value: new Set(["n", "c"]),
  bool: new Set(["q", "v", "z"]),
};

const CAT_FLAGS: PureReadFlags = {
  value: new Set(),
  bool: new Set(["n", "b", "s", "E", "T", "A", "v"]),
};

const WC_FLAGS: PureReadFlags = {
  value: new Set(),
  bool: new Set(["l", "w", "c", "m", "L"]),
};

const LS_FLAGS: PureReadFlags = {
  value: new Set(["time", "sort", "format", "color"]),
  bool: new Set([
    "l", "a", "la", "al", "h", "lh", "lah", "1", "S", "t", "r", "R", "d",
    "i", "F", "G", "n", "u", "c", "f", "g", "q", "A", "C", "B",
    "full-time", "one-per-line", "recursive", "reverse", "directory",
    "almost-all", "human-readable",
  ]),
};

// command → pure-read flag classification. "text" means every positional
// arg is plain text (no file access unless a write redirect, handled
// separately). Commands not listed have NO whitelist — every flag is kept.
const CMD_READ_FLAGS: Record<string, PureReadFlags | "text"> = {
  find: FIND_FLAGS,
  head: HEAD_TAIL_FLAGS,
  tail: HEAD_TAIL_FLAGS,
  cat: CAT_FLAGS,
  wc: WC_FLAGS,
  ls: LS_FLAGS,
  echo: "text",
  printf: "text",
  true: "text",
  false: "text",
  pwd: "text",
  cd: "text",
  // test / [ are NOT pure-text commands — testExtract (extractors.ts:130)
  // extracts -e/-f/... path args as read targets (stat files). Keeping them
  // as "text" would drop path positionals (keypoints.ts:285-288) and wrongly
  // equate `test -e src/*.ts` with `test -e src/*.go`. No whitelist → every
  // flag and positional is conservatively kept (FLAG/FLAGVAL/PATH).
  dirname: "text",
  basename: "text",
};

// -------- Token classification helpers --------

/** fd redirect: `2>&1`, `N>&-`, `2>/dev/null`, `N>/dev` — no file target. */
function isFdRedirect(t: string): boolean {
  if (t === "2>&1" || t === ">&" || t === "&>") return true;
  if (/^[0-9]+>&/.test(t)) return true;
  if (/^[0-9]*>\/dev/.test(t)) return true;
  return false;
}

/** write redirect operator: `>`, `>>`, `2>`, `2>>`, `N>`, `N>>`. */
function isWriteRedirectOp(t: string): boolean {
  if (t === ">" || t === ">>" || t === "2>" || t === "2>>") return true;
  if (/^[0-9]+>$/.test(t) || /^[0-9]+>>$/.test(t)) return true;
  return false;
}

/** shell glob metacharacter. */
function hasGlob(t: string): boolean {
  return /[*?[]/.test(t);
}

/** numeric flag value (head -50). */
function isNumericArg(t: string): boolean {
  return /^-?[0-9]+$/.test(t);
}

/** split a flag token into its name (dash-stripped, `=`-split). */
function flagName(t: string): string {
  return t.replace(/^-+/, "").split("=")[0];
}

/**
 * Derive the command keypoints (normalized string) for a bash command.
 *
 * Two commands with equal keypoints access the same files with the same
 * actions — granting one auto-allows the other (same access set + same
 * action). This is the grant-key derivation basis (trust.ts keypointsHash).
 */
export function bashCommandKeypoints(rawCommand: string, projectRoot: string): string {
  const normalized = normalizeBashCommand(rawCommand);
  const fragments = splitCommands(normalized)
    .map((f) => f.trim())
    .filter(Boolean);

  const out: string[] = [];
  let cwd = projectRoot;

  for (const frag of fragments) {
    const stages = splitPipelines(frag)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stage of stages) {
      const tokens = tokenize(stage);
      if (tokens.length === 0) continue;
      const base = tokens[0].split("/").pop()!;

      // cd command: track landing, record cd:<abs> or cd-var:<raw>.
      if (base === "cd") {
        // Skip cd flags (-P / -L are legal bash usage; the landing is the
        // following path token, not the flag). `cd -` (previous dir) has no
        // statically-resolvable landing → conservative cd-var.
        let idx = 1;
        while (idx < tokens.length && tokens[idx].startsWith("-")) {
          idx += 1;
        }
        const target = tokens[idx] ?? "";
        if (target && !target.includes("$")) {
          // ~ and relative paths are statically resolvable via
          // toAbsolutePath (path-utils.ts:35-57) — record cd:<abs>. The
          // relative target resolves against the TRACKED cwd (design.md
          // Decision 2 "相对路径按追踪 cwd 解析"), NOT projectRoot — a
          // second `cd src` after `cd /a` lands in /a/src, not ROOT/src.
          const abs = toAbsolutePath(target, cwd);
          out.push(`cd:${abs}`);
          cwd = abs;
          continue;
        }
        // $VAR (unresolved) → cd-var:<raw>, no cwd update. Empty/flag-only
        // target (bare `cd`, `cd -P`) is conservative: cd-var:<raw>.
        out.push(`cd-var:${target}`);
        continue;
      }

      out.push(`CMD:${base}`);
      const spec = CMD_READ_FLAGS[base];
      const rest = tokens.slice(1);

      let i = 0;
      while (i < rest.length) {
        const t = rest[i];

        // fd redirect → skip (no file target).
        if (isFdRedirect(t)) {
          i += 1;
          continue;
        }

        // write redirect operator → record target (WRITE:<abs>).
        if (isWriteRedirectOp(t)) {
          const target = rest[i + 1];
          if (target && !target.startsWith("-") && !isFdRedirect(target)) {
            out.push(`WRITE:${toAbsolutePath(target, cwd)}`);
            i += 2;
            continue;
          }
          out.push(`REDIR:${t}`);
          i += 1;
          continue;
        }

        // flag token.
        if (t.startsWith("-")) {
          if (isNumericArg(t)) {
            i += 1; // head/tail -N numeric arg → skip.
            continue;
          }
          const flag = flagName(t);
          if (spec === "text") {
            i += 1; // text-command flags ignored.
            continue;
          }
          if (spec && spec.value && spec.value.has(flag)) {
            // value flag: skip name + value (value is a filter parameter,
            // never changes access set; even a glob is find internal match).
            const inline = t.includes("=");
            i += 1;
            if (!inline && i < rest.length) {
              const v = rest[i];
              if (
                !v.startsWith("-") &&
                !isWriteRedirectOp(v) &&
                !isFdRedirect(v)
              ) {
                i += 1;
              }
            }
            continue;
          }
          if (spec && spec.bool && spec.bool.has(flag)) {
            // boolean flag: skip name only, NEVER the next token (it is a
            // positional that decides the access set).
            i += 1;
            continue;
          }
          // write/uncertain flag → keep name + value.
          out.push(`FLAG:${flag}`);
          i += 1;
          if (i < rest.length) {
            const v = rest[i];
            if (
              !v.startsWith("-") &&
              !hasGlob(v) &&
              !isFdRedirect(v) &&
              !isWriteRedirectOp(v)
            ) {
              out.push(`FLAGVAL:${v}`);
              i += 1;
            }
          }
          continue;
        }

        // non-flag positional.
        if (spec === "text") {
          i += 1; // text arg ignored.
          continue;
        }
        if (hasGlob(t)) {
          out.push(`GLOB:${t}`); // shell glob → keep (decides access set).
          i += 1;
          continue;
        }
        if (looksLikePath(t)) {
          out.push(`PATH:${toAbsolutePath(t, cwd)}`);
          i += 1;
          continue;
        }
        out.push(`WORD:${t}`); // bare word → conservative keep.
        i += 1;
      }
    }
  }

  return out.join(" | ");
}
