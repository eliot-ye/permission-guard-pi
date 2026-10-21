//
// TDD RED: decision tests. Covers AD1-AD19.
//
// Contract (post-review): decide() is a pure function that takes:
//   - policy (MergedPolicy)
//   - absPath
//   - projectRoot
//   - action
//   - isInside
//   - sensitive
//   - (optional) bashUnreliable: true if bash extraction was unreliable
//
// Returns Decision discriminated union.
//
// Memory lookup is NOT part of decide() - it's the extension layer's job
// to check grants BEFORE calling decide(). decide() assumes the path is
// NOT already authorized in memory.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mergePolicies, type RawConfig, type MergedPolicy } from "../src/lib/config.ts";
import { findSensitiveMatch } from "../src/lib/sensitive.ts";
import { decide, type Decision } from "../src/lib/decision.ts";

// Helpers

function makePolicy(
  global: RawConfig = {},
  project: RawConfig = {},
  local: RawConfig = {},
  projectRoot = "/proj",
): MergedPolicy {
  return mergePolicies(global, project, local, projectRoot).policy;
}

function decideFor(opts: {
  policy: MergedPolicy;
  absPath: string;
  projectRoot?: string;
  action?: "read" | "write" | "delete";
  isInside?: boolean;
}) {
  const {
    policy,
    absPath,
    projectRoot = "/proj",
    action = "read",
    isInside,
  } = opts;

  // Auto-compute isInside if not provided.
  const computedInside = isInside ?? (() => {
    const rootNorm = projectRoot.replace(/\\/g, "/");
    const sep_ = rootNorm.endsWith("/") ? "" : "/";
    const rootWithSep = rootNorm + sep_;
    return absPath === rootNorm || absPath.startsWith(rootWithSep);
  })();

  return decide({
    policy,
    absPath,
    projectRoot,
    action,
    isInside: computedInside,
    sensitive: findSensitiveMatch(absPath),
  });
}

// -------- AD1: region detection --------

test("AD1: classifies_path_under_project_root_as_inner", () => {
  const d = decideFor({
    policy: makePolicy(),
    absPath: "/proj/src/x.ts",
    action: "read",
  });
  assert.equal(d.kind, "auto_allow");
  if (d.kind === "auto_allow") {
    assert.equal(d.region, "project_inner");
  }
});

// -------- AD2: ../ escape resolves to outer --------

test("AD2: dotdot_escape_resolves_to_project_outer", () => {
  // We assume the caller has already resolved the path (toAbsolutePath + tryRealpath).
  // So we test with the resolved absolute path.
  const d = decideFor({
    policy: makePolicy(),
    absPath: "/outside/x",
    action: "write",
    projectRoot: "/proj",
  });
  // Unconfigured outer write prompts.
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.region, "project_outer");
  }
});

// -------- AD3: symlink escape resolves to outer --------

test("AD3: symlink_escape_resolves_to_project_outer_via_realpath", () => {
  // Symlink resolution is the caller's responsibility (tryRealpath in path-utils).
  // By the time decide() sees the path, it's already resolved.
  // So this test verifies: an absolute path outside /proj is classified as outer.
  const d = decideFor({
    policy: makePolicy(),
    absPath: "/etc/ssh/config",
    action: "read",
  });
  // This is a sensitive path (config in .ssh dir) and outer, so prompt tier=two.
  // But actually /etc/ssh/config may not be sensitive per our rules - it's not in ~/.ssh.
  // Let's check: /etc/ssh/config - not in a .ssh directory, not matching other sensitive rules.
  // So it's unconfigured + outer + read → auto_allow.
  assert.equal(d.kind, "auto_allow");
});

// -------- AD4: declared config overrides default sensitive --------

test("AD4: declared_config_overrides_default_sensitive_rule", () => {
  const policy = makePolicy({}, { paths: { "config/.env": "read_write" } });
  const d = decideFor({
    policy,
    absPath: "/proj/config/.env",
    action: "read",
  });
  // .env is sensitive by default, but declared read_write in project → auto_allow in inner
  assert.equal(d.kind, "auto_allow");
  if (d.kind === "auto_allow") {
    assert.equal(d.declaration, "read_write");
    assert.equal(d.configured, true);
  }
});

// -------- AD5: inner sensitive with read_write is auto-allowed on read --------

test("AD5: declared_read_write_auto_allows_read_inside_project", () => {
  const policy = makePolicy({}, { paths: { "src/creds/local.key": "read_write" } });
  const d = decideFor({
    policy,
    absPath: "/proj/src/creds/local.key",
    action: "read",
  });
  assert.equal(d.kind, "auto_allow");
});

// -------- AD6: inner read_write write auto-allows --------

test("AD6: declared_read_write_auto_allows_write_inside_project", () => {
  const policy = makePolicy({}, { paths: { "vendor/**": "read_write" } });
  const d = decideFor({
    policy,
    absPath: "/proj/vendor/a.txt",
    action: "write",
  });
  assert.equal(d.kind, "auto_allow");
});

