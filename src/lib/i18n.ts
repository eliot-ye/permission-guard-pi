//
// i18n module for permission-guard-pi.
//
// Provides t(code, lang, params?) for looking up localized strings
// for ReasonCode and UI-only codes.
//
// Design principles (see design.md D1-D8):
//   - Only en + zh are supported initially; other languages fall back
//     to English.
//   - Unknown code or unknown lang returns the code itself (fail-safe).
//   - Params use {param} syntax; missing params stay literal.
//   - English bundle is the ultimate fallback (before returning code).
//   - No external i18n framework (avoid dependency bloat).
//
// ReasonCode is a stable cross-version contract; UiCode is stable
// within this project's scope. See reason-codes.ts for type definitions.

import type { ReasonCode, UiCode, Lang } from "./reason-codes.ts";

// Bundle type: complete lookup for all 48 codes.
type Bundle = Record<ReasonCode | UiCode, string>;

// -------- EN bundle --------

const en: Bundle = {
  // Decision reason codes (13)
  rule_denied:
    "Denied by rule {tool}({pattern}) from {source}",
  rule_allowed:
    "Allowed by rule {tool}({pattern}) from {source}",
  cross_source_unread_conflict:
    "Cross-source conflict involving unread for {path} (winner: {permission} from {source}, but another source declares unread)",
  path_unread_hard_deny:
    "Path is hard-denied by {source} config ({raw})",
  path_read_only_read_allowed:
    "Path declared read_only in {source} config; read allowed",
  path_read_only_action_needs_approval:
    "Path declared read_only in {source} config; {action} requires approval",
  path_read_write_inner_allowed:
    "Path declared read_write in {source} config; in-project {action} auto-allowed",
  path_read_write_outside:
    "Path declared read_write in {source} config; outside-project {action} requires approval",
  network_exfil_dev_socket: "Network exfiltration path: {path}",
  tmp_default_allowed: "Temporary directory default: {path}",
  in_project_default_allowed:
    "In-project non-sensitive {action}; auto-allowed",
  outside_read_default_allowed:
    "Outside-project non-sensitive read; auto-allowed",
  outside_write_needs_approval:
    "Outside-project non-sensitive {action}; approval required",

  // Sensitive reason codes (7)
  ssh_private_key: "SSH private key",
  private_key_cert: "Private key / certificate file",
  env_credential_store: "Env file or credential store",
  credential_config: "Credential config",
  system_credential_config: "System credential/config file",
  ssh_public_key: "SSH public key file",
  soft_credential_config: "Soft credential config file",

  // Bash reason codes (14)
  control_flow:
    "Command contains control flow keywords (while/for/if etc.); actual file access depends on runtime variables and cannot be statically determined. Use grep/find or similar tools instead of shell loops; select 'Allow for this session' to avoid repeat prompts",
  shell_forwarder:
    "Command executes via shell forwarder; filesystem access inside the string is invisible to static analysis. Execute the command directly rather than nesting a shell; select 'Allow for this session' to avoid repeat prompts",
  cd_chdir:
    "Command contains cd, changing the working directory for subsequent commands. Use absolute paths; select 'Allow for this session' to avoid repeat prompts",
  forwarding_command:
    "Command uses a forwarding tool (xargs/parallel etc.); downstream args come from upstream stdout, cannot be statically enumerated. Avoid using forwarders after pipes; select 'Allow for this session' to avoid repeat prompts",
  find_write_flag:
    "find command contains write flags (-delete/-exec); cannot statically enumerate target files. Select 'Allow for this session' to avoid repeat prompts",
  command_substitution:
    "Command uses $() command substitution; the inner command cannot be statically analyzed. Select 'Allow for this session' to avoid repeat prompts",
  backtick_substitution:
    "Command uses `backtick` substitution; the inner command cannot be statically analyzed. Select 'Allow for this session' to avoid repeat prompts",
  process_substitution_input:
    "Command uses <(...) process substitution (input); the inner command cannot be statically analyzed. Select 'Allow for this session' to avoid repeat prompts",
  process_substitution_output:
    "Command uses >(...) process substitution (output); the inner command cannot be statically analyzed. Select 'Allow for this session' to avoid repeat prompts",
  heredoc:
    "Command uses unquoted heredoc (<<); content cannot be statically analyzed. Use quoted heredoc (<<'EOF') for literal content; select 'Allow for this session' to avoid repeat prompts",
  subshell:
    "Command uses top-level subshell (...); inner commands cannot be statically analyzed. Select 'Allow for this session' to avoid repeat prompts",
  glob_expansion:
    "Command contains unquoted glob metachars (*, ?, [); cannot statically enumerate target files. Declare the path glob in permission.json, or select 'Allow for this session'",
  unresolved_variable:
    "Command contains unresolved shell variable ${var_name}; cannot statically enumerate target files. Select 'Allow for this session' to avoid repeat prompts",
  arithmetic:
    "Command uses $((...)) arithmetic expansion; result depends on runtime values. Select 'Allow for this session' to avoid repeat prompts",
  unreliable_command:
    "Command form cannot be reliably extracted for static analysis; review the full command. Select 'Allow for this session' to avoid repeat prompts",

  // UI codes (14)
  permission_request_title: "Permission request",
  choice_allow_once: "Allow this call only",
  choice_allow_session: "Allow for this session",
  choice_always_allow: "Always allow (save to trusted.json)",
  choice_always_allow_command:
    "Always allow this command (save to {path})",
  choice_deny: "Deny",
  note_always_allow_saves_to:
    'Note: "Always allow" saves to {path}',
  footer_no_always_allow_available:
    'No "Always allow" option available for this context.',
  notify_deny_hard: "Blocked: {reason} ({path})",
  notify_config_warning: "[permission] config warning: {warning}",
  notify_no_ui_denied:
    "No UI available, denied by default ({reason})",
  notify_persistent_save_failed:
    "Failed to save persistent grant: {error}. Falling back to session-only.",
  notify_bash_persistent_save_failed:
    "Failed to save persistent bash grant: {error}. Falling back to session-only.",
  subtitle_sensitive_hard_not_persistable:
    "Sensitive system path cannot be persisted. To allow permanently, edit permission.json.",
  subtitle_network_exfil_not_persistable:
    "Network exfiltration path cannot be persisted. Every write requires confirmation.",
};

