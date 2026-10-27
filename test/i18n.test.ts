//
// TDD RED: i18n tests.
//
// Verifies t() lookup semantics:
//   - All 48 codes exist in en and zh bundles
//   - zh bundle has no English fallback (all real Chinese text)
//   - Param substitution works
//   - Unknown code falls back to English then to code itself
//   - Unknown lang falls back to English

import { test } from "node:test";
import assert from "node:assert/strict";

import { t, EN_BUNDLE, ZH_BUNDLE, TOTAL_CODE_COUNT } from "../src/lib/i18n.ts";
import { ALL_REASON_CODES } from "../src/lib/reason-codes.ts";

// The UI codes (not part of ALL_REASON_CODES).
const UI_CODES = [
  "permission_request_title",
  "choice_allow_once",
  "choice_allow_session",
  "choice_always_allow",
  "choice_always_allow_command",
  "choice_deny",
  "note_always_allow_saves_to",
  "footer_no_always_allow_available",
  "notify_deny_hard",
  "notify_config_warning",
  "notify_no_ui_denied",
  "notify_persistent_save_failed",
  "notify_bash_persistent_save_failed",
  "subtitle_sensitive_hard_not_persistable",
  "subtitle_network_exfil_not_persistable",
] as const;

const ALL_CODES = [...ALL_REASON_CODES, ...UI_CODES];

test("i18n: total code count is 50", () => {
  assert.equal(TOTAL_CODE_COUNT, 50);
  assert.equal(ALL_CODES.length, 50);
});

test("i18n: en bundle covers all 50 codes", () => {
  for (const code of ALL_CODES) {
    const val = (EN_BUNDLE as any)[code];
    assert.ok(val !== undefined, `en bundle missing ${code}`);
    assert.ok(typeof val === "string" && val.length > 0, `${code} must be non-empty`);
  }
});

test("i18n: zh bundle covers all 50 codes", () => {
  for (const code of ALL_CODES) {
    const val = (ZH_BUNDLE as any)[code];
    assert.ok(val !== undefined, `zh bundle missing ${code}`);
    assert.ok(typeof val === "string" && val.length > 0, `${code} must be non-empty`);
  }
});

test("i18n: zh bundle is Chinese (contains at least one CJK char per code)", () => {
  // CJK Unicode range: \u4e00-\u9fff
  const CJK_RE = /[\u4e00-\u9fff]/;
  for (const code of ALL_CODES) {
    const val = (ZH_BUNDLE as any)[code];
    assert.ok(CJK_RE.test(val), `zh ${code} must contain CJK chars: ${val}`);
  }
});

test("i18n: t returns en text for lang=en", () => {
  assert.equal(t("permission_request_title", "en"), "Permission request");
  assert.equal(t("choice_allow_once", "en"), "Allow this call only");
  assert.equal(t("choice_deny", "en"), "Deny");
});

test("i18n: t returns zh text for lang=zh", () => {
  assert.equal(t("permission_request_title", "zh"), "权限请求");
  assert.equal(t("choice_allow_once", "zh"), "仅允许本次调用");
  assert.equal(t("choice_deny", "zh"), "拒绝");
});

test("i18n: param substitution works for decision codes", () => {
  const result = t("rule_denied", "en", {
    tool: "bash",
    pattern: "rm *",
    source: "project",
  });
  assert.equal(result, "Denied by rule bash(rm *) from project");
});

test("i18n: param substitution works for zh codes", () => {
  const result = t("path_read_only_action_needs_approval", "zh", {
    source: "全局",
    action: "写",
  });
  assert.ok(result.includes("全局"));
  assert.ok(result.includes("写"));
  assert.ok(result.includes("read_only"));
});

test("i18n: unresolved_variable substitution includes variable name", () => {
  const result = t("unresolved_variable", "zh", { var_name: "MYSECRETS" });
  assert.ok(result.includes("MYSECRETS"));
  assert.ok(result.includes("未解析"));
});

test("i18n: missing param stays literal", () => {
  const result = t("path_unread_hard_deny", "en", { source: "project" });
  // {raw} is missing → stays literal
  assert.ok(result.includes("{raw}"));
  assert.ok(result.includes("project"));
});

test("i18n: unknown code returns code itself (en fallback then safety net)", () => {
  // Cast to bypass TS type; test the runtime behavior.
  const result = t("nonexistent_code" as any, "en");
  assert.equal(result, "nonexistent_code");
});

test("i18n: unknown lang falls back to English", () => {
  // Cast to bypass TS type; test the runtime behavior.
  const result = t("permission_request_title" as any, "fr" as any);
  assert.equal(result, "Permission request");
});

test("i18n: sensitive reason codes have consistent meaning across langs", () => {
  // ssh_private_key: both langs should mention SSH
  assert.ok(t("ssh_private_key", "en").includes("SSH"));
  assert.ok(t("ssh_private_key", "zh").includes("SSH"));
});

test("i18n: bash reason codes give guidance to avoid repeat prompts", () => {
  const zh = t("control_flow", "zh");
  assert.ok(zh.includes("允许本会话"), "zh control_flow should mention 允许本会话");

  const en = t("control_flow", "en");
  assert.ok(en.includes("Allow for this session"), "en control_flow should mention session allow");
});
