//
// TDD: grant-memory coverage for bashPermissionForReason (extensions/index.ts).
//
// bash-hardening-round-2 introduces a new reason string `cd_chdir` for
// compound bash commands whose fragment starts with `cd` (L3). A `cd_chdir`
// prompt's "Always allow" grant must be keyed as `read_write` so a future
// stricter decision layer can still gate the grant, matching the treatment
// of shell_forwarder / forwarding_command / control_flow.
//
// This file establishes the FIRST test coverage for bashPermissionForReason —
// before bash-hardening-round-2 the function had no test file at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bashPermissionForReason } from "../extensions/index.ts";

// GM-CDC-01: cd_chdir must map to read_write. `cd` changes the cwd baseline
// for downstream fragments whose paths cannot be statically resolved against
// projectRoot, so the grant must not be treated as read-only.
test("GM-CDC-01: bashPermissionForReason_cd_chdir_maps_to_read_write", () => {
  assert.equal(bashPermissionForReason("cd_chdir"), "read_write");
});

// Sanity: the other "write-capable" reasons should still map to read_write.
// This is a regression guard — if a future refactor accidentally narrows
// the switch to only match `cd_chdir`, this test catches it.
test("GM-CDC-01b: other_write_capable_reasons_still_map_to_read_write", () => {
  const reasons = [
    "shell_forwarder",
    "forwarding_command",
    "control_flow",
    "command_substitution",
    "backtick_substitution",
    "process_substitution_input",
    "process_substitution_output",
    "heredoc",
    "subshell",
  ];
  for (const r of reasons) {
    assert.equal(
      bashPermissionForReason(r),
      "read_write",
      `${r} must map to read_write`,
    );
  }
});

// Sanity: read-only-adjacent reasons still map to read_only.
test("GM-CDC-01c: read_only_adjacent_reasons_still_map_to_read_only", () => {
  assert.equal(bashPermissionForReason("glob_expansion"), "read_only");
  assert.equal(
    bashPermissionForReason("unresolved variable: FOO"),
    "read_only",
  );
});
