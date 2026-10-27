//
// Default sensitive-path catalog. Pure module - no IO, no pi imports.
// Used as a fallback when the requested path is NOT declared in any
// user config. Declared paths always take precedence over this list.
//

import { dirname, basename } from "node:path";

import type { SensitiveReasonCode } from "./reason-codes.ts";

// Soft (pardonable) credential-config matching vocabulary. Hoisted to module
// scope so the 16-way basename comparison below allocates nothing per call —
// findSensitiveMatch runs on every tool call, including per target in a bash
// extraction sweep.
const SOFT_CONFIG_NAMES = ["config", "auth", "settings", "models"];
const SOFT_CONFIG_EXTS = [".json", ".toml", ".yml", ".yaml"];

export interface SensitiveRule {
  test: (absolutePath: string) => boolean;
  reason: string;
  // Stable i18n code for this rule (see reason-codes.ts SensitiveReasonCode).
  // Required — every rule declares it. UI layer looks up bundles by this code;
  // audit layer keeps using `reason` (English stable string).
  code: SensitiveReasonCode;
  // "hard"  = non-revocable credential (private key): outer stays tier=two,
  //           no "Always allow" — a leak is not recoverable by rotating a
  //           token.
  // "soft"  = revocable credential config (apikey/token): tier=three anywhere,
  //           so "Always allow" persists and stops re-prompting after the first
  //           prompt. Ordering invariant: soft rules are appended AFTER every
  //           hard rule, so findSensitiveMatch's first-match keeps hard
  //           priority on overlaps (see design.md Decision 3).
  level: "hard" | "soft";
  // Canonical representative paths for this rule (tier-contract-consistency
  // A4). Used by config.ts's checkWildcardOverrideWarning to detect when a
  // user glob pattern would cover sensitive files. Anchors are canonical
  // `~/` or absolute paths that this rule's `test` matches. Only hard rules
  // have anchors (soft rules don't trigger override warnings). Derives the
  // HARD_SENSITIVE_ANCHORS constant from this field (single source of truth
  // with DEFAULT_SENSITIVE_RULES; adding a hard rule automatically adds its
  // anchors).
  anchor?: string[];
}

