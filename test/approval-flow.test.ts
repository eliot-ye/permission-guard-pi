//
// TDD: approval-flow coverage for bashSubtitleForReason (extensions/index.ts).
//
// bash-hardening-round-2 introduces a new reason string `cd_chdir` for
// compound bash commands whose fragment starts with `cd` (L3). The tier=two
// prompt must present a subtitle that names the cwd change explicitly so the
// user understands why the command cannot be statically resolved.
//
// This file establishes the FIRST test coverage for bashSubtitleForReason —
// before bash-hardening-round-2 the function had no test file at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bashSubtitleForReason } from "../extensions/index.ts";

// AF-CDC-01: cd_chdir reason must produce a subtitle that names the cd
// command and points the user at the "allow for this session" remediation.
test("AF-CDC-01: bashSubtitleForReason_cd_chdir_returns_cwd_disclaimer", () => {
  const subtitle = bashSubtitleForReason("cd_chdir");
  assert.ok(subtitle.length > 0, "subtitle must be non-empty");
  assert.ok(
    subtitle.includes("cd 命令"),
    `subtitle should name the cd command; got: "${subtitle}"`,
  );
  assert.ok(
    subtitle.includes("会话内允许"),
    `subtitle should point at session-scoped remediation; got: "${subtitle}"`,
  );
});

// AF-CDC-02: cd_chdir subtitle must be distinct from the shell_forwarder,
// forwarding_command, and control_flow subtitles — the user should not see a
// generic "unparseable" message that misnames the actual cause.
test("AF-CDC-02: bashSubtitleForReason_cd_chdir_disjoint_from_others", () => {
  const cdSubtitle = bashSubtitleForReason("cd_chdir");
  const otherReasons = ["shell_forwarder", "forwarding_command", "control_flow"];
  for (const r of otherReasons) {
    const other = bashSubtitleForReason(r);
    assert.notEqual(
      cdSubtitle,
      other,
      `cd_chdir subtitle must differ from ${r} subtitle`,
    );
  }
});
