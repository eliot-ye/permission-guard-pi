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
import { isDevSocketOrFd } from "./bash-extract/index.ts";
import { isDefaultTmpPath } from "./path-utils.ts";

export type Action = "read" | "write" | "delete";
export type Region = "project_inner" | "project_outer";
export type PromptTier = "three" | "two";

/**
 * Authorization provenance classification (design.md D1, D2).
 *
 * - "presumed": system-derived authorization (config rule / allow rule /
 *   grant-memory hit / region default). Produced by decide() or by the
 *   extension layer when a grant-memory lookup resolves.
 * - "by_person": real-human authorization. Currently only produced by the
 *   extension layer from promptUser() choices or from session-grant hits
 *   (whose write path is human-driven).
 *
 * The two values are the coarse-grained split; grant_source below gives
 * the fine-grained origin so audit consumers can filter on either axis
 * without parsing the `note` field.
 */
export type Authorization = "presumed" | "by_person";

/**
 * Fine-grained grant source. Redundant with `authorization` on purpose
 * (see design.md D1 "冗余但显式" rationale): `authorization` is the
 * binary filter ("was a human in the loop?"), `grant_source` answers
 * "which rule / memory entry actually fired".
 */
export type GrantSource =
  | "config_declaration"
  | "allow_rule"
  | "grant_memory"
  | "bash_grant_memory"
  | "default";

export type Declaration =
  | "read_write"
  | "read_only"
  | "unread"
  | "sensitive_default"
  | "unconfigured";

import type { DecisionReasonCode } from "./reason-codes.ts";
import type { SensitiveReasonCode } from "./reason-codes.ts";

export interface DecisionCommon {
  region: Region;
  declaration: Declaration;
  configured: boolean;
  reason: string;
  // Stable i18n code for this decision. Optional — legacy code paths may not
  // populate it. Uses DecisionReasonCode for most branches; the sensitive
  // fallback branch (step 2b) uses SensitiveReasonCode because it points at
  // the underlying sensitive rule.
  reasonCode?: DecisionReasonCode | SensitiveReasonCode;
}