// -------- ZH bundle --------

const zh: Bundle = {
  // Decision reason codes (13)
  rule_denied:
    "被 {source} 的规则 {tool}({pattern}) 拒绝",
  rule_allowed:
    "被 {source} 的规则 {tool}({pattern}) 允许",
  cross_source_unread_conflict:
    "{path} 存在跨源冲突（胜出：{source} 声明为 {permission}，但另一源声明为 unread）",
  path_unread_hard_deny:
    "{source} 配置将路径硬拒绝（{raw}）",
  path_read_only_read_allowed:
    "{source} 配置声明为 read_only；读取放行",
  path_read_only_action_needs_approval:
    "{source} 配置声明为 read_only；{action} 需授权",
  path_read_write_inner_allowed:
    "{source} 配置声明为 read_write；项目内 {action} 自动放行",
  path_read_write_outside:
    "{source} 配置声明为 read_write；项目外 {action} 需授权",
  network_exfil_dev_socket: "网络外带路径：{path}",
  tmp_default_allowed: "临时目录默认放行：{path}",
  in_project_default_allowed:
    "项目内非敏感 {action}；自动放行",
  outside_read_default_allowed:
    "项目外非敏感读取；自动放行",
  outside_write_needs_approval:
    "项目外非敏感 {action}；需授权",

  // Sensitive reason codes (7)
  ssh_private_key: "SSH 私钥",
  private_key_cert: "私钥 / 证书文件",
  env_credential_store: "环境文件或凭证存储",
  credential_config: "凭证配置文件",
  system_credential_config: "系统凭证 / 配置文件",
  ssh_public_key: "SSH 公钥文件",
  soft_credential_config: "可撤销的凭证配置文件",

  // Bash reason codes (14)
  control_flow:
    "该命令包含控制流关键字（while/for/if 等），实际访问文件取决于运行时变量，无法静态确定。建议使用 grep/find 等工具替代 shell 循环；选择「允许本会话」可避免重复弹窗",
  shell_forwarder:
    "该命令通过 shell 转发器执行，字符串内的文件系统访问不可见于静态分析。建议直接执行命令而非嵌套 shell；选择「允许本会话」可避免重复弹窗",
  cd_chdir:
    "该命令包含 cd 命令，改变后续命令的工作目录，无法静态确定实际访问的文件路径。建议使用绝对路径；选择「允许本会话」可避免重复弹窗",
  forwarding_command:
    "该命令使用转发器（xargs/parallel 等），下游参数来自上游 stdout，无法静态枚举。建议避免在管道后使用转发器；选择「允许本会话」可避免重复弹窗",
  find_write_flag:
    "find 命令含写入 flag（-delete/-exec），无法静态枚举目标文件。选择「允许本会话」可避免重复弹窗",
  command_substitution:
    "该命令使用 $() 命令替换，内部命令无法静态分析。选择「允许本会话」可避免重复弹窗",
  backtick_substitution:
    "该命令使用反引号 `...` 替换，内部命令无法静态分析。选择「允许本会话」可避免重复弹窗",
  process_substitution_input:
    "该命令使用 <(...) 进程替换（输入），内部命令无法静态分析。选择「允许本会话」可避免重复弹窗",
  process_substitution_output:
    "该命令使用 >(...) 进程替换（输出），内部命令无法静态分析。选择「允许本会话」可避免重复弹窗",
  heredoc:
    "该命令使用未加引号的 heredoc（<<），内容无法静态分析。使用带引号的 heredoc（<<'EOF'）可表示字面量内容；选择「允许本会话」可避免重复弹窗",
  subshell:
    "该命令使用顶层子 shell (...)，内部命令无法静态分析。选择「允许本会话」可避免重复弹窗",
  glob_expansion:
    "该命令含未加引号的 glob 通配符（* / ? / [），无法静态枚举目标文件。请在 permission.json 中声明该路径 glob，或选择「允许本会话」",
  unresolved_variable:
    "该命令包含未解析的 shell 变量 ${var_name}，无法静态枚举目标文件。选择「允许本会话」可避免重复弹窗",
  arithmetic:
    "该命令使用 $((...)) 算术扩展，结果取决于运行时值。选择「允许本会话」可避免重复弹窗",
  unreliable_command:
    "该命令形态无法通过静态分析可靠提取访问目标，请审阅整条命令。选择「允许本会话」可避免重复弹窗",

  // UI codes (14)
  permission_request_title: "权限请求",
  choice_allow_once: "仅允许本次调用",
  choice_allow_session: "允许本会话",
  choice_always_allow: "总是允许（保存到 trusted.json）",
  choice_always_allow_command: "总是允许本命令（保存到 {path}）",
  choice_deny: "拒绝",
  note_always_allow_saves_to: '注：「总是允许」将保存到 {path}',
  footer_no_always_allow_available:
    "本上下文中没有「总是允许」选项。",
  notify_deny_hard: "已阻断：{reason}（{path}）",
  notify_config_warning: "[permission] 配置警告：{warning}",
  notify_no_ui_denied: "无 UI 可用，默认拒绝（{reason}）",
  notify_persistent_save_failed:
    "保存持久授权失败：{error}。降级为仅会话内授权。",
  notify_bash_persistent_save_failed:
    "保存持久 bash 命令授权失败：{error}。降级为仅会话内授权。",
  subtitle_sensitive_hard_not_persistable:
    "敏感系统路径不能持久化。如需长期允许，请编辑 permission.json。",
  subtitle_network_exfil_not_persistable:
    "网络外带路径不能持久化。每次写入都需确认。",
};

// -------- Bundle map --------

const bundles: Record<Lang, Bundle> = {
  en,
  zh,
};

// -------- t() function --------

export function t(
  code: ReasonCode | UiCode,
  lang: Lang,
  params?: Record<string, string>,
): string {
  // 1. Look up in requested lang.
  const requested = bundles[lang]?.[code];
  if (requested !== undefined) {
    return params ? substitute(requested, params) : requested;
  }

  // 2. Fallback to English if requested lang is unknown or code missing.
  const english = bundles.en[code];
  if (english !== undefined) {
    return params ? substitute(english, params) : english;
  }

  // 3. Code-itself safety net (should never happen in prod — bundles
  //    are complete for en and zh).
  return code;
}

// -------- Param substitution --------

function substitute(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? `{${key}}`);
}

// -------- Exported helpers (for tests / debugging) --------

export const EN_BUNDLE: Readonly<Bundle> = en;
export const ZH_BUNDLE: Readonly<Bundle> = zh;

// Total code count (all 3 domains + UI).
export const TOTAL_CODE_COUNT = 50;
