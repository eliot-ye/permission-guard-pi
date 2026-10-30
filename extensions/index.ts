/**
 * permission-guard-pi
 *
 * Layered, configurable file-access control for pi-coding-agent.
 *
 * Semantic overview:
 *   - Three config sources: global (~/.pi/agent/permission.json) > project
 *     (<proj>/.pi/permission.json) > local (<proj>/.pi/local/permission.json)
 *   - Three permissions: read_write / read_only / unread
 *   - Prompt tiers: three (config-declared path) vs two (unconfigured)
 *   - Two-tier memory: session (in-memory) + persistent (trusted.json on disk)
 *   - Cross-source conflict detection: unread-involved conflicts → three-tier
 *     prompt; other conflicts → silent local override
 *   - JSONL audit log at ~/.pi/agent/extensions/permission-guard-pi/logs/
 *
 * Design decisions (see design.md D1, D10, D11):
 *   - decide() is a pure function; memory lookup is done here in extension
 *   - projectHash uses sha256 of normalized path (12 hex chars)
 *   - persistent writes are atomic (temp + rename); audit writes are serialized
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  configLocations,
  loadConfigFile,
  mergePolicies,
  type MergedPolicy,
  type RawConfig,
} from "../src/lib/config.ts";
import {
  expandHome,
  toAbsolutePath,
  isInside,
  tryRealpath,
  hashProject,
  prettyPath,
} from "../src/lib/path-utils.ts";
import { findSensitiveMatch } from "../src/lib/sensitive.ts";
import { createTrustStore, type TrustStore } from "../src/lib/trust.ts";
import { createAuditLogger, type AuditLogger } from "../src/lib/audit.ts";
import { extractBashTargets, tokenizeBashCommand, looksLikePathToken, type ExtractResult } from "../src/lib/bash-extract/index.ts";
import { decide, type Decision } from "../src/lib/decision.ts";
import { t } from "../src/lib/i18n.ts";
import type { Lang, BashReasonCode, ReasonCode, UiCode } from "../src/lib/reason-codes.ts";
import { detectLang } from "../src/lib/lang-detect.ts";
import { loadSettings, saveSettings } from "../src/lib/settings.ts";

// -------- Config for the extension registration --------

export interface PermissionExtensionOptions {
  // Directory where trusted.json lives. Default: ~/.pi/agent/extensions/permission-guard-pi
  trustedDir: string;
  // Locations of the three config files. Defaults are provided via configLocations().
  configPaths?: {
    global: string;
    project: string;
    local: string;
  };
  // Optional override for trusted.json filename (default: trusted.json).
  trustedFileName?: string;
}

// -------- Session state --------

interface SessionState {
  policy: MergedPolicy;
  warnings: string[];
  projectHash: string;
  projectRoot: string;
  trust: TrustStore;
  audit: AuditLogger;
  configWarningEmitted: boolean;
  // UI language (ui-i18n T5). Read once at session start from $PI_LANG /
  // settings.json / $LANG, in that priority order. Absent at all sources
  // falls back to "en".
  lang: Lang;
  // permission-toggle (P3): overall gate enable/disable. Read from
  // settings.json at session start; `false` disables the whole gate
  // (tool_call returns undefined — pi handles calls natively). Absent →
  // true (fail-safe). Updated by /permission command.
  enabled: boolean;
}

// -------- Type aliases for the extension surface --------

interface PictxLike {
  hasUI: boolean;
  cwd: string;
  ui?: {
    select: (prompt: string, choices: string[]) => Promise<string>;
    notify: (message: string, level: "info" | "warning" | "error") => void;
    input: (prompt: string, defaultValue?: string) => Promise<string>;
    setStatus: (key: string, text: string | undefined) => void;
  };
}

interface ToolCallEventLike {
  toolCallId: string;
  toolName: string;
  input: Record<string, any>;
}

interface ToolCallResultLike {
  block?: boolean;
  reason?: string;
}

// -------- Config loading --------

async function loadAllConfigs(opts: PermissionExtensionOptions, projectRoot: string) {
  const defaults = configLocations(
    join(homedir(), ".pi/agent"),
    projectRoot,
  );
  const paths = opts.configPaths ?? {
    global: defaults.globalConfigPath,
    project: defaults.projectConfigPath,
    local: defaults.localConfigPath,
  };
  const { global, project, local } = paths;
  const [gRes, pRes, lRes] = await Promise.all([
    loadConfigFile(global),
    loadConfigFile(project),
    loadConfigFile(local),
  ]);
  const { policy, warnings } = mergePolicies(gRes.raw, pRes.raw, lRes.raw, projectRoot);
  const allWarnings = [
    ...gRes.error ? [gRes.error] : [],
    ...pRes.error ? [pRes.error] : [],
    ...lRes.error ? [lRes.error] : [],
    ...warnings,
  ];
  return { policy, warnings: allWarnings };
}

// -------- Session initialization --------

async function initSession(ctx: PictxLike, opts: PermissionExtensionOptions): Promise<SessionState> {
  const projectRoot = (ctx as any).projectRoot ?? ctx.cwd;
  const { policy, warnings } = await loadAllConfigs(opts, projectRoot);
  const projectHash = hashProject(projectRoot);
  const trustedFileName = opts.trustedFileName ?? "trusted.json";
  const trustedPath = join(opts.trustedDir, trustedFileName);
  const auditLogPath = join(opts.trustedDir, "logs", "permission-review.jsonl");

  const trust = await createTrustStore(trustedPath);
  const audit = createAuditLogger(auditLogPath);

  // i18n T5: read settings.json + detect lang at session start. Once
  // computed, lang is stable for the whole session (design.md D7).
  const settings = await loadSettings(opts.trustedDir);
  const lang = detectLang(process.env, settings);
  // permission-toggle (P3): absent enabled → true (fail-safe).
  const enabled = settings.enabled !== false;

  return {
    policy,
    warnings,
    projectHash,
    projectRoot,
    trust,
    audit,
    configWarningEmitted: false,
    lang,
    enabled,
  };
}

// -------- Prompt UI --------

type UserChoice = "allow_once" | "allow_session" | "allow_persistent" | "deny";

/**
 * Derive the audit-log `grant_source` for a real-human prompt decision
 * (design.md D4). The meaning is "what source triggered this prompt" —
 * not "where did the human's grant land" (the human IS the grantor).
 *
 * Mapping:
 *   - Bash-command prompt → "bash_grant_memory" (session/persistent
 *     bash grants land in bash command memory keyed by rawCommand).
 *   - Path-based prompt on a config-declared path → "config_declaration"
 *   - Path-based prompt on an unconfigured/default/sensitive_default path
 *     → "default".
 *
 * Helper used only inside handlePromptDecision's audit.log call sites
 * to keep the 7 sites consistent and readable.
 */
