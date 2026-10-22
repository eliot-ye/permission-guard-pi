//
// Default sensitive-path catalog. Pure module - no IO, no pi imports.
// Used as a fallback when the requested path is NOT declared in any
// user config. Declared paths always take precedence over this list.
//

import { dirname, basename } from "node:path";

export interface SensitiveRule {
  test: (absolutePath: string) => boolean;
  reason: string;
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
  },
];

export function findSensitiveMatch(p: string): SensitiveRule | undefined {
  for (const rule of DEFAULT_SENSITIVE_RULES) {
    if (rule.test(p)) return rule;
  }
  return undefined;
}