export type Decision =
  | (DecisionCommon & {
      kind: "auto_allow";
      authorization: Authorization;
      grant_source: GrantSource;
    })
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
  toolName?: string;
  toolPattern?: string;
}): Decision {
  const { policy, absPath, action, isInside, sensitive, toolName, toolPattern } = opts;
  const region: Region = isInside ? "project_inner" : "project_outer";

  // 0. Deny rules check (highest priority - before any other check).
  if (toolName && toolPattern) {
    const ruleMatch = policy.resolveRule(toolName, toolPattern);
    if (ruleMatch && ruleMatch.action === "deny") {
      return {
        kind: "deny_hard",
        region,
        declaration: "unconfigured",
        configured: false,
        reason: `Denied by rule ${ruleMatch.tool}(${ruleMatch.pattern ?? "*"}) from ${ruleMatch.source}`,
        reasonCode: "rule_denied",
        denial: { reason: `Rule ${ruleMatch.tool}(${ruleMatch.pattern ?? "*"}) from ${ruleMatch.source} denies this ${toolName} call` },
      };
    }
  }

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
        reasonCode: "cross_source_unread_conflict",
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
        reasonCode: "path_unread_hard_deny",
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
          authorization: "presumed",
          grant_source: "config_declaration",
          reason: `Path declared read_only in ${entry.source} config; read allowed`,
          reasonCode: "path_read_only_read_allowed",
        };
      }
      return {
        kind: "prompt",
        region,
        declaration: "read_only",
        configured: true,
        tier: "three",
        reason: `Path declared read_only in ${entry.source} config; ${action} requires approval`,
        reasonCode: "path_read_only_action_needs_approval",
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
          authorization: "presumed",
          grant_source: "config_declaration",
          reason: `Path declared read_write in ${entry.source} config; in-project ${action} auto-allowed`,
          reasonCode: "path_read_write_inner_allowed",
        };
      }
      return {
        kind: "prompt",
        region: "project_outer",
        declaration: "read_write",
        configured: true,
        tier: "three",
        reason: `Path declared read_write in ${entry.source} config; outside-project ${action} requires approval`,
        reasonCode: "path_read_write_outside",
      };
    }
  }

  // 2. No table entry. Fall back to region + sensitivity defaults.
  const configured = false;

  // 2a-pre. Allow rules check (before dev-socket and sensitive checks).
  // Allow rules skip the prompt for non-sensitive paths. For sensitive paths,
  // we skip the allow and fall through to the sensitive check (2b) so the
  // sensitive hard floor still applies.
  if (toolName && toolPattern && !sensitive) {
    const ruleMatch = policy.resolveRule(toolName, toolPattern);
    if (ruleMatch && ruleMatch.action === "allow") {
      return {
        kind: "auto_allow",
        region,
        declaration: "unconfigured",
        configured: false,
        authorization: "presumed",
        grant_source: "allow_rule",
        reason: `Allowed by rule ${ruleMatch.tool}(${ruleMatch.pattern ?? "*"}) from ${ruleMatch.source}`,
        reasonCode: "rule_allowed",
      };
    }
  }

  // 2a. Network-exfiltration guard (bash-hardening-round-2 L4b): writes to
  // bash dev-sockets (`/dev/tcp/HOST/PORT`, `/dev/udp/HOST/PORT`) or a
  // numeric fd alias (`/dev/fd/[0-9]+`) are network-exfiltration paths.
  // They must be forced to tier=two (no "Always allow") so a subsequent
  // write to the same path cannot be persisted as a grant. READs on the
  // same paths are not blocked (unusual but not the exfil vector) and go
  // through the normal non-sensitive flow below.
  // Runs BEFORE the sensitive fallback (2b) because dev-sockets are
  // protocol channels, not files — they do not match sensitive.ts rules,
  // so ordering only matters for clarity. Explicit user config declarations
  // (step 1) still take precedence.
  if (action === "write" && isDevSocketOrFd(absPath)) {
    return {
      kind: "prompt",
      region,
      declaration: "unconfigured",
      configured: false,
      tier: "two",
      reason: `Network exfiltration path: ${absPath}`,
      reasonCode: "network_exfil_dev_socket",
    };
  }

  // 2b. Sensitive-path fallback (both inner and outer, split by level and tier).
  //   - soft sensitive (revocable credential config): tier=three regardless of
  //     region — "Always allow" persists, so the prompt stops repeating after
  //     the first approval. decide() does NOT branch on `action` here, so
  //     outer WRITE and DELETE are loosened together with read (proposal
  //     范围说明). Known boundary: a persisted soft DELETE grant cannot be
  //     recovered by rotating a token (the file is gone), unlike the read/
  //     write grants the "revocable" argument covers — accepted by design.
  //   - hard sensitive (non-revocable private key):
  //       * inner  → tier=three, user may persist since the path is inside
  //         their own project scope;
  //       * outer  → tier=two, no "Always allow" — a leaked private key cannot
  //         be recovered by rotating a token.
  // An explicit config declaration (step 1) takes precedence over this
  // fallback - if the user declares `read_only` or `unread` for an inner
  // sensitive path, that declaration wins.
  if (sensitive) {
    // Soft is revocable, so it is persistable everywhere — including delete,
    // per the accepted boundary noted above. Hard is only persistable inside
    // the user's own project scope.
    const tier: PromptTier =
      sensitive.level === "soft" ? "three" : isInside ? "three" : "two";
    return {
      kind: "prompt",
      region,
      declaration: "sensitive_default",
      configured: false,
      tier,
      reason: `Sensitive file (${sensitive.reason}): ${absPath}`,
      reasonCode: sensitive.code,
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
      authorization: "presumed",
      grant_source: "default",
      reason: `Temporary directory default: ${absPath}`,
      reasonCode: "tmp_default_allowed",
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
      authorization: "presumed",
      grant_source: "default",
      reason: `In-project non-sensitive ${action}; auto-allowed`,
      reasonCode: "in_project_default_allowed",
    };
  }

  // 2e. Outside-project, non-sensitive, unconfigured.
  if (action === "read") {
    return {
      kind: "auto_allow",
      region: "project_outer",
      declaration: "unconfigured",
      configured: false,
      authorization: "presumed",
      grant_source: "default",
      reason: `Outside-project non-sensitive read; auto-allowed`,
      reasonCode: "outside_read_default_allowed",
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
    reasonCode: "outside_write_needs_approval",
  };
}
