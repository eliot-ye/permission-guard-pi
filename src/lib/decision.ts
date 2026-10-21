//
// Core decision engine. Pure function - no IO, no UI, no pi runtime.
//
// Contract (post-review design.md D1, D8):
//   - decide() takes pure data inputs (policy, absPath, projectRoot, action, isInside, sensitive)
//   - decide() does NOT check grants/memory - that's the extension layer's job
//   - decide() returns a Decision discriminated union
//
// Semantics:
//   - Dual region: project_inner / project_outer
//   - Three-tier permissions: read_write / read_only / unread
//   - Prompt tiers: three (config-declared) or two (unconfigured/sensitive)
//   - Cross-source conflict: only triggers a prompt when unread is involved
//   - Default sensitive-path fallback when no config declaration exists
//

import type { MergedPolicy, MatchedEntry, Permission } from "./config.ts";
import type { SensitiveRule } from "./sensitive.ts";

export type Action = "read" | "write" | "delete";
export type Region = "project_inner" | "project_outer";
export type PromptTier = "three" | "two";

export type Declaration =
  | "read_write"
  | "read_only"
  | "unread"
  | "sensitive_default"
  | "unconfigured";

export interface DecisionCommon {
  region: Region;
  declaration: Declaration;
  configured: boolean;
  reason: string;
}

export type Decision =
  | (DecisionCommon & { kind: "auto_allow" })
  | (DecisionCommon & {
      kind: "deny_hard";
      denial: { reason: string };
    })
  | (DecisionCommon & {
      kind: "prompt";
      tier: PromptTier;
      conflict?: boolean;
    });

// -------- Main decision function --------

export function decide(opts: {
  policy: MergedPolicy;
  absPath: string;
  projectRoot: string;
  action: Action;
  isInside: boolean;
  sensitive: SensitiveRule | undefined;
}): Decision {
  const { policy, absPath, action, isInside, sensitive } = opts;
  const region: Region = isInside ? "project_inner" : "project_outer";

  // 1. If a table entry declares this path.
  const entry = policy.resolve(absPath);

  if (entry) {
    // 1a. Conflict check: unread-involved conflicts → prompt tier=three.
    if (entry.conflictInvolvesUnread) {
      return {
        kind: "prompt",
        region,
        declaration: entry.permission,
        configured: true,
        tier: "three",
        conflict: true,
        reason: `Cross-source conflict involving unread for ${absPath} (winner: ${entry.permission} from ${entry.source}, but another source declares unread)`,
      };
    }

    // 1b. unread = hard deny.
    if (entry.permission === "unread") {
      return {
        kind: "deny_hard",
        region,
        declaration: "unread",
        configured: true,
        reason: `Path is hard-denied by ${entry.source} config (${entry.raw})`,
        denial: { reason: `Path declared unread in ${entry.source} config` },
      };
    }

    // 1c. read_only: reads auto-allowed; writes/delete prompt tier=three.
    if (entry.permission === "read_only") {
      if (action === "read") {
        return {
          kind: "auto_allow",
          region,
          declaration: "read_only",
          configured: true,
          reason: `Path declared read_only in ${entry.source} config; read allowed`,
        };
      }
      return {
        kind: "prompt",
        region,
        declaration: "read_only",
        configured: true,
        tier: "three",
        reason: `Path declared read_only in ${entry.source} config; ${action} requires approval`,
      };
    }

    // 1d. read_write: inner → auto_allow; outer → prompt tier=three.
    if (entry.permission === "read_write") {
      if (isInside) {
        return {
          kind: "auto_allow",
          region: "project_inner",
          declaration: "read_write",
          configured: true,
          reason: `Path declared read_write in ${entry.source} config; in-project ${action} auto-allowed`,
        };
      }
      return {
        kind: "prompt",
        region: "project_outer",
        declaration: "read_write",
        configured: true,
        tier: "three",
        reason: `Path declared read_write in ${entry.source} config; outside-project ${action} requires approval`,
      };
    }
  }

  // 2. No table entry. Fall back to region + sensitivity defaults.
  const configured = false;

  // 2b. Sensitive-path fallback (both inner and outer, split by tier).
  //   - Inner sensitive: prompt tier=three - user gets a chance to persist
  //     authorization, since inner paths are within their own project scope.
  //   - Outer sensitive: prompt tier=two - no "Always allow", because we
  //     don't persist grants to system-sensitive paths.
  // An explicit config declaration (step 1) takes precedence over this
  // fallback - if the user declares `read_only` or `unread` for an inner
  // sensitive path, that declaration wins.
  if (sensitive) {
    return {
      kind: "prompt",
      region,
      declaration: "sensitive_default",
      configured: false,
      tier: isInside ? "three" : "two",
      reason: `Sensitive file (${sensitive.reason}): ${absPath}`,
    };
  }

  // 2c. Default writable temporary directories. Treat /tmp/** as a
  // built-in read_write default so ordinary scratch-file writes do not need a
  // manual global config entry. This intentionally runs after sensitive files
  // so a sensitive file in /tmp still prompts.
  if (action !== "read" && isDefaultTmpPath(absPath)) {
    return {
      kind: "auto_allow",
      region,
      declaration: "unconfigured",
      configured: false,
      reason: `Temporary directory default: ${absPath}`,
    };
  }

  // 2d. Unconfigured, non-sensitive. Apply region defaults.
  if (isInside) {
    // In-project: reads and writes are auto-allowed.
    return {
      kind: "auto_allow",
      region: "project_inner",
      declaration: "unconfigured",
      configured: false,
      reason: `In-project non-sensitive ${action}; auto-allowed`,
    };
  }

  // 2e. Outside-project, non-sensitive, unconfigured.
  if (action === "read") {
    return {
      kind: "auto_allow",
      region: "project_outer",
      declaration: "unconfigured",
      configured: false,
      reason: `Outside-project non-sensitive read; auto-allowed`,
    };
  }

  // 2f. Outer write/delete, unconfigured, non-sensitive → prompt tier=three.
  // Users can persist via "Always allow" because the path is not sensitive.
  // Sensitive defaults stay at tier=two (see step 2b).
  return {
    kind: "prompt",
    region: "project_outer",
    declaration: "unconfigured",
    configured: false,
    tier: "three",
    reason: `Outside-project non-sensitive ${action}; approval required`,
  };
}

function isDefaultTmpPath(absPath: string): boolean {
  const normalized = absPath.replace(/\\/g, "/");
  return normalized === "/tmp" || normalized.startsWith("/tmp/") || normalized === "/private/tmp" || normalized.startsWith("/private/tmp/");
}
