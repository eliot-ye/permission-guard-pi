//
// TDD RED: sensitive tests.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { findSensitiveMatch, DEFAULT_SENSITIVE_RULES } from "../src/lib/sensitive.ts";

test("sensitive: SSH key files (id_rsa, id_ed25519, id_dsa, id_ecdsa)", () => {
  // tier-contract-consistency A2: known_hosts and authorized_keys are
  // now handled by the separate soft SSH public-key rule — no longer
  // matched by the hard SSH private-key rule below. Their behaviour is
  // covered by the SENS-A2 tests further down.
  assert.ok(findSensitiveMatch("/Users/x/.ssh/id_rsa"));
  assert.ok(findSensitiveMatch("/Users/x/.ssh/id_ed25519"));
  assert.ok(findSensitiveMatch("/Users/x/.ssh/id_dsa"));
  assert.ok(findSensitiveMatch("/Users/x/.ssh/id_ecdsa"));
});

test("sensitive: SSH config inside .ssh dir", () => {
  const m = findSensitiveMatch("/Users/x/.ssh/config");
  assert.ok(m, "SSH config should be flagged sensitive");
});

test("sensitive: private key extensions (.pem, .key, .p12, .pfx, .jks, .kdbx)", () => {
  assert.ok(findSensitiveMatch("/x/server.pem"));
  assert.ok(findSensitiveMatch("/x/server.key"));
  assert.ok(findSensitiveMatch("/x/store.p12"));
  assert.ok(findSensitiveMatch("/x/store.pfx"));
  assert.ok(findSensitiveMatch("/x/app.jks"));
  assert.ok(findSensitiveMatch("/x/keepass.kdbx"));
});

test("sensitive: .env files and env-variant names", () => {
  assert.ok(findSensitiveMatch("/proj/.env"));
  assert.ok(findSensitiveMatch("/proj/.envrc"));
  assert.ok(findSensitiveMatch("/proj/.env.production"));
  assert.ok(findSensitiveMatch("/proj/.env.local"));
  // .env.example should NOT be sensitive (it's meant to be committed)
  assert.equal(findSensitiveMatch("/proj/.env.example"), undefined);
});

test("sensitive: sensitive directories", () => {
  assert.ok(findSensitiveMatch("/Users/x/.ssh/foo"));
  assert.ok(findSensitiveMatch("/Users/x/.gnupg/secring.gpg"));
  assert.ok(findSensitiveMatch("/Users/x/.aws/credentials"));
  assert.ok(findSensitiveMatch("/Users/x/.kube/config"));
  assert.ok(findSensitiveMatch("/Users/x/.docker/config.json"));
  assert.ok(findSensitiveMatch("/Users/x/.netrc/foo"));
  assert.ok(findSensitiveMatch("/Users/x/.git-credentials/x"));
});

test("sensitive: credential store files", () => {
  assert.ok(findSensitiveMatch("/proj/secrets.yaml"));
  assert.ok(findSensitiveMatch("/proj/secrets.yml"));
  assert.ok(findSensitiveMatch("/proj/secrets.json"));
  assert.ok(findSensitiveMatch("/proj/credentials"));
  assert.ok(findSensitiveMatch("/Users/x/.npmrc"));
  assert.ok(findSensitiveMatch("/Users/x/.netrc"));
});

test("sensitive: normal files are not sensitive", () => {
  assert.equal(findSensitiveMatch("/proj/src/main.ts"), undefined);
  assert.equal(findSensitiveMatch("/proj/README.md"), undefined);
  assert.equal(findSensitiveMatch("/tmp/notes.txt"), undefined);
});

test("sensitive: multiple rules exist", () => {
  // Sanity check the default ruleset size
  assert.ok(DEFAULT_SENSITIVE_RULES.length >= 4, "expected at least 4 rule families");
});

// ============================================================
// bash-hardening-round-2: system credential/config file rule
// ============================================================

test("SENS-SYS-01: system_credential_files_sensitive", () => {
  // L4a: system credential/config files under /etc are sensitive by default.
  // These are common Unix privilege-escalation / lateral-movement entry points.
  const sensitive = [
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/master.passwd",
    "/etc/crontab",
    "/etc/cron.d/myjob",
    "/etc/hosts.allow",
  ];
  for (const p of sensitive) {
    const m = findSensitiveMatch(p);
    assert.ok(m, `${p} should be flagged sensitive`);
    assert.equal(
      m?.reason,
      "System credential/config file",
      `${p} should carry the system credential/config reason`,
    );
  }
});