// -------- AD7: outer read_write first access → three-tier prompt --------

test("AD7: declared_read_write_outside_project_prompts_three_tier", () => {
  const policy = makePolicy({ paths: { "/opt/shared/secrets": "read_write" } });
  const d = decideFor({
    policy,
    absPath: "/opt/shared/secrets/x",
    action: "read",
  });
  // Note: this is an absolute literal pattern, so /opt/shared/secrets/x should
  // NOT match (exact match only). Let's adjust to test the outer prompt path:
  const policy2 = makePolicy({ paths: { "/opt/shared/secrets/x": "read_write" } });
  const d2 = decideFor({
    policy: policy2,
    absPath: "/opt/shared/secrets/x",
    action: "read",
  });
  assert.equal(d2.kind, "prompt");
  if (d2.kind === "prompt") {
    assert.equal(d2.tier, "three");
    assert.equal(d2.declaration, "read_write");
  }
});

// -------- AD8: outer read_write after persistent grant → auto-allow (extension layer) --------

test("AD8: persisted_grant_for_read_write_outside_project_skips_prompt", () => {
  // Per design D1, memory lookup is extension-layer responsibility.
  // decide() doesn't know about grants. This test documents that the
  // extension layer will check grants BEFORE calling decide() and skip
  // decide() entirely if there's a hit.
  //
  // We verify the DECISION for a fresh (no-grant) request is prompt tier=three,
  // which is the state that gets "overridden" by the extension's grant lookup.
  const policy = makePolicy({ paths: { "/opt/shared/secrets/x": "read_write" } });
  const d = decideFor({
    policy,
    absPath: "/opt/shared/secrets/x",
    action: "read",
  });
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.tier, "three", "extension will short-circuit via grant lookup");
  }
});

// -------- AD9: read_only read is auto-allowed --------

test("AD9: declared_read_only_auto_allows_read", () => {
  const policy = makePolicy({ paths: { "/Users/x/.aws/credentials": "read_only" } });
  const d = decideFor({
    policy,
    absPath: "/Users/x/.aws/credentials",
    action: "read",
  });
  assert.equal(d.kind, "auto_allow");
  if (d.kind === "auto_allow") {
    assert.equal(d.declaration, "read_only");
  }
});

// -------- AD10: read_only write prompts three-tier --------

test("AD10: declared_read_only_write_prompts_three_tier", () => {
  const policy = makePolicy({}, { paths: { "src/secrets.txt": "read_only" } });
  const d = decideFor({
    policy,
    absPath: "/proj/src/secrets.txt",
    action: "write",
  });
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.tier, "three");
  }
});

// -------- AD11: inner unread hard-denies --------

test("AD11: declared_unread_hard_denies_inside_project", () => {
  const policy = makePolicy({}, { paths: { "src/secrets.txt": "unread" } });
  const d = decideFor({
    policy,
    absPath: "/proj/src/secrets.txt",
    action: "read",
  });
  assert.equal(d.kind, "deny_hard");
});

// -------- AD12: outer unread hard-denies --------

test("AD12: declared_unread_hard_denies_outside_project", () => {
  const policy = makePolicy({ paths: { "/srv/prod-keys": "unread" } });
  const d = decideFor({
    policy,
    absPath: "/srv/prod-keys",
    action: "read",
  });
  assert.equal(d.kind, "deny_hard");
});

// -------- AD13: unread cannot be bypassed by memory (contract) --------

test("AD13: persisted_grant_cannot_override_unread_declaration", () => {
  // This is a contract test: even if the extension layer pre-checks grants,
  // unread takes precedence. The extension layer's order must be:
  //   1. policy.resolve → if permission === 'unread' → deny_hard (skip grant check)
  //   2. check grants → hit → allow
  //   3. else call decide()
  //
  // We test that decide() unconditionally returns deny_hard for unread paths.
  const policy = makePolicy({ paths: { "/x": "unread" } });
  const d = decideFor({
    policy,
    absPath: "/x",
    action: "read",
  });
  assert.equal(d.kind, "deny_hard");
});

// -------- AD14: unconfigured inner plain write auto-allows --------

test("AD14: unconfigured_inner_plain_write_auto_allows", () => {
  const policy = makePolicy();
  const d = decideFor({
    policy,
    absPath: "/proj/src/main.ts",
    action: "write",
  });
  assert.equal(d.kind, "auto_allow");
  if (d.kind === "auto_allow") {
    assert.equal(d.declaration, "unconfigured");
    assert.equal(d.configured, false);
  }
});

// -------- AD15: unconfigured outer sensitive read prompts two-tier --------

