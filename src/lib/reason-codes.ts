//
// ReasonCode definitions for i18n.
//
// ReasonCode is a stable cross-version contract: once a code is
// introduced, it is never renamed. New codes may be added (independent
// change), but existing codes must remain semantically stable.
//
// Naming convention (settled in ui-i18n explore/design D2):
//   - snake_case (matches existing GrantSource style)
//   - No domain prefix (3 domains have disjoint namespaces; prefix
//     would be redundant visual noise)
//   - Past tense for event-describing codes (rule_denied, not
//     rule_deny)
//
// 3 domains, 27 codes total:
//   - DecisionReasonCode: 13 codes produced by decide()
//   - SensitiveReasonCode: 7 codes produced by sensitive rules
//   - BashReasonCode: 14 codes produced by extractBashTargets()
//
// The i18n module (src/lib/i18n.ts) provides en/zh bundles for each
// code. UI layer looks up bundles by code + lang; audit layer keeps
// using the stable English `reason` string (see design.md D3).

// -------- Lang type --------

// Supported languages. Unknown values fall back to "en" at the
// detectLang layer (see lang-detect.ts). Extending this union requires
// adding a new bundle in i18n.ts.
export type Lang = "en" | "zh";

// -------- Decision domain --------

// Reason codes for `decide()` outcomes. Each maps 1:1 to a Decision
// branch in src/lib/decision.ts.
export type DecisionReasonCode =
  | "rule_denied" // deny rule match (hard deny)
  | "rule_allowed" // allow rule match (auto-allow non-sensitive)
  | "cross_source_unread_conflict" // unread-involved cross-source conflict
  | "path_unread_hard_deny" // config declared unread (hard deny)
  | "path_read_only_read_allowed" // config read_only, action=read
  | "path_read_only_action_needs_approval" // config read_only, action=write/delete
  | "path_read_write_inner_allowed" // config read_write, in-project
  | "path_read_write_outside" // config read_write, outside-project
  | "network_exfil_dev_socket" // /dev/tcp, /dev/udp, /dev/fd/[0-9]+ write
  | "tmp_default_allowed" // /tmp/** default writable
  | "in_project_default_allowed" // unconfigured in-project non-sensitive
  | "outside_read_default_allowed" // unconfigured outside-project read
  | "outside_write_needs_approval"; // unconfigured outside-project write/delete

// -------- Sensitive domain --------

// Reason codes for SensitiveRule entries. Each maps 1:1 to a rule in
// DEFAULT_SENSITIVE_RULES. These are also referenced from decision.ts
// (sensitive fallback branch) via the `sensitive` rule's code field.
export type SensitiveReasonCode =
  | "ssh_private_key"
  | "private_key_cert"
  | "env_credential_store"
  | "credential_config"
  | "system_credential_config"
  | "ssh_public_key"
  | "soft_credential_config";

// -------- Bash domain --------

// Reason codes for extractBashTargets() unreliable outcomes. Each
// maps to a specific reason value the extractor produces. Complete
// list after T2 grep audit of bash-extract.ts + test assertions.
export type BashReasonCode =
  | "control_flow" // while/for/if/case keywords
  | "shell_forwarder" // bash -c, sh -c, source, etc.
  | "cd_chdir" // cd / chdir changes cwd
  | "forwarding_command" // xargs/parallel piping
  | "find_write_flag" // find -delete/-exec
  | "command_substitution" // $(...) with non-read-only inner
  | "backtick_substitution" // `...` (backtick) substitution
  | "process_substitution_input" // <(...)
  | "process_substitution_output" // >(...)
  | "heredoc" // unquoted << (quoted <<'EOF' is safe)
  | "subshell" // (...) top-level subshell
  | "glob_expansion" // unquoted *, ?, [ metachars (non-bounded)
  | "unresolved_variable" // $VAR / ${VAR} not statically resolvable
  | "arithmetic" // $((...)) arithmetic expansion
  | "unreliable_command"; // fallback when command form can't be analyzed

// Note: `unresolved_variable` corresponds to extractor reason strings
// of the form `"unresolved variable: <var_name>"` — the variable name
// is a runtime param, not part of the code itself.

// -------- Combined type --------

// Full ReasonCode union used by i18n bundle lookup for ReasonCode domain.
export type ReasonCode = DecisionReasonCode | SensitiveReasonCode | BashReasonCode;

// -------- UI code (not a ReasonCode) --------
//
// UI codes are for strings that appear in the permission dialog, notify
// messages, and footers/titles. They are NOT derived from decision or
// extractor — they are static UI labels and structural strings. Kept
// separate from ReasonCode to preserve the 27-code stable contract.
//
// UI codes are still stable but the scope is smaller (14 codes) and
// they don't share cross-version audit semantics with ReasonCode.

export type UiCode =
  // Dialog title
  | "permission_request_title"
  // Dialog choices
  | "choice_allow_once"
  | "choice_allow_session"
  | "choice_always_allow"
  | "choice_always_allow_command"
  | "choice_deny"
  // Footer/note
  | "note_always_allow_saves_to"
  | "footer_no_always_allow_available"
  // Notify messages (deny_hard, config_warning, save failures)
  | "notify_deny_hard"
  | "notify_config_warning"
  | "notify_no_ui_denied"
  | "notify_persistent_save_failed"
  | "notify_bash_persistent_save_failed"
  // Sensitive tier=two subtitle
  | "subtitle_sensitive_hard_not_persistable"
  | "subtitle_network_exfil_not_persistable"
  // permission-toggle (P3): /permission command + footer status marker
  | "permission_status_enabled"
  | "permission_status_disabled"
  | "permission_cmd_usage"
  | "permission_cmd_current"
  | "permission_cmd_toggled_on"
  | "permission_cmd_toggled_off"
  | "permission_cmd_write_failed";

// -------- Code tables (single source of truth for validation) --------

export const DECISION_REASON_CODES: readonly DecisionReasonCode[] = [
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

export const SENSITIVE_REASON_CODES: readonly SensitiveReasonCode[] = [
  "ssh_private_key",
  "private_key_cert",
  "env_credential_store",
  "credential_config",
  "system_credential_config",
  "ssh_public_key",
  "soft_credential_config",
];

export const BASH_REASON_CODES: readonly BashReasonCode[] = [
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

export const ALL_REASON_CODES: readonly ReasonCode[] = [
  ...DECISION_REASON_CODES,
  ...SENSITIVE_REASON_CODES,
  ...BASH_REASON_CODES,
];

// -------- Runtime checks (used by tests) --------

// Every code must be snake_case: lowercase letters + digits + underscore,
// starts with a lowercase letter.
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

export function isSnakeCase(code: string): boolean {
  return SNAKE_CASE_RE.test(code);
}