test("SENS-SYS-07: etc_passwd_and_public_etc_files_not_sensitive", () => {
  // /etc/passwd holds public user list (name/UID/GID/home/shell) — NOT
  // sensitive. Same for /etc/hosts, /etc/hostname, /etc/group,
  // /etc/nsswitch.conf — they are public system configuration.
  const notSensitive = [
    "/etc/passwd",
    "/etc/hosts",
    "/etc/hostname",
    "/etc/group",
    "/etc/nsswitch.conf",
  ];
  for (const p of notSensitive) {
    assert.equal(findSensitiveMatch(p), undefined, `${p} must NOT be flagged sensitive`);
  }
});

// ============================================================
// sensitive-soft-pardonable-set: soft/pardonable credential configs
// ============================================================

test("SENS-SOFT: soft credential config files match as soft", () => {
  // Pardonable credential configs: <name>.<ext> where name ∈
  // config|auth|settings|models and ext ∈ json|toml|yml|yaml.
  const soft = [
    "/Users/x/.config/gh/config.yml",
    "/Users/x/.config/app/auth.json",
    "/Users/x/.config/app/settings.toml",
    "/Users/x/.config/app/models.json",
  ];
  for (const p of soft) {
    const m = findSensitiveMatch(p);
    assert.ok(m, `${p} should be flagged sensitive (soft)`);
    assert.equal(m?.level, "soft", `${p} should carry level "soft"`);
    // Negative-control on reason as well as level: guarantees the soft rule
    // fires rather than an unrelated hard rule that happens to match.
    assert.equal(
      m?.reason,
      "Soft credential config file",
      `${p} should carry the soft reason, not a hard rule's`,
    );
  }
});

test("SENS-SOFT: code-extension files do NOT match soft", () => {
  // .ts/.js/.py are code extensions, not credential formats — must not be
  // flagged soft (avoids misclassifying in-project code modules).
  const notSoft = ["/proj/config.ts", "/proj/auth.py", "/proj/settings.js"];
  for (const p of notSoft) {
    const m = findSensitiveMatch(p);
    assert.equal(m, undefined, `${p} must NOT be flagged sensitive`);
  }
});

test("SENS-SOFT: extensionless config does NOT match soft", () => {
  // Soft requires a credential extension; bare "config" is not soft.
  const m = findSensitiveMatch("/tmp/config");
  assert.equal(m, undefined, "extensionless config must NOT be flagged sensitive");
});

test("SENS-SOFT: ssh id_rsa and ssh config still hard", () => {
  // Not revoked-able private key stays hard (outer tier=two, non-persistable).
  const id_rsa = findSensitiveMatch("/Users/x/.ssh/id_rsa");
  assert.equal(id_rsa?.level, "hard", "ssh id_rsa must stay hard");
  // ~/.ssh/config has no extension — not soft, stays hard via the SSH rule.
  const ssh_config = findSensitiveMatch("/Users/x/.ssh/config");
  assert.equal(ssh_config?.level, "hard", "ssh config must stay hard");
});

test("SENS-SOFT: hard priority beats soft on ordering boundaries", () => {
  // Ordering invariant (design.md Decision 3): soft rules are appended
  // AFTER all hard rules, so findSensitiveMatch's first-match semantics keep
  // hard priority on overlaps. Without this, an outer ~/.aws/config.json
  // read would be downgraded to tier=three persistable — a leak widening.
  //
  // Each case overlaps soft's <name>.<ext> with a DIFFERENT hard rule, so
  // the invariant is not proven by one lucky rule — moving soft anywhere
  // above rule 1/2/3 would each be caught separately.
  // ~/.aws/config.json → overlaps the credential-store-dirname rule.
  const aws = findSensitiveMatch("/Users/x/.aws/config.json");
  assert.equal(aws?.level, "hard", "~/.aws/config.json must stay hard (dirname rule wins over soft <name>.<ext>)");
  // ~/.docker/config.json → overlaps the same dirname rule, but carries a
  // Docker Hub / private-registry auth token: the canonical "revocable but
  // high-blast-radius" case the soft rule is meant to be careful about.
  const docker = findSensitiveMatch("/Users/x/.docker/config.json");
  assert.equal(docker?.level, "hard", "~/.docker/config.json must stay hard (dirname rule wins over soft <name>.<ext>)");
  // config.pem → overlaps the private-key-extension rule.
  const pem = findSensitiveMatch("/proj/config.pem");
  assert.equal(pem?.level, "hard", "config.pem must stay hard (private-key extension wins over soft basename)");
});

