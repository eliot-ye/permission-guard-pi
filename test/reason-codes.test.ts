//
// TDD RED: reason-codes tests.
//
// Verifies the stable ReasonCode contract:
//   - 3 domains, 27 codes total (13 + 7 + 7)
//   - Every code is snake_case
//   - No cross-domain collision
//   - No duplicates within a domain

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DECISION_REASON_CODES,
  SENSITIVE_REASON_CODES,
  BASH_REASON_CODES,
  ALL_REASON_CODES,
  isSnakeCase,
} from "../src/lib/reason-codes.ts";
test("reason-codes: decision domain has exactly 13 codes", () => {
  assert.equal(DECISION_REASON_CODES.length, 13);
});

test("reason-codes: sensitive domain has exactly 7 codes", () => {
  assert.equal(SENSITIVE_REASON_CODES.length, 7);
});

test("reason-codes: bash domain has exactly 15 codes", () => {
  assert.equal(BASH_REASON_CODES.length, 15);
});

test("reason-codes: total is 35 across all 3 domains", () => {
  assert.equal(ALL_REASON_CODES.length, 35);
});

test("reason-codes: every code is snake_case", () => {
  for (const code of ALL_REASON_CODES) {
    assert.ok(
      isSnakeCase(code),
      `${code} must match /^[a-z][a-z0-9_]*$/ (snake_case)`,
    );
  }
});

test("reason-codes: no duplicates within a domain", () => {
  const checkUnique = (codes: readonly string[], domain: string) => {
    const seen = new Set<string>();
    for (const c of codes) {
      assert.ok(!seen.has(c), `duplicate ${c} in ${domain}`);
      seen.add(c);
    }
  };
  checkUnique(DECISION_REASON_CODES, "decision");
  checkUnique(SENSITIVE_REASON_CODES, "sensitive");
  checkUnique(BASH_REASON_CODES, "bash");
});

test("reason-codes: no cross-domain collision", () => {
  // All 27 codes must be unique globally.
  const seen = new Set<string>();
  for (const c of ALL_REASON_CODES) {
    assert.ok(!seen.has(c), `duplicate ${c} across domains`);
    seen.add(c);
  }
});

test("reason-codes: decision domain covers all required codes", () => {
  const expected = [
    "rule_denied",
    "rule_allowed",
    "cross_source_unread_conflict",
    "path_unread_hard_deny",
    "path_read_only_read_allowed",
    "path_read_only_action_needs_approval",
    "path_read_write_inner_allowed",
    "path_read_write_outside",
    "network_exfil_dev_socket",
    "tmp_default_allowed",
    "in_project_default_allowed",
    "outside_read_default_allowed",
    "outside_write_needs_approval",
  ];
  assert.deepEqual([...DECISION_REASON_CODES].sort(), [...expected].sort());
});

test("reason-codes: sensitive domain covers all 7 rule codes", () => {
  const expected = [
    "ssh_private_key",
    "private_key_cert",
    "env_credential_store",
    "credential_config",
    "system_credential_config",
    "ssh_public_key",
    "soft_credential_config",
  ];
  assert.deepEqual([...SENSITIVE_REASON_CODES].sort(), [...expected].sort());
});

test("reason-codes: bash domain covers all 15 extractor codes", () => {
  const expected = [
    "control_flow",
    "shell_forwarder",
    "cd_chdir",
    "forwarding_command",
    "find_write_flag",
    "command_substitution",
    "backtick_substitution",
    "process_substitution_input",
    "process_substitution_output",
    "heredoc",
    "subshell",
    "glob_expansion",
    "unresolved_variable",
    "arithmetic",
    "unreliable_command",
  ];
  assert.deepEqual([...BASH_REASON_CODES].sort(), [...expected].sort());
});
