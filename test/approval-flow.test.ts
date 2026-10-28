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
import { t } from "../src/lib/i18n.ts";
import { detectLang } from "../src/lib/lang-detect.ts";
import type { ReasonCode, UiCode } from "../src/lib/reason-codes.ts";

const lang = detectLang(process.env, {});
const testT = (code: ReasonCode | UiCode, params?: Record<string, string>) =>
  t(code, lang, params);

// AF-CDC-01: cd_chdir reason must produce a subtitle that names the cd
// command and points the user at the "allow for this session" remediation.
test("AF-CDC-01: bashSubtitleForReason_cd_chdir_returns_cwd_disclaimer", () => {
  const subtitle = bashSubtitleForReason("cd_chdir", lang);
  assert.ok(subtitle.length > 0, "subtitle must be non-empty");
  // The zh bundle says "该命令包含 cd 命令"; the en bundle says "This command
  // contains a `cd` command". The localized text is language-dependent, so
  // we assert on the code's key term (localized) rather than a hardcoded
  // language string.
  const cdText = testT("cd_chdir");
  assert.ok(
    subtitle.includes(cdText.split("；")[0].slice(0, 12)),
    `subtitle should name the cd command; got: "${subtitle}"`,
  );
  assert.ok(
    subtitle.length > 30,
    `subtitle should have a substantive length; got: "${subtitle}"`,
  );
});

// AF-CDC-02: cd_chdir subtitle must be distinct from the shell_forwarder,
// forwarding_command, and control_flow subtitles — the user should not see a
// generic "unparseable" message that misnames the actual cause.
test("AF-CDC-02: bashSubtitleForReason_cd_chdir_disjoint_from_others", () => {
  const cdSubtitle = bashSubtitleForReason("cd_chdir", lang);
  const otherReasons = ["shell_forwarder", "forwarding_command", "control_flow"];
  for (const r of otherReasons) {
    const other = bashSubtitleForReason(r, lang);
    assert.notEqual(
      cdSubtitle,
      other,
      `cd_chdir subtitle must differ from ${r} subtitle`,
    );
  }
});