test("SENS-SOFT: soft is the LAST rule, so hard always wins on overlap", () => {
  // Structural guard for the ordering invariant above. The behavioural cases
  // prove the invariant holds for specific paths; this proves it for the rule
  // table as a whole — no hard rule may ever sit after a soft rule, or the
  // first-match semantics silently downgrade that hard rule to persistable.
  //
  // NOTE (tier-contract-consistency A2): soft rules may be > 1 now (soft
  // credential config file + soft SSH public-key files). The invariant is
  // "soft rules form a suffix of the rule array" — not "soft is the single
  // last rule". Every hard rule precedes every soft rule.
  const softIndexes = DEFAULT_SENSITIVE_RULES
    .map((r, i) => (r.level === "soft" ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(softIndexes.length >= 1, "at least one soft rule must exist");
  // Every rule at index >= min(softIndexes) must be soft.
  const firstSoft = Math.min(...softIndexes);
  for (const [i, rule] of DEFAULT_SENSITIVE_RULES.entries()) {
    if (i >= firstSoft) {
      assert.equal(
        rule.level,
        "soft",
        `rule[${i}] (${rule.reason}) must not be hard once the soft suffix starts`,
      );
    }
  }
});

// ============================================================
// tier-contract-consistency A2: SSH public-key files soft downgrade
// ============================================================

test("SENS-A2: ~/.ssh/known_hosts matches as soft", () => {
  // known_hosts is a client-side cached list of host public keys — no
  // exfiltration risk (leak affects only the client's SSH connection
  // warning UX). Public key files belong to soft sensitive (revocable by
  // regenerating the cache), not hard sensitive (non-revocable private key).
  const m = findSensitiveMatch("/Users/x/.ssh/known_hosts");
  assert.ok(m, "~/.ssh/known_hosts should be flagged sensitive");
  assert.equal(m?.level, "soft", "known_hosts must be soft (not hard)");
  assert.equal(
    m?.reason,
    "SSH public key file",
    "known_hosts should carry the SSH public-key soft reason",
  );
});

test("SENS-A2: ~/.ssh/authorized_keys matches as soft", () => {
  // authorized_keys is the client's authorized public key list. Leaking it
  // only reveals the *client's* key fingerprints — the actual private keys
  // never leave the client. Not a non-revocable secret.
  const m = findSensitiveMatch("/Users/x/.ssh/authorized_keys");
  assert.ok(m, "~/.ssh/authorized_keys should be flagged sensitive");
  assert.equal(m?.level, "soft", "authorized_keys must be soft (not hard)");
  assert.equal(
    m?.reason,
    "SSH public key file",
    "authorized_keys should carry the SSH public-key soft reason",
  );
});

test("SENS-A2: non-.ssh known_hosts is NOT soft", () => {
  // The soft SSH public-key rule only fires inside ~/.ssh/ (or /.ssh/ at root).
  // A known_hosts file elsewhere (e.g. an app's own cache) is not sensitive.
  assert.equal(
    findSensitiveMatch("/Users/x/myapp/known_hosts"),
    undefined,
    "known_hosts outside .ssh/ must NOT be flagged sensitive",
  );
  assert.equal(
    findSensitiveMatch("/proj/known_hosts"),
    undefined,
    "known_hosts in project must NOT be flagged sensitive",
  );
});

test("SENS-A2: ~/.ssh/id_rsa still hard after known_hosts downgrade", () => {
  // Ordering invariant check: known_hosts is soft, id_rsa stays hard, even
  // though they live in the same directory.
  const id = findSensitiveMatch("/Users/x/.ssh/id_rsa");
  assert.ok(id, "id_rsa must still be flagged");
  assert.equal(id?.level, "hard", "id_rsa must stay hard");
});

test("SENS-A2: ~/.ssh/config still hard (not soft-SSH-public-key)", () => {
  // ~/.ssh/config is SSH client config — it may contain connection options
  // and key paths. Not a public key file. Stays hard via the original SSH rule.
  const m = findSensitiveMatch("/Users/x/.ssh/config");
  assert.ok(m, "~/.ssh/config must still be flagged");
  assert.equal(m?.level, "hard", "~/.ssh/config must stay hard");
});

test("SENS-A2: ~/.aws/config.json still hard (soft SSH rule doesn't steal it)", () => {
  // ~/.aws/config.json is under ~/.aws (credential store dirname). It would
  // match the soft SSH public-key rule only if basename were 'known_hosts'
  // or 'authorized_keys' — it's 'config.json', so soft SSH rule doesn't fire.
  // The credential-store-dirname hard rule fires first and stays hard.
  const m = findSensitiveMatch("/Users/x/.aws/config.json");
  assert.ok(m, "~/.aws/config.json must still be flagged");
  assert.equal(m?.level, "hard", "~/.aws/config.json must stay hard");
});

test("SENS-A2: authorized_keys in a non-.ssh dir is NOT sensitive", () => {
  // authorized_keys outside ~/.ssh/ is a plain file (e.g. someone's local
  // key list). Not sensitive.
  assert.equal(
    findSensitiveMatch("/Users/x/backup/authorized_keys"),
    undefined,
    "authorized_keys outside .ssh/ must NOT be flagged sensitive",
  );
});
