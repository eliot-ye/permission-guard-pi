//
// Path utilities. Pure functions - no IO side effects, no pi imports.
// This module is a foundation for config, decision, trust, and bash-extract.
//
// Responsibilities:
//   - expandHome:       resolve leading `~` against $HOME
//   - toAbsolutePath:   resolve to an absolute path (with `..` handling)
//   - toKeyPath:        produce a case-insensitive key form (Windows-safe)
//   - matchesGlob:      glob pattern matching with ** / * / ? / [...]
//   - isInside:         determine if a path is inside another root
//   - tryRealpath:      attempt to resolve symlinks, fall back to input
//   - hashProject:      stable 12-hex-char hash of a project root
//   - prettyPath:       human-friendly path (home-prefixed with ~)
//

import { realpath } from "node:fs/promises";
import { resolve as nodeResolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// -------- expandHome --------

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) {
    const home = homedir();
    // Normalize separators: always use forward slashes internally.
    return home + p.slice(1);
  }
  return p;
}

// -------- toAbsolutePath --------

export function toAbsolutePath(p: string, projectRoot: string): string {
  // 1. Expand ~ first.
  const expanded = expandHome(p);
  // 2. Normalize separators to forward slashes.
  const normalized = expanded.replace(/\\/g, "/");

  // 3. If already absolute (unix or windows drive), keep as-is.
  const isUnixAbs = normalized.startsWith("/");
  const isWinAbs = /^[A-Za-z]:\//.test(normalized);

  if (isUnixAbs || isWinAbs) {
    // For unix absolute paths, still resolve . and .. segments so that
    // /a/./b becomes /a/b. Use resolve("/", normalized) which keeps it absolute.
    if (isUnixAbs) {
      return nodeResolve(normalized).replace(/\\/g, "/");
    }
    return normalized;
  }

  // 4. Otherwise resolve relative to projectRoot.
  const root = projectRoot.replace(/\\/g, "/");
  return nodeResolve(root, normalized).replace(/\\/g, "/");
}

// -------- toKeyPath --------

// Produce a key form suitable for hashing and case-insensitive comparison.
// - Normalizes separators to forward slashes.
// - For paths that look like Windows drive-letter paths, lowercase the entire
//   string (Windows filesystems are case-insensitive).
// - POSIX paths keep their case (case-sensitive filesystems).
export function toKeyPath(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

// -------- matchesGlob --------

// Convert a glob pattern into a RegExp. Semantics:
//   **     matches any number of path segments (including zero, but requires
//          at least a separator or end).
//   *      matches within one path segment (no /).
//   ?      matches exactly one char within a segment.
//   [...]  character class.
// Anything else is treated literally (regex metachars escaped).
//
// Note: matchesGlob compares against a relative path (no leading /). Both
// absolute patterns and relative patterns can be passed - the function treats
// input as-is.
export function matchesGlob(pattern: string, candidate: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(candidate);
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let out = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];

    // Double-star handling: must be a complete segment (or preceded/followed by /).
    if (ch === "*" && normalized[i + 1] === "*") {
      // Consume **
      i += 2;
      // If followed by /, the ** matches zero or more full segments including separator.
      if (normalized[i] === "/") {
        i += 1;
        // **/ matches any number of complete segments (including zero segments)
        out += "(?:.*/)?";
      } else {
        // ** at end matches anything remaining
        out += ".*";
      }
      continue;
    }

    if (ch === "*") {
      // Single-star: match any chars within one segment (no /).
      out += "[^/]*";
      i += 1;
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    if (ch === "[") {
      // Character class: find matching ].
      const end = normalized.indexOf("]", i);
      if (end === -1) {
        out += "\\[";
        i += 1;
        continue;
      }
      const inner = normalized.slice(i + 1, end);
      // Escape ] and regex metachars within class, but keep ranges and negation.
      out += "[" + inner.replace(/\\/g, "\\\\") + "]";
      i = end + 1;
      continue;
    }

    // Escape regex metachars in literal chars.
    if (/[.+^${}()|\\]/.test(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

// -------- isInside --------

// Determine whether candidatePath is under rootPath (both must be absolute
// and normalized).
export function isInside(candidatePath: string, rootPath: string): boolean {
  const cand = candidatePath.replace(/\\/g, "/");
  const root = rootPath.replace(/\\/g, "/");

  if (cand === root) return true;

  const rootWithSep = root.endsWith("/") ? root : root + "/";
  return cand.startsWith(rootWithSep);
}

// -------- tryRealpath --------

// Attempt to resolve symlinks. On any failure return the input unchanged.
export async function tryRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

// -------- hashProject --------

// Stable 12-hex-char hash of a project root. Case-insensitive on Windows-style
// paths. Same for the same logical root across case variations and symlink-free
// normalization.
export function hashProject(projectRoot: string): string {
  const normalized = projectRoot.replace(/\\/g, "/");
  // Lowercase for cross-platform stability (Windows is case-insensitive; POSIX
  // is case-sensitive but we still get stability by lowercasing - this is a
  // trade-off documented in design.md D10).
  const lower = normalized.toLowerCase();
  const hash = createHash("sha256").update(lower).digest("hex");
  return hash.slice(0, 12);
}

// -------- prettyPath --------

// Human-friendly display: replace home prefix with ~.
export function prettyPath(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const home = homedir().replace(/\\/g, "/");
  if (normalized === home) return "~";
  if (normalized.startsWith(home + "/")) {
    return "~" + normalized.slice(home.length);
  }
  return normalized;
}

// -------- Bash command equivalence (P1, e2) --------
//
// Single source of truth for bash-command grant keys. Both the grant channel
// (trust.ts bashKey) and the audit channel (audit.ts truncateCommand commandHash)
// MUST use the same key derivation, or an auditor can't match a truncated audit
// record to the grant that authorized it (B5 contract).
//
// Equivalence semantic (settled in P1 design): whitespace normalization only.
//   - `git  status` (double space) === `git status`
//   - `  git status  ` (padding) === `git status`
//   - `git status` !== `git status --short` (args differ → different command)
//
// Explicit boundary (aligns with security-boundary-docs Non-Goal "不做完整
// shell 解析"): NO grammar-level equivalence. We do NOT treat
//   `bash -c "git status"` === `git status` (shell-forwarder semantic drift)
//   `cd /tmp && git status` === `git status` (cwd drift)
// as equivalent — those are semantic drifts that would wrongly auto-allow. Only
// lexical whitespace collapsing is safe.

export function normalizeBashCommand(rawCommand: string): string {
  return rawCommand.replace(/\s+/g, " ").trim();
}

// sha256 of the NORMALIZED command. Stable identity for the grant key.
export function bashCommandHash(rawCommand: string): string {
  return createHash("sha256").update(normalizeBashCommand(rawCommand)).digest("hex");
}
