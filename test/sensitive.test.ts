//
// TDD RED: sensitive tests.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { findSensitiveMatch, DEFAULT_SENSITIVE_RULES } from "../src/lib/sensitive.ts";

test("sensitive: SSH key files (id_rsa, id_ed25519, ...)", () => {
  assert.ok(findSensitiveMatch("/Users/x/.ssh/id_rsa"));
  assert.ok(findSensitiveMatch("/Users/x/.ssh/id_ed25519"));
  assert.ok(findSensitiveMatch("/Users/x/.ssh/id_dsa"));
  assert.ok(findSensitiveMatch("/Users/x/.ssh/id_ecdsa"));
  assert.ok(findSensitiveMatch("/Users/x/.ssh/known_hosts"));
  assert.ok(findSensitiveMatch("/Users/x/.ssh/authorized_keys"));
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