function promptGrantSource(
  decision: Extract<Decision, { kind: "prompt" }>,
  bashCommand: string | null,
  bashReason: string | undefined,
): "config_declaration" | "default" | "bash_grant_memory" {
  if (bashCommand && bashReason) return "bash_grant_memory";
  if (decision.declaration === "read_write" || decision.declaration === "read_only") {
    return "config_declaration";
  }
  return "default";
}

/**
 * Map an extraction reason string to the permission level that should be
 * attached to a bash-command grant. Read-only-adjacent reasons get
 * `read_only`; the rest (which may involve shell forwarders or control flow
 * that could mutate state) get `read_write` so that a future stricter
 * decision layer can still gate them.
 */
export function bashPermissionForReason(reason: string | undefined): "read_only" | "read_write" {
  // Device redirects, forwarders, command substitution, shell forwarders,
  // and other constructs we flagged as unreliable all imply at worst read
  // access (the extractor chose to treat them as opaque), but "bash -c ..."
  // and "find | xargs rm" can actually write — be conservative and default
  // to read_write for anything not in the read-only-adjacent list.
  // NB: the extractor emits unresolved-variable reasons as
  // "unresolved variable: <name>" (with a colon + the variable name),
  // so this uses prefix matching instead of literal equality.
  if (reason === "glob_expansion" || (reason ?? "").startsWith("unresolved variable:")) {
    return "read_only";
  }
  switch (reason) {
    case "shell_forwarder":
    case "forwarding_command":
    case "control_flow":
    case "command_substitution":
    case "backtick_substitution":
    case "process_substitution_input":
    case "process_substitution_output":
    case "heredoc":
    case "subshell":
      return "read_write";
    // bash-hardening-round-2 (L3): a compound command that includes `cd`
    // changes the cwd baseline for subsequent fragments, so the actual file
    // paths accessed cannot be statically resolved against projectRoot.
    // Conservatively treat as read_write so a future stricter decision
    // layer still gates it.
    case "cd_chdir":
      return "read_write";
    default:
      // Unknown reason: be conservative.
      return "read_write";
  }
}

/**
 * Map a raw extractor reason string to a stable BashReasonCode.
 * Some extractor reasons carry runtime params (e.g. `unresolved variable: X`);
 * we strip the param and return the code, keeping the param separately.
 *
 * Returns [code, params] so bashSubtitleForReason can inject the param
 * into the localized subtitle.
 */
function bashReasonCodeAndParams(
  reason: string | undefined,
): [BashReasonCode, Record<string, string>] {
  if (!reason) return ["unreliable_command", {}];
  if (reason === "unresolved variable" || /^unresolved variable:\s*/.test(reason)) {
    const m = /^unresolved variable:\s*(\S+)$/.exec(reason);
    return ["unresolved_variable", { var_name: m ? m[1] : "" }];
  }
  // Direct code match — all other bash-extract reasons are exact codes.
  const codes = new Set<string>([
    "control_flow", "shell_forwarder", "cd_chdir", "forwarding_command",
    "find_write_flag", "command_substitution", "backtick_substitution",
    "process_substitution_input", "process_substitution_output", "heredoc",
    "subshell", "glob_expansion", "arithmetic", "unreliable_command",
  ] as const);
  if (codes.has(reason)) {
    return [reason as BashReasonCode, {}];
  }
  // Fallback for anything we didn't map.
  return ["unreliable_command", {}];
}

/**
 * Build a subtitle for a bash command prompt. ui-i18n T5: text comes
 * from the i18n bundle (t()), not hardcoded strings. Params like the
 * variable name for unresolved_variable are injected via params.
 */
export function bashSubtitleForReason(
  reason: string | undefined,
  lang: Lang,
): string {
  const [code, params] = bashReasonCodeAndParams(reason);
  return t(code, lang, params);
}

async function promptUser(
  ctx: PictxLike,
  tier: "three" | "two",
  message: string,
  trustedPath: string,
  subtitle?: string,
  bashReason?: string | null,
  lang: Lang = "en",
): Promise<UserChoice> {
  if (!ctx.hasUI || !ctx.ui) return "deny";

  // ui-i18n T5: all visible strings come from t() bundle lookup. Choice
  // matching uses the localized string to preserve behavior.
  const title = `${t("permission_request_title" as UiCode, lang)}\n\n${message}`;
  const optAllowOnce = t("choice_allow_once" as UiCode, lang);
  const optAllowSession = t("choice_allow_session" as UiCode, lang);
  const optDeny = t("choice_deny" as UiCode, lang);

  if (tier === "three") {
    const optAlwaysAllow = t("choice_always_allow" as UiCode, lang);
    const optAlwaysAllowCmd = t("choice_always_allow_command" as UiCode, lang, {
      path: prettyPath(trustedPath),
    });
    // Prefix that covers both variants across languages. In English the
    // prefix is "Always allow"; in Chinese "总是允许" covers both the
    // path-persistent form ("总是允许（保存到 ...）") and the bash-command
    // form ("总是允许本命令（保存到 ...）").
    const optAlwaysAllowPrefix = lang === "en" ? "Always allow" : "总是允许";
    const choices = bashReason
      ? [optAllowOnce, optAllowSession, optAlwaysAllowCmd, optDeny]
      : [optAllowOnce, optAllowSession, optAlwaysAllow, optDeny];
    const noteLine = bashReason
      ? `\n\n${subtitle ?? ""}`
      : `\n\n${t("note_always_allow_saves_to" as UiCode, lang, { path: prettyPath(trustedPath) })}`;
    const choice = await ctx.ui.select(`${title}${noteLine}`, choices);
    // Match by identity for the stable choices; always-allow matches by
    // prefix so both variants map to `allow_persistent` (regardless of
    // lang, and regardless of which variant was selected).
    if (choice === optAllowOnce) return "allow_once";
    if (choice === optAllowSession) return "allow_session";
    if (choice.startsWith(optAlwaysAllowPrefix)) return "allow_persistent";
    return "deny";
  }

  // tier=two: path-based sensitive-default + dev-socket writes only.
  // Never offers "Always allow" — leaking a private key or writing to a
  // dev-socket is not recoverable by rotating a token, so persisting the
  // permission would be a permanent hole.
  const footer = subtitle
    ? `${subtitle}`
    : t("footer_no_always_allow_available" as UiCode, lang);

  const choice = await ctx.ui.select(
    `${title}\n\n${footer}`,
    [optAllowOnce, optAllowSession, optDeny],
  );
  if (choice === optAllowOnce) return "allow_once";
  if (choice === optAllowSession) return "allow_session";
  return "deny";
}

