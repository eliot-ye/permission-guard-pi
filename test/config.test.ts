//
// TDD RED: config tests. Covers PC1-PC15.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfigFile,
  mergePolicies,
  type RawConfig,
  type MergedPolicy,
} from "../src/lib/config.ts";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cfg-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -------- PC1: three-tier precedence merge --------

test("PC1: merges_local_over_project_over_global", async () => {
  await withTmpDir(async () => {
    const global: RawConfig = { paths: { "/x": "read_write" } };
    const project: RawConfig = { paths: { "/x": "unread" } };
    const local: RawConfig = { paths: { "/x": "read_only" } };
    const { policy } = mergePolicies(global, project, local, "/proj");
    const entry = policy.resolve("/x");
    assert.ok(entry);
    assert.equal(entry.permission, "read_only");
    assert.equal(entry.source, "local");
  });
});

// -------- PC2: missing local config --------

test("PC2: missing_local_config_is_treated_as_empty", async () => {
  await withTmpDir(async () => {
    const global: RawConfig = { paths: { "/x": "read_write" } };
    const project: RawConfig = { paths: {} };
    const { policy } = mergePolicies(global, project, {}, "/proj");
    const entry = policy.resolve("/x");
    assert.ok(entry);
    assert.equal(entry.permission, "read_write");
    assert.equal(entry.source, "global");
  });
});

// -------- PC3: malformed config -> empty + warning --------