export const DEFAULT_SENSITIVE_RULES: SensitiveRule[] = [
  {
    test: (p) => {
      const b = basename(p).toLowerCase();
      const d = dirname(p).toLowerCase();
      // SSH private key files — non-revocable credentials, must stay hard.
      //
      // NOTE (tier-contract-consistency A2): known_hosts and authorized_keys
      // used to be in this rule's hard bucket. They are client-side *public
      // key* files (not the private halves), so leaking them is not a
      // non-revocable credential exposure. They now match the separate soft
      // SSH public-key rule further down, which permits persistable grants.
      // `~/.ssh/config` remains here because it may reference private key
      // paths and connection options.
      return (
        b.startsWith("id_rsa") ||
        b.startsWith("id_dsa") ||
        b.startsWith("id_ecdsa") ||
        b.startsWith("id_ed25519") ||
        (b === "config" && (d.endsWith("/.ssh") || d === ".ssh"))
      );
    },
    reason: "SSH private key",
    code: "ssh_private_key",
    level: "hard",
    // Canonical representative private-key paths this rule matches. Only
    // .pem/.key extensions are covered here — the private-key-extension
    // rule (rule 2 below) covers the rest. Adding an extension-based
    // anchor here would double-count with rule 2.
    anchor: [
      "~/.ssh/id_rsa",
      "~/.ssh/id_dsa",
      "~/.ssh/id_ed25519",
      "~/.ssh/config",
    ],
  },
  {
    test: (p) => {
      const b = basename(p).toLowerCase();
      return (
        b.endsWith(".pem") ||
        b.endsWith(".key") ||
        b.endsWith(".pfx") ||
        b.endsWith(".p12") ||
        b.endsWith(".jks") ||
        b.endsWith(".kdbx") ||
        b.endsWith(".asc") ||
        b.endsWith(".gpg")
      );
    },
    reason: "Private key / certificate file",
    code: "private_key_cert",
    level: "hard",
    // Representative absolute paths for the two most common private-key
    // extensions. Other extensions (.pfx/.p12/.jks/.kdbx/.asc/.gpg) are
    // less common — this is a coverage boundary accepted in the design
    // ("私有 key 扩展名仅覆盖 2 条代表性 anchor").
    anchor: ["/etc/ssl/private/server.pem", "~/private.key"],
  },
  {
    test: (p) => {
      const b = basename(p).toLowerCase();
      const d = dirname(p).toLowerCase();
      // SSH public-key exceptions (tier-contract-consistency A2):
      // known_hosts and authorized_keys inside ~/.ssh/ are client-side
      // public-key lists, handled by the separate soft SSH public-key
      // rule further down. Without this exception they'd be classified
      // as hard here (via the .ssh credential-store-dirname match),
      // keeping them non-persistable.
      if (
        (d.endsWith("/.ssh") || d === ".ssh") &&
        (b === "known_hosts" || b === "authorized_keys")
      ) {
        return false;
      }
      if (b === ".env" || b === ".envrc") return true;
      // .env.production, .env.local etc. - but NOT .env.example
      if (b.startsWith(".env.") && b !== ".env.example") return true;
      // Common credential store directories
      if (
        d.endsWith("/.ssh") ||
        d.endsWith("/.gnupg") ||
        d.endsWith("/.aws") ||
        d.endsWith("/.kube") ||
        d.endsWith("/.docker") ||
        d.endsWith("/.netrc") ||
        d.endsWith("/.git-credentials")
      )
        return true;
      // Also handle the case where dirname is exactly one of those (root-level)
      if ([".ssh", ".gnupg", ".aws", ".kube", ".docker", ".netrc", ".git-credentials"].includes(d)) {
        return true;
      }
      return false;
    },
    reason: "Env file or credential store",
    code: "env_credential_store",
    level: "hard",
    // Representative credential-store entries. This rule covers MANY
    // basenames across many dirs; anchors list the most common patterns.
    // Coverage boundary (accepted in design): only representative files,
    // not every possible entry inside these dirs. `.ssh/*` entries are
    // excluded because rule 1 (SSH private key) already covers them and
    // we want single-source ownership of each anchor.
    anchor: [
      "/tmp/.env",
      "~/.gnupg/secring.gpg",
      "~/.aws/credentials",
      "~/.aws/config.json",
      "~/.kube/config",
      "~/.docker/config.json",
      "~/.netrc",
      "~/.git-credentials",
    ],
  },
  {
    test: (p) => {
      const b = basename(p).toLowerCase();
      return (
        b === "credentials" ||
        b === "secrets.yaml" ||
        b === "secrets.yml" ||
        b === "secrets.json" ||
        b === ".npmrc" ||
        b === ".netrc"
      );
    },
    reason: "Credential config",
    code: "credential_config",
    level: "hard",
    anchor: [
      "~/.aws/credentials",
      "~/.npmrc",
      "~/.netrc",
      "~/secrets.yaml",
      "~/secrets.json",
    ],
  },
  {
    // bash-hardening-round-2 (L4a): system credential/config files under /etc.
    // These are common Unix privilege-escalation / lateral-movement entry
    // points — leaking /etc/shadow or /etc/sudoers enables password-hash
    // extraction, sudo rule tampering, and cron-driven persistence.
    //
    // Matching is deliberately EXACT on basename + directory prefix:
    //   - /etc/shadow, /etc/sudoers, /etc/master.passwd: exact basename
    //     (the master.passwd variant is macOS's password hash file).
    //   - /etc/crontab + /etc/cron.{d,hourly,daily,weekly,monthly}/*: cron
    //     scheduling configuration. Matched via dirname prefix.
    //   - /etc/hosts.allow, /etc/hosts.deny: TCP Wrappers access-control
    //     configuration. Exact basename match.
    //
    // NOT included: /etc/passwd, /etc/hosts, /etc/hostname, /etc/group,
    // /etc/nsswitch.conf — these are public system configuration. Adding
    // them would produce noise without a security gain.
    test: (p) => {
      const b = basename(p).toLowerCase();
      const d = dirname(p).toLowerCase();
      const etcDirs = [
        "/etc/cron.d",
        "/etc/cron.hourly",
        "/etc/cron.daily",
        "/etc/cron.weekly",
        "/etc/cron.monthly",
      ];
      return (
        b === "shadow" ||
        b === "sudoers" ||
        b === "master.passwd" ||
        b === "crontab" ||
        b === "hosts.allow" ||
        b === "hosts.deny" ||
        etcDirs.some((prefix) => d === prefix || d.startsWith(prefix + "/"))
      );
    },
    reason: "System credential/config file",
    code: "system_credential_config",
    level: "hard",
    anchor: [
      "/etc/shadow",
      "/etc/sudoers",
      "/etc/master.passwd",
      "/etc/crontab",
      "/etc/cron.d/timer",
      "/etc/hosts.allow",
      "/etc/hosts.deny",
    ],
  },
  {
    // SSH public-key files (tier-contract-consistency A2).
    //
    // known_hosts: client-side cached list of known SSH host public keys.
    // authorized_keys: client's authorized public key list (public halves).
    //
    // Neither file contains private key material. Leaking them only affects
    // the client's UX (SSH connection warnings / which keys are allowed),
    // not the security of anyone's account. Users rotate/regenerate these
    // cheaply — they are revocable, unlike a private key.
    //
    // Placed after all hard rules (credential-store-dirname rule fires first
    // for files inside ~/.ssh/, so `~/.ssh/id_rsa` stays hard even though
    // the .ssh dirname would also match this rule's directory condition —
    // ordering guarantees the first-match is the more specific hard rule).
    //
    // Only fires inside ~/.ssh/ or /.ssh/. A known_hosts file elsewhere
    // (e.g. an app's own cache) is not sensitive.
    test: (p) => {
      const b = basename(p).toLowerCase();
      const d = dirname(p).toLowerCase();
      return (
        (b === "known_hosts" || b === "authorized_keys") &&
        (d.endsWith("/.ssh") || d === ".ssh")
      );
    },
    reason: "SSH public key file",
    code: "ssh_public_key",
    level: "soft",
  },
  {
    // Pardonable credential configs. CLI tools conventionally store their
    // apikey/token in a file named config|auth|settings|models with a
    // credential-format extension. These are REVOCABLE — a leaked token can be
    // rotated — unlike a private key, so this level is tier=three (persistable
    // via "Always allow") instead of tier=two.
    //
    // Matching is EXACT on the `<name>.<ext>` shape: bare "config" without an
    // extension does NOT match, so ~/.ssh/config stays hard through the SSH
    // rule above. Code extensions (.ts/.js/.py) are excluded — otherwise every
    // in-project config.ts module would start prompting.
    //
    // APPENDED LAST (ordering invariant, design.md Decision 3):
    // findSensitiveMatch returns the FIRST match, so hard rules placed before
    // this one win on overlaps — ~/.aws/config.json stays hard via the
    // ".aws" dirname rule, config.pem stays hard via the private-key
    // extension rule. Placing soft first would silently downgrade those to
    // tier=three persistable and widen the leak surface.
    test: (p) => {
      const b = basename(p).toLowerCase();
      return SOFT_CONFIG_NAMES.some((n) =>
        SOFT_CONFIG_EXTS.some((e) => b === `${n}${e}`),
      );
    },
    reason: "Soft credential config file",
    code: "soft_credential_config",
    level: "soft",
  },
];

export function findSensitiveMatch(p: string): SensitiveRule | undefined {
  for (const rule of DEFAULT_SENSITIVE_RULES) {
    if (rule.test(p)) return rule;
  }
  return undefined;
}

// Derived from DEFAULT_SENSITIVE_RULES' `anchor` fields (tier-contract-consistency
// A4). Single source of truth: any new hard rule must declare its `anchor`
// and these automatically appear here. Soft rules don't contribute anchors
// (they don't trigger wildcard-override warnings).
//
// Deduplicated across rules because some anchors legitimately match multiple
// rules (e.g. ~/.netrc fires both credential-store-dirname and credential-config
// basenames). The dedup only happens at derivation time — the individual rule
// arrays remain unchanged.
export const HARD_SENSITIVE_ANCHORS: readonly string[] = Array.from(
  new Set(
    DEFAULT_SENSITIVE_RULES
      .filter((r) => r.level === "hard")
      .flatMap((r) => r.anchor ?? []),
  ),
);