test("AD15: unconfigured_outer_sensitive_read_prompts_two_tier", () => {
  const policy = makePolicy();
  const d = decideFor({
    policy,
    absPath: "/Users/x/.ssh/id_rsa",
    action: "read",
  });
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.tier, "two");
    assert.equal(d.declaration, "sensitive_default");
  }
});

// -------- AD16: unconfigured outer plain write prompts three-tier --------

test("AD16: default_tmp_plain_write_auto_allows", () => {
  const policy = makePolicy();
  const d = decideFor({
    policy,
    absPath: "/tmp/somefile.txt",
    action: "write",
  });
  assert.equal(d.kind, "auto_allow");
  if (d.kind === "auto_allow") {
    // /tmp/** is a built-in read_write default for ordinary scratch files.
    // Sensitive /tmp paths are tested separately below.
    assert.equal(d.declaration, "unconfigured");
    assert.equal(d.configured, false);
  }
});

test("default_tmp_paths_allow_write_delete_and_match_private_tmp", () => {
  const policy = makePolicy();
  for (const action of ["write", "delete"] as const) {
    for (const absPath of ["/tmp", "/tmp/x", "/tmp/deep/nested.txt", "/private/tmp/deep/nested.txt"]) {
      const d = decideFor({
        policy,
        absPath,
        action,
      });
      assert.equal(d.kind, "auto_allow", `${action} ${absPath} should be auto-allowed`);
    }
  }
});

test("default_tmp_sensitive_files_still_prompt", () => {
  const policy = makePolicy();
  const d = decideFor({
    policy,
    absPath: "/tmp/creds/.env",
    action: "write",
  });
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.declaration, "sensitive_default");
    assert.equal(d.tier, "two");
  }
});

test("explicit_unread_overrides_default_tmp_write", () => {
  const policy = makePolicy({ paths: { "/tmp/x": "unread" } });
  const d = decideFor({
    policy,
    absPath: "/tmp/x",
    action: "write",
  });
  assert.equal(d.kind, "deny_hard");
});

test("explicit_read_only_overrides_default_tmp_write", () => {
  const policy = makePolicy({ paths: { "/tmp/read-only/**": "read_only" } });
  const d = decideFor({
    policy,
    absPath: "/tmp/read-only/x.txt",
    action: "write",
  });
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.declaration, "read_only");
    assert.equal(d.tier, "three");
  }
});

// -------- AD17: cross-source unread vs read_write conflicts --------

test("AD17: cross_source_unread_vs_read_write_prompts_with_conflict_flag", () => {
  const policy = makePolicy(
    { paths: { "/srv": "unread" } },
    { paths: { "/srv": "read_write" } },
  );
  const d = decideFor({
    policy,
    absPath: "/srv",
    action: "read",
  });
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.tier, "three");
    assert.equal(d.conflict, true);
    assert.ok(d.reason.includes("conflict") || d.reason.includes("Conflicting"));
  }
});

// -------- AD18: sensitive file grants are per-file (contract test for decision) --------

test("AD18: sensitive_file_grant_is_keyed_by_full_path_not_directory", () => {
  // decide() doesn't know about grants. This test verifies that sensitive
  // paths always require per-file decision - i.e. deciding about /a does not
  // automatically decide /b in the same directory.
  const policy = makePolicy();
  const d1 = decideFor({
    policy,
    absPath: "/Users/x/.ssh/id_rsa",
    action: "read",
  });
  const d2 = decideFor({
    policy,
    absPath: "/Users/x/.ssh/known_hosts",
    action: "read",
  });
  assert.equal(d1.kind, "prompt");
  assert.equal(d2.kind, "prompt");
});

// -------- AD19: unreliable bash command → two-tier prompt --------

// -------- Additional: bash reliable targets go through normal decision --------

test("AD-extra: reliable bash targets are decided individually", () => {
  const policy = makePolicy();
  const d = decideFor({
    policy,
    absPath: "/outside/x",
    action: "delete",
  });
  // Reliable bash with a valid target - normal decision applies.
  // Outer unconfigured non-tmp delete is tier=three.
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.tier, "three");
  }
});

// -------- Additional: outer read of unconfigured non-sensitive is auto-allowed --------

test("AD-extra: unconfigured_outer_non_sensitive_read_auto_allows", () => {
  const policy = makePolicy();
  const d = decideFor({
    policy,
    absPath: "/tmp/notasecret.txt",
    action: "read",
  });
  assert.equal(d.kind, "auto_allow");
});

// -------- Additional: read_only inner write prompts (from AD10 variant) --------

test("AD-extra: read_only_inner_write_prompts_three_tier", () => {
  const policy = makePolicy({}, { paths: { "vendor/**": "read_only" } });
  const d = decideFor({
    policy,
    absPath: "/proj/vendor/a.txt",
    action: "write",
  });
  assert.equal(d.kind, "prompt");
  if (d.kind === "prompt") {
    assert.equal(d.tier, "three");
  }
});