test("PC3: malformed_jsonc_file_yields_empty_config_with_warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cfg-"));
  try {
    const p = join(dir, "malformed.json");
    await writeFile(p, "{ paths: { broken }", "utf8");
    const { raw, error } = await loadConfigFile(p);
    assert.deepEqual(raw, {});
    assert.ok(error, "expected an error message for malformed JSON");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -------- PC4: JSONC parsing --------

test("PC4: jsonc_parser_strips_comments_and_trailing_commas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cfg-"));
  try {
    const p = join(dir, "jsonc.json");
    await writeFile(
      p,
      `{
      // line comment
      "paths": {
        /* block comment */
        "/tmp/x": "read_write",  // inline
      },
    }`,
      "utf8",
    );
    const { raw } = await loadConfigFile(p);
    assert.deepEqual(raw, { paths: { "/tmp/x": "read_write" } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -------- PC5: invalid permission ignored --------

test("PC5: invalid_permission_value_is_skipped_with_warning", () => {
  const global: RawConfig = { paths: { "/x": "delete" as any } };
  const { warnings } = mergePolicies(global, {}, {}, "/proj");
  assert.ok(warnings.some((w) => w.includes("delete") && w.includes("/x")));
});

// -------- PC6: absolute path exact match --------

test("PC6: absolute_path_pattern_is_exact_match_not_prefix", () => {
  const global: RawConfig = { paths: { "/Users/x/.ssh": "read_write" } };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  // Exact path matches
  const exact = policy.resolve("/Users/x/.ssh");
  assert.ok(exact, "should match exact path");
  assert.equal(exact.permission, "read_write");
  // Prefix (deeper path) should NOT match
  assert.equal(policy.resolve("/Users/x/.ssh/id_rsa"), undefined);
});

// -------- PC7: ~ expansion --------

test("PC7: tilde_expansion_matches_absolute_path", () => {
  process.env.HOME = "/Users/eliot";
  const global: RawConfig = { paths: { "~/.aws": "read_only" } };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  const entry = policy.resolve("/Users/eliot/.aws");
  assert.ok(entry);
  assert.equal(entry.permission, "read_only");
});

// -------- PC8: project-relative glob inside root --------

test("PC8: project_relative_glob_matches_inside_project_root", () => {
  const project: RawConfig = { paths: { "**/*.pem": "read_write" } };
  const { policy } = mergePolicies({}, project, {}, "/proj");
  const entry = policy.resolve("/proj/vendor/certs/root.pem");
  assert.ok(entry);
  assert.equal(entry.permission, "read_write");
});

// -------- PC9: project-relative glob does NOT match outside root --------

test("PC9: project_relative_glob_does_not_match_outside_project_root", () => {
  const project: RawConfig = { paths: { "**/*.pem": "read_write" } };
  const { policy } = mergePolicies({}, project, {}, "/proj");
  assert.equal(policy.resolve("/other-proj/x.pem"), undefined);
});

// -------- PC10: absolute path glob at any depth --------

test("PC10: absolute_glob_matches_at_any_path_depth", () => {
  const global: RawConfig = { paths: { "/tmp/**/*.log": "read_only" } };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  const entry = policy.resolve("/tmp/app/deep/nested.log");
  assert.ok(entry);
  assert.equal(entry.permission, "read_only");
  // Also matches shallow
  const shallow = policy.resolve("/tmp/x.log");
  assert.ok(shallow);
});

// -------- PC11: local over project --------

test("PC11: local_source_overrides_project_source", () => {
  const project: RawConfig = { paths: { "/x": "read_write" } };
  const local: RawConfig = { paths: { "/x": "read_only" } };
  const { policy } = mergePolicies({}, project, local, "/proj");
  const entry = policy.resolve("/x");
  assert.ok(entry);
  assert.equal(entry.source, "local");
  assert.equal(entry.permission, "read_only");
});

// -------- PC12: literal beats glob in same source --------

test("PC12: literal_pattern_beats_glob_in_same_source", () => {
  const project: RawConfig = {
    paths: { "src/**": "read_only", "src/x.ts": "read_write" },
  };
  const { policy } = mergePolicies({}, project, {}, "/proj");
  const entry = policy.resolve("/proj/src/x.ts");
  assert.ok(entry);
  assert.equal(entry.permission, "read_write", "literal should win over glob in same source");
});

// -------- PC13: cross-source unread vs read_write flags conflict --------

test("PC13: cross_source_unread_vs_read_write_flags_conflict", () => {
  const global: RawConfig = { paths: { "/srv": "unread" } };
  const project: RawConfig = { paths: { "/srv": "read_write" } };
  const { policy } = mergePolicies(global, project, {}, "/proj");
  const entry = policy.resolve("/srv");
  assert.ok(entry);
  assert.equal(entry.permission, "read_write", "project should win by precedence");
  assert.equal(entry.conflict, true, "expected conflict=true");
  assert.equal(entry.conflictInvolvesUnread, true);
});

// -------- PC14: same permission across sources does not conflict --------

test("PC14: same_permission_across_sources_not_flagged_as_conflict", () => {
  const global: RawConfig = { paths: { "/x": "read_only" } };
  const project: RawConfig = { paths: { "/x": "read_only" } };
  const { policy } = mergePolicies(global, project, {}, "/proj");
  const entry = policy.resolve("/x");
  assert.ok(entry);
  assert.equal(entry.conflict, false);
  assert.equal(entry.conflictInvolvesUnread, false);
});

// -------- PC15: config reload after removal falls back --------

test("PC15: config_reload_after_removal_falls_back_to_default", () => {
  // Before removal
  const project: RawConfig = { paths: { "/x": "read_write" } };
  let { policy } = mergePolicies({}, project, {}, "/proj");
  assert.ok(policy.resolve("/x"));

  // After removal (empty project config)
  ({ policy } = mergePolicies({}, {}, {}, "/proj"));
  assert.equal(policy.resolve("/x"), undefined);
});

// -------- Additional: read_only vs read_write conflict (from architecture review Issue 2) --------

test("cross-source: read_only vs read_write flagged as conflict (metadata) but no unread", () => {
  const global: RawConfig = { paths: { "/x": "read_only" } };
  const project: RawConfig = { paths: { "/x": "read_write" } };
  const { policy } = mergePolicies(global, project, {}, "/proj");
  const entry = policy.resolve("/x");
  assert.ok(entry);
  assert.equal(entry.permission, "read_write");
  assert.equal(entry.conflict, true);
  // But no unread involved
  assert.equal(entry.conflictInvolvesUnread, false);
});

// -------- PC16-PC23: tool+pattern rules --------

test("PC16: config_with_rules_parses_correctly", () => {
  const global: RawConfig = {
    rules: [{ tool: "bash", pattern: "git *", action: "allow" }],
  };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  const match = policy.resolveRule("bash", "git status");
  assert.ok(match);
  assert.equal(match.action, "allow");
  assert.equal(match.source, "global");
});

test("PC17: rule_without_pattern_matches_all_calls_of_tool", () => {
  const global: RawConfig = {
    rules: [{ tool: "bash", action: "deny" }],
  };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  const match = policy.resolveRule("bash", "any command");
  assert.ok(match);
  assert.equal(match.action, "deny");
});

test("PC18: missing_rules_field_treated_as_empty", () => {
  const global: RawConfig = { paths: { "/x": "read_write" } };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  assert.equal(policy.resolveRule("bash", "git status"), undefined);
  assert.equal(policy.resolveRule("read", "/etc/passwd"), undefined);
});

test("PC19: invalid_action_value_skipped_with_warning", () => {
  const global: RawConfig = {
    rules: [{ tool: "bash", action: "maybe" as any }],
  };
  const { warnings, policy } = mergePolicies(global, {}, {}, "/proj");
  assert.ok(warnings.some((w) => w.includes("maybe")));
  assert.equal(policy.resolveRule("bash", "git status"), undefined);
});

test("PC20: local_rule_overrides_project_rule", () => {
  const project: RawConfig = {
    rules: [{ tool: "bash", pattern: "git *", action: "allow" }],
  };
  const local: RawConfig = {
    rules: [{ tool: "bash", pattern: "git *", action: "deny" }],
  };
  const { policy } = mergePolicies({}, project, local, "/proj");
  const match = policy.resolveRule("bash", "git push");
  assert.ok(match);
  assert.equal(match.action, "deny");
  assert.equal(match.source, "local");
});

test("PC21: deny_wins_over_allow_across_sources", () => {
  const global: RawConfig = {
    rules: [{ tool: "bash", pattern: "git *", action: "allow" }],
  };
  const project: RawConfig = {
    rules: [{ tool: "bash", pattern: "git *", action: "deny" }],
  };
  const { policy } = mergePolicies(global, project, {}, "/proj");
  const match = policy.resolveRule("bash", "git push");
  assert.ok(match);
  assert.equal(match.action, "deny");
});

test("PC22: no_matching_rule_returns_undefined", () => {
  const global: RawConfig = {
    rules: [{ tool: "bash", pattern: "git *", action: "allow" }],
  };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  assert.equal(policy.resolveRule("bash", "rm -rf /"), undefined);
});

test("PC23: pattern_matching_semantics", () => {
  const global: RawConfig = {
    rules: [
      { tool: "bash", pattern: "git *", action: "allow" },
      { tool: "read", pattern: "/tmp/**", action: "allow" },
    ],
  };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  // git * matches git status
  assert.ok(policy.resolveRule("bash", "git status"));
  // git * does not match rm -rf
  assert.equal(policy.resolveRule("bash", "rm -rf /"), undefined);
  // whitespace normalization: git  status matches git status pattern
  assert.ok(policy.resolveRule("bash", "git  status"));
  // file tool pattern matches path
  assert.ok(policy.resolveRule("read", "/tmp/app/deep.log"));
  // read pattern does not match bash command
  assert.equal(policy.resolveRule("read", "git status"), undefined);
});
