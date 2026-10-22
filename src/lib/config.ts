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
export type RuleAction = "allow" | "deny";

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

export interface RuleEntry {
  tool: string;
  pattern: string | undefined;
  isGlob: boolean;
  action: RuleAction;
  raw: string;
  source: Source;
}

export interface RuleMatch {
  tool: string;
  pattern: string | undefined;
  action: RuleAction;
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
  rules?: Array<{ tool: string; pattern?: string; action: string }>;
}

export interface MergedPolicy {
  allEntries: PathEntry[];
  allRules: RuleEntry[];
  resolve: (absolutePath: string) => MatchedEntry | undefined;
  resolveRule: (toolName: string, toolPattern: string) => RuleMatch | undefined;
  isDeclared: (absolutePath: string) => boolean;
}

const VALID_PERMISSIONS = new Set<Permission>(["read_write", "read_only", "unread"]);
const VALID_RULE_ACTIONS = new Set<RuleAction>(["allow", "deny"]);

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
  const allRules: RuleEntry[] = [];

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

  const addRules = (raw: RawConfig, source: Source) => {
    const rules = raw.rules ?? [];
    for (const rule of rules) {
      const action = rule.action as RuleAction;
      if (!VALID_RULE_ACTIONS.has(action)) {
        warnings.push(
          `Unknown rule action '${rule.action}' for tool '${rule.tool}' in ${source} - ignored`,
        );
        continue;
      }
      const isGlob = rule.pattern ? /\*|\?|\[/.test(rule.pattern) : false;
      allRules.push({
        tool: rule.tool,
        pattern: rule.pattern,
        isGlob,
        action,
        raw: rule.tool + (rule.pattern ? `(${rule.pattern})` : ""),
        source,
      });
    }
  };

  // Add in ascending priority order (global first, local last), so later entries
  // with the same pattern can override earlier ones when we resolve.
  addEntries(globalRaw, "global");
  addEntries(projectRaw, "project");
  addEntries(localRaw, "local");

  addRules(globalRaw, "global");
  addRules(projectRaw, "project");
  addRules(localRaw, "local");

  // Normalize whitespace in a bash command for pattern matching.
  const normalizeWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();

  return {
    policy: (() => {
      const p: MergedPolicy = {
        allEntries,
        allRules,
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
        resolveRule: (toolName: string, toolPattern: string) => {
          const toolLower = toolName.toLowerCase().replace(/_/g, "");
          const patternNorm = normalizeWhitespace(toolPattern);
          const matched: RuleEntry[] = [];
          for (const rule of allRules) {
            if (rule.tool.toLowerCase().replace(/_/g, "") !== toolLower) continue;
            if (rule.pattern === undefined) {
              matched.push(rule);
              continue;
            }
            // Pattern matching: * matches any run of characters including / and space
            if (rule.isGlob) {
              // Convert glob pattern to regex: * matches anything
              const regex = new RegExp(
                "^" + rule.pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
                "s",
              );
              if (regex.test(patternNorm)) matched.push(rule);
            } else {
              if (normalizeWhitespace(rule.pattern) === patternNorm) matched.push(rule);
            }
          }
          if (matched.length === 0) return undefined;

          // Sort: deny first, then by source priority (local > project > global)
          matched.sort((a, b) => {
            // deny wins over allow
            if (a.action !== b.action) return a.action === "deny" ? -1 : 1;
            return SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
          });

          const winner = matched[0];
          return {
            tool: winner.tool,
            pattern: winner.pattern,
            action: winner.action,
            source: winner.source,
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