// -------- Grant lookup --------

/**
 * Returns true if either session or persistent grant exists for (project, action, path).
 *
 * Precedence rule (documented per code review note): a persistent grant on
 * action=X overrides the current config declaration for that action only.
 * Rationale: the user explicitly chose "Always allow" for that specific
 * (project, action, path) tuple - their intent wins even if the config
 * changes later. To revoke, edit trusted.json directly. This is documented
 * in the README under "Prompt tiers".
 */
function hasGrant(
  state: SessionState,
  action: "read" | "write" | "delete",
  absPath: string,
): boolean {
  return (
    state.trust.hasSessionGrant(state.projectHash, action, absPath) ||
    state.trust.hasPersistentGrant(state.projectHash, action, absPath)
  );
}

// -------- Prompt guardrails for the LLM --------

// The bash extractor is quote-aware (see bash-extract.ts scanUnreliable).
// Pipelines like `grep x | sort | head` are now parsed per-stage, and
// quoted literals (`grep -E "foo|bar"`) no longer trip the unreliable
// scanner. The remaining tier=two prompts come from a small set of
// constructs that truly cannot be statically analyzed:
//   - Forwarders (xargs, parallel, pforeach) in non-first pipeline stages
//   - Command substitution ($( ... ) outside the read-only helper
//     whitelist, backtick)
//   - Process substitution <(...) / >(...)
//   - Heredocs <<EOF
//   - Unquoted globs (* ? [) outside quotes
//   - Unresolved user variables ($X other than $HOME/$PWD)
//
// Rather than rely on the LLM to figure these out after the fact, we seed
// the system prompt with a short guardrail list at before_agent_start so
// the model reaches for the read/grep/find tools first and only falls
// back to bash when necessary.
//
// We mutate systemPromptOptions.promptGuidelines in place. Per
// docs/extensions.md, that lets pi append a transcript delta for the current
// run without replacing the whole system prompt (which would drop the tools
// list, skills, cwd, and any other extension's guidance).
//
// Keep this list in sync with the actual extractor tables in
// src/lib/bash-extract/silent.ts (SILENT_COMMANDS / UNRELIABLE_COMMANDS)
// and scan.ts (SUBSTITUTION_READONLY_CMDS). Drift here misleads the LLM:
// "silent" claims for commands that actually prompt (rg/jq/cargo) defeat
// the noise-reduction goal; "always prompt" claims for commands that are
// actually silent ($(basename)) make the LLM avoid useful paths.
const BASH_GUARDRAILS: string[] = [
  // ── Layer 1: 决策层 ────────────────────────────────────────────────
  // 显式说明"弹窗是噪音"的动机，让 LLM 主动选静默路径而非被动避坑。
  "Permission model: a permission extension auto-allows most static bash " +
    "commands and prompts you for confirmation on the rest. **Minimize " +
    "prompts — each one interrupts the user.** The layers below are " +
    "ordered silent-first; prefer the tools in layer 2 over bash, and " +
    "layer 3 lists constructs that always prompt.",

  // ── Layer 2: 静默工具清单 ──────────────────────────────────────────
  // 正向引导前置。保守列名：只点 read/grep/find 三个 pi 通用短名，
  // 不点 edit_file/write_file/glob 等（避免假设 pi 工具名与实际不符）。
  "Prefer dedicated tools over bash whenever they cover the need:",
  "- Read files: `read` (use offset/limit for large files)",
  "- Search contents: `grep` (handles patterns like `- [ ]` without quoting)",
  "- List files: `find`",
  "- Inspect git state: `git status`, `git diff`, `git log --stat`",
  "- Run checks/tests: `npm test`, `tsc --noEmit`, `go vet`",
  "- In-project read-only glob (auto-allowed): `ls openspec/*`, " +
    "`find . -name '*.ts'`, `cat src/a.ts`, `wc -l src/*.ts`, " +
    "`git log src/`, `for x in *.log; do wc -l \"$x\"; done`",
  "- Dev-tool read-only forms (silent): `git status/diff/log/show`, " +
    "`npm test`, `tsc --noEmit`, `go vet`, " +
    "`head`/`tail`/`wc`/`stat` on project paths",

  // ── Layer 3: 弹窗陷阱清单（每条 → 替代方案）────────────────────────
  // 原稿 7 条陷阱全部保留并结构化，追加"敏感系统路径"条（提醒性，
  // 不改变 sensitive.ts 的实际清单或授权判定）。
  "These constructs will prompt for approval — avoid them or pick the " +
    "alternative:",
  "- Forwarders after pipelines: `| xargs`, `| parallel`, `| pforeach` " +
    "→ use a shell loop via dedicated tool, or restructure",
  "- Command substitution `$(...)`: prompts only when the inner command " +
    "is NOT a read-only helper (`basename`/`dirname`/`echo`/`printf`/" +
    "`pwd`/`test` — those are silent). Other forms (`$(cat ...)`, " +
    "`$(rm ...)`, backtick, `<(...)`, `<<EOF`) prompt → inline the " +
    "value or write a small script file first",
  "- Control-flow as standalone tokens: `while`, `for`, `until`, `if`, " +
    "`case` (esp. `for x in /etc/*.conf; do ...` with absolute prefix, or " +
    "`for x in *.log; do rm \"$x\"; done` with write body) → replace with " +
    "`grep`/`find` for read-only relative-prefix loops",
  "- Unquoted globs outside project, OR in write/delete commands " +
    "(`rm -rf /tmp/*.log`, `find /etc | xargs rm`) → quote them, use " +
    "project-scoped globs, or use `grep`/`find` tool",
  "- Shell forwarders & script sources: `bash -c \"...\"`, `sh -c`, " +
    "`bash /tmp/x.sh`, `sh x.sh`, `source x.sh`, `. x.sh` → run the " +
    "command directly, or write a file then read/execute explicitly",
  "- Interpreters & remote tools: `sed`, `awk`, `perl`, `python`, `node`, " +
    "`ruby`, `osascript`, `scp`, `ssh`, `rsync`, `kubectl`, `docker`, " +
    "`eval`, `exec`, `trap` → prefer `read`/`grep`/`find`; " +
    "remote/exec tools always prompt",
  "- Dev-tool forms that prompt (incl. no-static-extraction commands " +
    "moved out of silent: `rg`, `jq`, `cargo`, `go test`): " +
    "`npm run build`, `make -f /tmp/x.mk`, `git log /etc/passwd` " +
    "→ use the silent forms above, or a project-scoped variant",
  "- Sensitive system paths outside the project (`/etc`, `/usr`, `/System`, " +
    "`~/.ssh`, `~/.aws`) → usually prompt or hard-deny; edit " +
    "`permission.json` to persist a grant if needed",
];

