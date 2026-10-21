//
// Configuration loading and merging.
//
// Config layout:
//   global:        ~/.pi/agent/permission.json
//   project:       <projectRoot>/.pi/permission.json
//   project-local: <projectRoot>/.pi/local/permission.json
//
// Priority (highest to lowest): local > project > global
//
// Config file shape:
//   { "paths": { "<path-pattern>": "read_write" | "read_only" | "unread" } }
//
// Path interpretation:
//   - Absolute paths (starting with / or ~ or C:\) match exactly (or via glob if pattern contains *).
//   - Relative paths are project-scoped globs - they only match paths inside <projectRoot>.
//
// JSONC is supported: // line comments, /* block comments */, and trailing commas.
//

import { promises as fs } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { expandHome, toAbsolutePath, toKeyPath, matchesGlob } from "./path-utils.ts";

export type Permission = "read_write" | "read_only" | "unread";
export type Source = "local" | "project" | "global";
export type Region = "project_inner" | "project_outer";

export interface PathEntry {
  pattern: string;
  // Whether this is a glob (contains *, ?, or [).
  isGlob: boolean;
  // Whether this pattern is scoped to project root (relative path).
  isRelative: boolean;
  // Original pattern as written in config (for UI display).
  raw: string;
  permission: Permission;
  source: Source;
}

export interface MatchedEntry {
  pattern: string;
  isGlob: boolean;
  isRelative: boolean;
  raw: string;
  permission: Permission;
  source: Source;
  // True if there are entries from multiple sources with DIFFERENT permissions
  // for the same path.
  conflict: boolean;
  // True if any of the conflicting permissions is 'unread'.
  conflictInvolvesUnread: boolean;
}

export interface RawConfig {
  paths?: Record<string, string>;
}

export interface MergedPolicy {
  allEntries: PathEntry[];
  resolve: (absolutePath: string) => MatchedEntry | undefined;
  isDeclared: (absolutePath: string) => boolean;
}

const VALID_PERMISSIONS = new Set<Permission>(["read_write", "read_only", "unread"]);

// -------- JSONC parsing --------

// Minimal JSONC comment stripper. Preserves strings so `//` inside a string
// value isn't treated as a comment start.
function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < input.length) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }

    // Single-line comment.
    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }

    // Multi-line comment.
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Remove trailing commas before } or ].
  return out.replace(/,\s*([\]\}])/g, "$1");
}

// Load a single JSONC config file. Missing files return empty config;
// malformed files return empty + error message (caller decides how to surface).
export async function loadConfigFile(
  filePath: string,
): Promise<{ raw: RawConfig; error?: string }> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const stripped = stripJsonComments(text);
    const parsed = JSON.parse(stripped) as RawConfig;
    return { raw: parsed };
  } catch (err: any) {
    if (err.code === "ENOENT") return { raw: {} };
    return { raw: {}, error: `${filePath}: ${err.message}` };
  }
}

// Compute all config paths relative to a project root.
export function configLocations(agentDir: string, projectRoot: string) {
  const globalConfigPath = pathResolve(agentDir, "permission.json");
  const projectConfigPath = pathResolve(projectRoot, ".pi/permission.json");
  const localConfigPath = pathResolve(projectRoot, ".pi/local/permission.json");
  return { globalConfigPath, projectConfigPath, localConfigPath };
}

// Classify a raw config entry as absolute (literal) vs relative (project glob).
function classifyPath(key: string): { isAbsolute: boolean; isGlob: boolean } {
  const isAbsolute =
    key.startsWith("/") || key.startsWith("~") || /^[A-Za-z]:[\\/]/.test(key);
  const isGlob = /\*|\?|\[/.test(key);
  return { isAbsolute, isGlob };
}

// -------- Merging --------

const SOURCE_PRIORITY: Record<Source, number> = {
  local: 3,
  project: 2,
  global: 1,
};

export function mergePolicies(
  globalRaw: RawConfig,
  projectRaw: RawConfig,
  localRaw: RawConfig,
  projectRoot: string,
): { policy: MergedPolicy; warnings: string[] } {
  const warnings: string[] = [];
  const allEntries: PathEntry[] = [];

  const addEntries = (raw: RawConfig, source: Source) => {
    const paths = raw.paths ?? {};
    for (const [key, value] of Object.entries(paths)) {
      const perm = value as Permission;
      if (!VALID_PERMISSIONS.has(perm)) {
        warnings.push(
          `Unknown permission '${value}' for '${key}' in ${source} - ignored`,
        );
        continue;
      }
      const { isAbsolute, isGlob } = classifyPath(key);
      allEntries.push({
        pattern: key,
        isGlob,
        isRelative: !isAbsolute,
        raw: key,
        permission: perm,
        source,
      });
    }
  };

  // Add in ascending priority order (global first, local last), so later entries
  // with the same pattern can override earlier ones when we resolve.
  addEntries(globalRaw, "global");
  addEntries(projectRaw, "project");
  addEntries(localRaw, "local");

  return {
    policy: (() => {
      const p: MergedPolicy = {
        allEntries,
        resolve: (absolutePath: string) => {
          const abs = toKeyPath(absolutePath);
          const matched: PathEntry[] = [];
          for (const entry of allEntries) {
            if (entry.isRelative) {
              const rootNorm = projectRoot.replace(/\\/g, "/");
              const sep_ = rootNorm.endsWith("/") ? "" : "/";
              const rootWithSep = rootNorm + sep_;
              if (!abs.startsWith(rootWithSep) && abs !== rootNorm) continue;
              const rel = abs.slice(rootWithSep.length);
              if (matchesGlob(entry.pattern, rel)) matched.push(entry);
            } else if (entry.isGlob) {
              if (matchesGlob(entry.pattern, abs)) matched.push(entry);
            } else {
              const expanded = toAbsolutePath(expandHome(entry.pattern), projectRoot);
              if (toKeyPath(expanded) === abs) matched.push(entry);
            }
          }
          if (matched.length === 0) return undefined;

          matched.sort((a, b) => {
            const pa = SOURCE_PRIORITY[a.source];
            const pb = SOURCE_PRIORITY[b.source];
            if (pa !== pb) return pb - pa;
            if (a.isGlob !== b.isGlob) return a.isGlob ? 1 : -1;
            return 0;
          });

          const winner = matched[0];
          const conflict = matched.some((m) => m.permission !== winner.permission);
          const conflictInvolvesUnread = conflict && matched.some((m) => m.permission === "unread");

          return {
            pattern: winner.pattern,
            isGlob: winner.isGlob,
            isRelative: winner.isRelative,
            raw: winner.raw,
            permission: winner.permission,
            source: winner.source,
            conflict,
            conflictInvolvesUnread,
          };
        },
        isDeclared: (absolutePath: string) => {
          return p.resolve(absolutePath) !== undefined;
        },
      };
      return p;
    })(),
    warnings,
  };
}
