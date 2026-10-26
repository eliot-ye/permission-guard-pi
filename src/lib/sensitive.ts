//
// Default sensitive-path catalog. Pure module - no IO, no pi imports.
// Used as a fallback when the requested path is NOT declared in any
// user config. Declared paths always take precedence over this list.
//

import { dirname, basename } from "node:path";

// Soft (pardonable) credential-config matching vocabulary. Hoisted to module
// scope so the 16-way basename comparison below allocates nothing per call —
// findSensitiveMatch runs on every tool call, including per target in a bash
// extraction sweep.
const SOFT_CONFIG_NAMES = ["config", "auth", "settings", "models"];
const SOFT_CONFIG_EXTS = [".json", ".toml", ".yml", ".yaml"];

export interface SensitiveRule {
  test: (absolutePath: string) => boolean;
  reason: string;
  // "hard"  = non-revocable credential (private key): outer stays tier=two,
  //           no "Always allow" — a leak is not recoverable by rotating a
  //           token.
  // "soft"  = revocable credential config (apikey/token): tier=three anywhere,
  //           so "Always allow" persists and stops re-prompting after the first
  //           prompt. Ordering invariant: soft rules are appended AFTER every
  //           hard rule, so findSensitiveMatch's first-match keeps hard
  //           priority on overlaps (see design.md Decision 3).
  level: "hard" | "soft";
}

export const DEFAULT_SENSITIVE_RULES: SensitiveRule[] = [
  {
    test: (p) => {
      const b = basename(p).toLowerCase();
      const d = dirname(p).toLowerCase();
      // SSH key files - check first so they get the more specific label.
      return (
        b.startsWith("id_rsa") ||
        b.startsWith("id_dsa") ||
        b.startsWith("id_ecdsa") ||
        b.startsWith("id_ed25519") ||
        b === "known_hosts" ||
        b === "authorized_keys" ||
        (b === "config" && (d.endsWith("/.ssh") || d === ".ssh"))
      );
    },
    reason: "SSH key file",
    level: "hard",
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
    level: "hard",
  },
  {
    test: (p) => {
      const b = basename(p).toLowerCase();
      const d = dirname(p).toLowerCase();
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
    level: "hard",
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
    level: "hard",
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
    level: "hard",
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
    level: "soft",
  },
];

export function findSensitiveMatch(p: string): SensitiveRule | undefined {
  for (const rule of DEFAULT_SENSITIVE_RULES) {
    if (rule.test(p)) return rule;
  }
  return undefined;
}