function installPromptGuardrails(pi: any): void {
  pi.on("before_agent_start", (event: any) => {
    try {
      const opts = event?.systemPromptOptions;
      if (!opts || typeof opts !== "object") return;

      // De-dup: multiple handlers or repeated dispatches must not pile up.
      const existing: string[] = Array.isArray(opts.promptGuidelines)
        ? opts.promptGuidelines
        : [];
      const additions = BASH_GUARDRAILS.filter((g) => !existing.includes(g));
      if (additions.length === 0) return;

      // Normalize the field first so we always push into an array.
      opts.promptGuidelines = [...existing, ...additions];
    } catch {
      // Guardrail injection must never break the agent loop.
    }
  });
}

// -------- Permission gate registration --------

export function registerPermissionGate(
  pi: any,
  opts: PermissionExtensionOptions,
): void {
  let state: SessionState | undefined;

  installPromptGuardrails(pi);

  // session_start (or first tool_call if session_start didn't fire)
  const ensureState = async (ctx: PictxLike): Promise<SessionState> => {
    if (!state) {
      state = await initSession(ctx, opts);
    }
    return state;
  };

  // permission-toggle (P3): set the footer status marker from the current
  // gate state. Localized via i18n. Pass undefined text to clear.
  const updateStatus = (s: SessionState, ctx: { hasUI: boolean; ui?: PictxLike["ui"] }) => {
    if (!ctx.hasUI || !ctx.ui?.setStatus) return;
    const code = s.enabled ? "permission_status_enabled" : "permission_status_disabled";
    ctx.ui.setStatus("permission-guard", t(code as UiCode, s.lang));
  };

  // permission-toggle (P3): register the /permission slash command.
  pi.registerCommand("permission", {
    description: "Show or toggle the permission guard (on|off)",
    handler: async (args: string, cmdCtx: any) => {
      const s = await ensureState(cmdCtx);
      const arg = args.trim().toLowerCase();
      const statusCode: UiCode = s.enabled
        ? "permission_status_enabled"
        : "permission_status_disabled";
      const ui = cmdCtx.ui;

      if (arg === "on" || arg === "off") {
        const next = arg === "on";
        s.enabled = next;
        try {
          const settings = await loadSettings(opts.trustedDir);
          await saveSettings(opts.trustedDir, { ...settings, enabled: next });
        } catch (err) {
          ui?.notify?.(
            t("permission_cmd_write_failed" as UiCode, s.lang, {
              error: (err as Error).message ?? String(err),
            }),
            "warning",
          );
        }
        updateStatus(s, cmdCtx);
        ui?.notify?.(
          t(
            (next ? "permission_cmd_toggled_on" : "permission_cmd_toggled_off") as UiCode,
            s.lang,
          ),
          "info",
        );
      } else {
        // No arg (or invalid): show current state + usage.
        ui?.notify?.(t("permission_cmd_usage" as UiCode, s.lang), "info");
        ui?.notify?.(
          t("permission_cmd_current" as UiCode, s.lang, {
            state: t(statusCode as UiCode, s.lang),
          }),
          "info",
        );
      }
    },
  });

  pi.on("session_start", async (_e: any, ctx: PictxLike) => {
    try {
      state = await initSession(ctx, opts);
      updateStatus(state, ctx);
      if (state.warnings.length > 0 && ctx.hasUI && ctx.ui) {
        for (const w of state.warnings) {
          ctx.ui.notify(
            t("notify_config_warning" as UiCode, state.lang, { warning: w }),
            "warning",
          );
        }
      }
    } catch (err) {
      // Best-effort. If init fails, we'll retry on first tool_call.
      state = undefined;
    }
  });

  pi.on("tool_call", async (event: ToolCallEventLike, ctx: PictxLike): Promise<ToolCallResultLike | undefined> => {
    const supported = ["read", "write", "edit", "bash"];
    if (!supported.includes(event.toolName)) return undefined;

    let s: SessionState;
    try {
      s = await ensureState(ctx);
    } catch {
      // Can't decide without state - fail closed but don't crash.
      return { block: true, reason: "permission extension failed to initialize" };
    }

    // permission-toggle (P3): gate disabled → no-op. Return undefined so pi
    // handles the tool call natively (no intercept, no audit). The user
    // explicitly disabled the gate, so this is their choice.
    if (!s.enabled) return undefined;

    // Emit config warnings once.
    if (s.warnings.length > 0 && !s.configWarningEmitted && ctx.hasUI && ctx.ui) {
      for (const w of s.warnings) {
        ctx.ui.notify(
          t("notify_config_warning" as UiCode, s.lang, { warning: w }),
          "warning",
        );
      }
      s.configWarningEmitted = true;
    }

    if (event.toolName === "bash") {
      return handleBash(event, ctx, s);
    }

    // File tool: extract path from input.
    const inputPath = event.input.path;
    if (typeof inputPath !== "string" || !inputPath) return undefined;
    return handleFileTool(event, ctx, s, inputPath);
  });

  // -------- Bash handler --------

  async function handleBash(
    event: ToolCallEventLike,
    ctx: PictxLike,
    state: SessionState,
  ): Promise<ToolCallResultLike | undefined> {
    const command = event.input.command;
    if (typeof command !== "string") return undefined;

    const extraction: ExtractResult = extractBashTargets(command, state.projectRoot);

    // Bash-command memory lookup: if the user previously chose "Allow for
    // this session" or "Always allow" on this exact rawCommand, auto-allow.
    // Mirrors the path-based grant lookup but keyed on rawCommand.
    if (
      !extraction.reliable &&
      (state.trust.hasBashSessionGrant(state.projectHash, command) ||
        state.trust.hasBashPersistentGrant(state.projectHash, command))
    ) {
      // C5 unread 兜底（bash-stage-b-security-fixes）：grant 命中不能覆盖
      // unread 声明。扫描命令字符串里可识别的裸路径 token 跑 policy
      // resolve；任一 token 命中 unread 则 hard-deny（grant 不生效）。
      // 已知边界：只扫裸路径 token（quote-aware），`bash -c "cat /etc/passwd"`
      // 中 `/etc/passwd` 在字符串参数里、tokenize 后不是裸路径，不生效——
      // 用户如需严格覆盖需 tier=two prompt。
      const tokens = tokenizeBashCommand(command);
      for (const t of tokens) {
        if (!looksLikePathToken(t)) continue;
        const absPath = toAbsolutePath(expandHome(t), state.projectRoot);
        const entry = state.policy.resolve(absPath);
        if (entry?.permission === "unread") {
          state.audit.log({
            event: "hard_deny",
            tool: "bash",
            project: state.projectHash,
            projectRoot: state.projectRoot,
            path: absPath,
            command,
            region: "project_outer",
            declaration: "unread",
            permission: null,
            toolCallId: event.toolCallId,
            // Design D3: hard_deny is a system decision → presumed.
            authorization: "presumed",
            note: `Bash command grant bypassed: unread hard-deny for ${absPath}`,
          });
          return { block: true, reason: `Unread config overrides bash command grant for ${absPath}` };
        }
      }

      state.audit.log({
        event: "auto_allow",
        tool: "bash",
        project: state.projectHash,
        projectRoot: state.projectRoot,
        path: null,
        command,
        region: "project_outer",
        declaration: "unconfigured",
        permission: null,
        toolCallId: event.toolCallId,
        // Design D2b + D4: bash grant memory hit. authorization comes from
        // the grant's own author (persistent) or is by_person (session).
        // Migration grants map to "presumed" (no human provenance).
        authorization:
          state.trust.lookupBashGrantAuthor(state.projectHash, command) === "by_person"
            ? "by_person"
            : "presumed",
        grant_source: "bash_grant_memory",
        note: `bash command grant memory hit${extraction.reason ? ` (${extraction.reason})` : ""}`,
      });
      return undefined;
    }

    if (!extraction.reliable) {
      // Check deny rules for unreliable bash commands (deny takes precedence).
      const ruleMatch = state.policy.resolveRule("bash", command);
      if (ruleMatch && ruleMatch.action === "deny") {
        state.audit.log({
          event: "hard_deny",
          tool: "bash",
          project: state.projectHash,
          projectRoot: state.projectRoot,
          path: null,
          command,
          region: "project_outer",
          declaration: "unconfigured",
          permission: null,
          toolCallId: event.toolCallId,
          // Design D3: deny rule hit is a system decision → presumed.
          authorization: "presumed",
          note: `Denied by rule ${ruleMatch.tool}(${ruleMatch.pattern ?? "*"}) from ${ruleMatch.source}`,
        });
        return { block: true, reason: `Denied by rule ${ruleMatch.tool}(${ruleMatch.pattern ?? "*"})` };
      }

      // Tier=two prompt showing the raw command.
      // Action unknown (unreliable extraction), so we use "write" as the
      // conservative default for any session/persistent grant - this is safe
      // because a subsequent "read" would NOT match a "write" grant and
      // would still go through its own decision path.
      const bashPermission = bashPermissionForReason(extraction.reason);
      const decision: Decision = {
        kind: "prompt",
        region: "project_outer",
        declaration: "unconfigured",
        configured: false,
        // tier=three (tier-contract-consistency A1): unreliable bash commands
        // offer "Always allow this command" (rawCommand persistable). The
        // tier label now aligns 1:1 with persistability capability:
        //   tier=three → offer "Always allow"
        //   tier=two   → never offer "Always allow" (sensitive-default + dev-socket)
        // Before A1 this was hardcoded "two" with a tier=two + bashReason
        // special-case branch in promptUser to fake the persistable option.
        tier: "three",
        reason: `Bash command could not be reliably parsed${extraction.reason ? ` (${extraction.reason})` : ""}; approval required for the full command below`,
      };
      return handlePromptDecision(
        event,
        ctx,
        state,
        decision,
        null,
        command,
        "write",
        extraction.reason,
        bashPermission,
      );
    }

    // Reliable extraction: process each target. For each target, resolve
    // symlinks via tryRealpath BEFORE decideTarget - otherwise a symlink
    // like `/proj/link -> /etc` would bypass outer-region checks by
    // appearing inside the project root.
    let autoAllowLogged = false;
    for (const target of extraction.targets) {
      const resolvedPath = await tryRealpath(target.path);
      // Check both the target path and its realpath; take the stricter.
      // macOS rewrites /etc/hosts to /private/etc/hosts, but configs
      // typically reference the canonical form.
      let decision = await decideTarget(state, target.path, target.action, "bash", command);
      if (target.path !== resolvedPath) {
        const altDecision = await decideTarget(state, resolvedPath, target.action, "bash", command);
        if (severity(altDecision) > severity(decision)) {
          decision = altDecision;
        }
      }
      if (decision.kind === "deny_hard") {
        state.audit.log({
          event: "hard_deny",
          tool: "bash",
          project: state.projectHash,
          projectRoot: state.projectRoot,
          path: resolvedPath,
          command,
          region: decision.region,
          declaration: decision.declaration,
          permission: null,
          toolCallId: event.toolCallId,
          // D2 (reverse-spec 2026-10-27): hard_deny is a system decision →
          // presumed, matching the file-tool hard_deny provenance. grant_source
          // is omitted because hard_deny is not a grant event at all.
          authorization: "presumed",
          note: decision.denial?.reason +
            (resolvedPath !== target.path ? ` (resolved from ${target.path})` : ""),
        });
        return { block: true, reason: decision.denial?.reason ?? "hard denied" };
      }
      if (decision.kind === "prompt") {
        return handlePromptDecision(event, ctx, state, decision, resolvedPath, command, target.action);
      }
      // auto_allow: continue to next target.
      // D1 (reverse-spec 2026-10-27): record a command-level audit for any
      // non-exception auto_allow (audit-log spec Req 1). The in-project
      // unconfigured non-sensitive default (in_project_default_allowed) is
      // the only exception. Record once per bash call to avoid duplicate
      // records for multi-target commands.
      if (!autoAllowLogged && decision.reasonCode !== "in_project_default_allowed") {
        state.audit.log({
          event: "auto_allow",
          tool: "bash",
          project: state.projectHash,
          projectRoot: state.projectRoot,
          path: null,
          command,
          region: decision.region,
          declaration: decision.declaration,
          permission: null,
          toolCallId: event.toolCallId,
          authorization: decision.authorization,
          grant_source: decision.grant_source,
          note: decision.reason,
        });
        autoAllowLogged = true;
      }
    }

    return undefined;
  }

  // -------- File tool handler --------

  async function handleFileTool(
    event: ToolCallEventLike,
    ctx: PictxLike,
    state: SessionState,
    inputPath: string,
  ): Promise<ToolCallResultLike | undefined> {
    // On macOS /etc is a symlink to /private/etc (and other similar cases
    // on other OSes). User configs typically reference the canonical path
    // (/etc/hosts) but tryRealpath rewrites to /private/etc/hosts. We check
    // BOTH forms and pick the stricter decision (deny_hard > prompt > auto).
    const expandedInput = expandHome(inputPath);
    const absPath = await resolveToAbsolute(expandedInput, state.projectRoot);
    const action = event.toolName === "read" ? "read" : "write";

    let decision = await decideTarget(state, expandedInput, action, event.toolName, absPath);
    if (expandedInput !== absPath) {
      const altDecision = await decideTarget(state, absPath, action, event.toolName, absPath);
      if (severity(altDecision) > severity(decision)) {
        // Use the stricter decision but keep the input path for audit readability.
        decision = altDecision;
      }
    }

    if (decision.kind === "deny_hard") {
      state.audit.log({
        event: "hard_deny",
        tool: event.toolName as any,
        project: state.projectHash,
        projectRoot: state.projectRoot,
        path: expandedInput,
        command: null,
        region: decision.region,
        declaration: decision.declaration,
        permission: null,
        toolCallId: event.toolCallId,
        // Design D3: hard_deny is a system decision → presumed. grant_source
        // is omitted (undefined) because deny_hard has no corresponding
        // GrantSource enum value (it's not a grant at all).
        authorization: "presumed",
        note: decision.denial?.reason +
          (expandedInput !== absPath ? ` (resolved from ${absPath})` : ""),
      });
      if (ctx.hasUI && ctx.ui) {
        ctx.ui.notify(
          t(
            "notify_deny_hard" as UiCode,
            state.lang,
            {
              reason: decision.denial?.reason ?? "hard denied",
              path: prettyPath(expandedInput),
            },
          ),
          "warning",
        );
      }
      return { block: true, reason: decision.denial?.reason ?? "hard denied" };
    }

    if (decision.kind === "prompt") {
      return handlePromptDecision(event, ctx, state, decision, expandedInput, null, action);
    }

    // auto_allow
    // D1 (reverse-spec 2026-10-27): audit-log spec Req 1 requires every
    // decision to be logged EXCEPT "项目内未配置非敏感常规读写" (the
    // in_project_default_allowed case). All other auto_allows (config
    // declaration, allow rule, grant memory hit, outside-project read, tmp
    // default) MUST be recorded with the decision's authorization/grant_source
    // passed through (audit-log spec "auto_allow 从决策对象透传"). Previously
    // this path returned undefined with no audit.log.
    if (decision.reasonCode !== "in_project_default_allowed") {
      state.audit.log({
        event: "auto_allow",
        tool: event.toolName as any,
        project: state.projectHash,
        projectRoot: state.projectRoot,
        path: expandedInput,
        command: null,
        region: decision.region,
        declaration: decision.declaration,
        permission: null,
        toolCallId: event.toolCallId,
        authorization: decision.authorization,
        grant_source: decision.grant_source,
        note: decision.reason,
      });
    }
    return undefined;
  }

  // -------- Decision per target --------

  // Severity: higher = stricter. Used to compare decisions from alternate
  // path forms (canonical vs realpath).
  function severity(d: Decision): number {
    return d.kind === "deny_hard" ? 3 : d.kind === "prompt" ? 2 : 1;
  }

  async function decideTarget(
    state: SessionState,
    absPath: string,
    action: "read" | "write" | "delete",
    toolName?: string,
    toolPattern?: string,
  ): Promise<Decision> {
    // Resolve to absolute path before realpath. `toAbsolutePath` handles
    // relative paths (relative to projectRoot) and does NOT require the file
    // to exist — unlike `tryRealpath`, which fails on non-existent files and
    // returns the input unchanged. Without this, a `write` to a non-existent
    // relative path would keep its relative form, and `isInside(relativePath,
    // absoluteProjectRoot)` would return false, misclassifying the path as
    // outside-project.
    const resolvedAbs = toAbsolutePath(absPath, state.projectRoot);
    // Canonicalize for `isInside` purposes: /tmp/x and /private/tmp/x are
    // the same directory on macOS. Only realpath if the file exists.
    const canonicalPath = await tryRealpath(resolvedAbs);
    const inside = isInside(canonicalPath, state.projectRoot);
    // Sensitivity is path-shape based (dir names, file extensions), and
    // `~/.ssh` vs `/Users/x/.ssh` are both sensitive. Use the input path.
    const sensitive = findSensitiveMatch(absPath);
    const entry = state.policy.resolve(absPath);

    // unread hard-deny takes absolute precedence (skip grant check).
    if (entry?.permission === "unread") {
      return {
        kind: "deny_hard",
        region: inside ? "project_inner" : "project_outer",
        declaration: "unread",
        configured: true,
        reason: `Path is hard-denied by ${entry.source} config (${entry.raw})`,
        denial: { reason: `Path declared unread in ${entry.source} config` },
      };
    }

    // Check memory (session + persistent) BEFORE calling decide().
    // Dual-key lookup (V3 fix, bash-symlink-grant-key-fix): bash reliable
    // branch stores persistent grant keyed by resolvedPath (realpath), but
    // decideTarget's first call queries with target.path (literal) → key
    // mismatch → persistent grant never hits → re-prompts. canonicalPath
    // (= tryRealpath(absPath)) shares the same source function as the write-
    // side resolvedPath, so querying canonicalPath hits the write-side key.
    // File-tool path: write-side stores grant keyed by expandedInput (the
    // form handlePromptDecision receives). decideTarget's first call
    // (handleFileTool:681) passes absPath=expandedInput → key 1 (absPath)
    // matches the write-side key directly; canonicalPath is never consulted.
    // Second call (:683) passes absPath=resolveToAbsolute result (realpath),
    // where canonicalPath === absPath, so dual-key is a no-op there too.
    const grantHitPath = hasGrant(state, action, absPath)
      ? absPath
      : hasGrant(state, action, canonicalPath)
        ? canonicalPath
        : null;
    if (grantHitPath) {
      // Design D2b: grant memory hit → authorization comes from the Grant's
      // own author field (persistent) or is by_person (session). grant_source
      // is "grant_memory" for both channels.
      // Migration grants have no human provenance → map to "presumed" for the
      // coarse-grained Authorization axis (design.md D1).
      const author = state.trust.lookupGrantAuthor(state.projectHash, action, grantHitPath) ?? "by_person";
      return {
        kind: "auto_allow",
        region: inside ? "project_inner" : "project_outer",
        declaration: entry?.permission ?? "unconfigured",
        configured: !!entry,
        authorization: author === "by_person" ? "by_person" : "presumed",
        grant_source: "grant_memory",
        reason: `Grant memory hit for ${grantHitPath}`,
      };
    }

    // Run decision engine.
    return decide({
      policy: state.policy,
      absPath,
      projectRoot: state.projectRoot,
      action,
      isInside: inside,
      sensitive,
      toolName,
      toolPattern,
    });
  }

  // -------- Prompt decision handler --------

  async function handlePromptDecision(
    event: ToolCallEventLike,
    ctx: PictxLike,
    state: SessionState,
    decision: Decision,
    absPath: string | null,
    bashCommand: string | null,
    action: "read" | "write" | "delete",
    bashReason?: string | undefined,
    bashPermission: "read_only" | "read_write" = "read_only",
  ): Promise<ToolCallResultLike | undefined> {
    if (decision.kind !== "prompt") return undefined;

    // Build the message for the prompt.
    let message = "";
    if (bashCommand) {
      message = `$ ${bashCommand}\n\n${decision.reason}`;
    } else if (absPath) {
      message = `${prettyPath(absPath)}\n\n${decision.reason}`;
    } else {
      message = decision.reason;
    }

    const trustedPath = join(state.trust.path);

    // Dispatch subtitle by decision source (design.md D5). The subtitle
    // gives the user a clear remediation path that matches the actual
    // context. tier=three bash prompts dispatch by extraction reason;
    // tier=two prompts dispatch by whether it's a sensitive path or dev-socket.
    //
    // NOTE (tier-contract-consistency A1): the bash-command subtitle branch
    // moved from tier=two to tier=three because unreliable bash now routes
    // through tier=three (offer "Always allow this command"). The tier=two
    // branch is now strictly for sensitive-default paths and dev-socket writes.
    let subtitle: string | undefined;
    if (decision.tier === "three" && bashCommand && bashReason) {
      // Bash-command class prompt: dispatch by extraction reason.
      subtitle = bashSubtitleForReason(bashReason, state.lang);
    } else if (decision.tier === "two") {
      if (decision.declaration === "sensitive_default") {
        subtitle = t("subtitle_sensitive_hard_not_persistable" as UiCode, state.lang);
      } else if (decision.reason.startsWith("Network exfiltration")) {
        subtitle = t("subtitle_network_exfil_not_persistable" as UiCode, state.lang);
      }
    }

    const choice = await promptUser(
      ctx,
      decision.tier,
      message,
      trustedPath,
      subtitle,
      bashCommand && bashReason ? bashReason : null,
      state.lang,
    );

    if (choice === "deny") {
      // Special event for cross-source conflict prompts so audit consumers
      // can distinguish "user denied a normal prompt" from "user denied
      // after seeing a cross-source conflict warning" (spec audit-log,
      // design.md D9).
      const isConflict = decision.conflict;
      const auditEvent = isConflict ? "conflict_prompt" : "deny";
      const permission =
        decision.declaration === "read_write" || decision.declaration === "read_only"
          ? decision.declaration
          : null;
      state.audit.log({
        event: auditEvent,
        tool: event.toolName as any,
        project: state.projectHash,
        projectRoot: state.projectRoot,
        path: absPath,
        command: bashCommand,
        region: decision.region,
        declaration: decision.declaration,
        permission,
        toolCallId: event.toolCallId,
        // Design D3: 真人拒绝也是真人决策 → authorization = "by_person".
        authorization: "by_person",
        grant_source: promptGrantSource(decision, bashCommand, bashReason),
        note: isConflict
          ? `User denied a cross-source conflict prompt: ${decision.reason}`
          : decision.reason,
      });
      return {
        block: true,
        reason: isConflict
          ? `User denied cross-source conflict: ${decision.reason}`
          : `User denied: ${decision.reason}`,
      };
    }

    if (choice === "allow_once") {
      state.audit.log({
        event: "allow_once",
        tool: event.toolName as any,
        project: state.projectHash,
        projectRoot: state.projectRoot,
        path: absPath,
        command: bashCommand,
        region: decision.region,
        declaration: decision.declaration,
        permission:
          decision.declaration === "read_write" || decision.declaration === "read_only"
            ? decision.declaration
            : null,
        toolCallId: event.toolCallId,
        authorization: "by_person",
        grant_source: promptGrantSource(decision, bashCommand, bashReason),
        note: decision.conflict ? `Cross-source conflict: ${decision.reason}` : undefined,
      });
      return undefined;
    }

    if (choice === "allow_session") {
      if (absPath) {
        state.trust.addSessionGrant(state.projectHash, action, absPath);
      } else if (bashCommand) {
        state.trust.addBashSessionGrant(
          state.projectHash,
          bashCommand,
          bashReason ?? "unreliable",
          bashPermission,
        );
      }
      state.audit.log({
        event: "allow_session",
        tool: event.toolName as any,
        project: state.projectHash,
        projectRoot: state.projectRoot,
        path: absPath,
        command: bashCommand,
        region: decision.region,
        declaration: decision.declaration,
        permission: bashCommand
          ? bashPermission
          : decision.declaration === "read_write" || decision.declaration === "read_only"
            ? decision.declaration
            : null,
        toolCallId: event.toolCallId,
        authorization: "by_person",
        grant_source: promptGrantSource(decision, bashCommand, bashReason),
        note: decision.conflict ? `Cross-source conflict: ${decision.reason}` : bashCommand ? `bash command session grant (reason: ${bashReason ?? "unreliable"})` : undefined,
      });
      return undefined;
    }

    // allow_persistent (only for tier=three; if tier=two this branch is
    // reachable only for bash-command prompts which now also support it).
    if (choice === "allow_persistent") {
      if (absPath) {
        const permission = decision.declaration === "read_write" ? "read_write" : decision.declaration === "read_only" ? "read_only" : "read_write";
        try {
          await state.trust.addPersistentGrant({
            projectHash: state.projectHash,
            action,
            path: absPath,
            permission,
          });
          state.audit.log({
            event: "allow_persistent",
            tool: event.toolName as any,
            project: state.projectHash,
            projectRoot: state.projectRoot,
            path: absPath,
            command: bashCommand,
            region: decision.region,
            declaration: decision.declaration,
            permission: permission as any,
            toolCallId: event.toolCallId,
            authorization: "by_person",
            grant_source: promptGrantSource(decision, bashCommand, bashReason),
            note: `saved to ${prettyPath(state.trust.path)}`,
          });
        } catch (err) {
          // Persistent save failed - fall back to session grant.
          state.trust.addSessionGrant(state.projectHash, action, absPath);
          if (ctx.hasUI && ctx.ui) {
            ctx.ui.notify(
              t(
                "notify_persistent_save_failed" as UiCode,
                state.lang,
                { error: (err as any).message },
              ),
              "warning",
            );
          }
          state.audit.log({
            event: "allow_session",
            tool: event.toolName as any,
            project: state.projectHash,
            projectRoot: state.projectRoot,
            path: absPath,
            command: bashCommand,
            region: decision.region,
            declaration: decision.declaration,
            permission: null,
            toolCallId: event.toolCallId,
            authorization: "by_person",
            grant_source: promptGrantSource(decision, bashCommand, bashReason),
            note: "persistent write failed, downgraded to session",
          });
        }
        return undefined;
      }

      // Bash-command persistent grant path.
      if (bashCommand) {
        try {
          await state.trust.addBashPersistentGrant({
            projectHash: state.projectHash,
            rawCommand: bashCommand,
            reason: bashReason ?? "unreliable",
            permission: bashPermission,
          });
          state.audit.log({
            event: "allow_persistent",
            tool: event.toolName as any,
            project: state.projectHash,
            projectRoot: state.projectRoot,
            path: null,
            command: bashCommand,
            region: decision.region,
            declaration: decision.declaration,
            permission: bashPermission as any,
            toolCallId: event.toolCallId,
            authorization: "by_person",
            grant_source: "bash_grant_memory",
            note: `bash command saved to ${prettyPath(state.trust.path)}`,
          });
        } catch (err) {
          state.trust.addBashSessionGrant(state.projectHash, bashCommand, bashReason ?? "unreliable", bashPermission);
          if (ctx.hasUI && ctx.ui) {
            ctx.ui.notify(
              t(
                "notify_bash_persistent_save_failed" as UiCode,
                state.lang,
                { error: (err as any).message },
              ),
              "warning",
            );
          }
          state.audit.log({
            event: "allow_session",
            tool: event.toolName as any,
            project: state.projectHash,
            projectRoot: state.projectRoot,
            path: null,
            command: bashCommand,
            region: decision.region,
            declaration: decision.declaration,
            permission: bashPermission as any,
            toolCallId: event.toolCallId,
            authorization: "by_person",
            grant_source: "bash_grant_memory",
            note: "persistent bash write failed, downgraded to session",
          });
        }
        return undefined;
      }
    }

    return undefined;
  }
}

// -------- Path resolution helper --------

async function resolveToAbsolute(inputPath: string, projectRoot: string): Promise<string> {
  const expanded = expandHome(inputPath);
  const abs = toAbsolutePath(expanded, projectRoot);
  return await tryRealpath(abs);
}

// -------- Default pi factory export --------

// The default export is what pi-coding-agent calls. It registers the
// permission gate with sensible defaults:
//   - trustedDir: ~/.pi/agent/extensions/permission-guard-pi
//   - config paths: via configLocations() at session start
export default function (pi: any) {
  const trustedDir = join(homedir(), ".pi/agent/extensions/permission-guard-pi");
  registerPermissionGate(pi, { trustedDir });
}
