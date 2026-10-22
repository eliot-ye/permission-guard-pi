/**
 * @permission-guard/pi
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
 *   - JSONL audit log at ~/.pi/agent/extensions/@permission-guard/pi/logs/
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
import { extractBashTargets, tokenizeBashCommand, looksLikePathToken, type ExtractResult } from "../src/lib/bash-extract.ts";
import { decide, type Decision } from "../src/lib/decision.ts";

// -------- Config for the extension registration --------

export interface PermissionExtensionOptions {
  // Directory where trusted.json lives. Default: ~/.pi/agent/extensions/@permission-guard/pi
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
}

// -------- Type aliases for the extension surface --------

interface PictxLike {
  hasUI: boolean;
  cwd: string;
  ui?: {
    select: (prompt: string, choices: string[]) => Promise<string>;
    notify: (message: string, level: "info" | "warning" | "error") => void;
    input: (prompt: string, defaultValue?: string) => Promise<string>;
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

  return {
    policy,
    warnings,
    projectHash,
    projectRoot,
    trust,
    audit,
    configWarningEmitted: false,
  };
}

// -------- Prompt UI --------

type UserChoice = "allow_once" | "allow_session" | "allow_persistent" | "deny";

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
 * Build a tier=two subtitle specifically for a bash command class. Each
 * extraction reason gets its own remediation hint so the user sees how to
 * avoid repeating the prompt (spec approval-flow, D5).
 */
export function bashSubtitleForReason(reason: string | undefined): string {
  if (reason === "glob_expansion") {
    return "该命令含未加引号的 glob 通配符，无法静态枚举目标文件。如需避免重复弹窗，请在 permission.json 中声明该路径 glob，或选择「会话内允许」";
  }
  if ((reason ?? "").startsWith("unresolved variable:")) {
    return "该命令包含未展开的 shell 变量，无法静态枚举目标文件。选择「会话内允许」可避免重复弹窗";
  }
  switch (reason) {
    case "control_flow":
      return "该命令包含控制流关键字（while/for/if 等），实际访问文件取决于运行时变量，无法静态确定。建议使用 grep/find 等工具替代 shell 循环；选择「会话内允许」可避免重复弹窗";
    case "shell_forwarder":
      return "该命令通过 shell 转发器执行，字符串内的文件系统访问不可见于静态分析。建议直接执行命令而非嵌套 shell；选择「会话内允许」可避免重复弹窗";
    case "forwarding_command":
      return "该命令使用转发器（xargs/parallel 等），下游参数来自上游 stdout，无法静态枚举。建议避免在管道后使用转发器；选择「会话内允许」可避免重复弹窗";
    case "cd_chdir":
      return "该命令包含 cd 命令，改变后续命令的工作目录，无法静态确定实际访问的文件路径。建议使用绝对路径；选择「会话内允许」可避免重复弹窗";
    default:
      return "命令无法静态解析，请审阅整条命令；选择「会话内允许」可避免重复弹窗";
  }
}

async function promptUser(
  ctx: PictxLike,
  tier: "three" | "two",
  message: string,
  trustedPath: string,
  subtitle?: string,
  bashReason?: string | null,
): Promise<UserChoice> {
  if (!ctx.hasUI || !ctx.ui) return "deny";

  const title = `Permission request\n\n${message}`;

  if (tier === "three") {
    const choice = await ctx.ui.select(
      `${title}\n\nNote: "Always allow" saves to ${prettyPath(trustedPath)}`,
      [
        "Allow this call only",
        "Allow for this session",
        "Always allow (save to trusted.json)",
        "Deny",
      ],
    );
    if (choice === "Allow this call only") return "allow_once";
    if (choice === "Allow for this session") return "allow_session";
    if (choice.startsWith("Always allow")) return "allow_persistent";
    return "deny";
  }

  // Bash-command tier=two prompts get a THIRD option: "Always allow" that
  // writes a bash-command-scoped persistent grant. The subtitle still explains
  // why the command cannot be auto-parsed; the extra option lets a power
  // user persist the remember across sessions for the same raw command.
  if (bashReason) {
    const choice = await ctx.ui.select(
      `${title}\n\n${subtitle ?? ""}`,
      [
        "Allow this call only",
        "Allow for this session",
        `Always allow this command (save to ${prettyPath(trustedPath)})`,
        "Deny",
      ],
    );
    if (choice === "Allow this call only") return "allow_once";
    if (choice === "Allow for this session") return "allow_session";
    if (choice.startsWith("Always allow")) return "allow_persistent";
    return "deny";
  }

  // Plain tier=two (path-based, sensitive default, etc.).
  const footer = subtitle
    ? `${subtitle}`
    : `No "Always allow" option available for this context.`;

  const choice = await ctx.ui.select(
    `${title}\n\n${footer}`,
    ["Allow this call only", "Allow for this session", "Deny"],
  );
  if (choice === "Allow this call only") return "allow_once";
  if (choice === "Allow for this session") return "allow_session";
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
//   - Command substitution ($( ... ), backtick)
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
  "- Run checks/tests: `npm test`, `cargo check`, `tsc --noEmit`, " +
    "`go vet`, `go test`",
  "- In-project read-only glob (auto-allowed): `ls openspec/*`, " +
    "`find . -name '*.ts'`, `cat src/a.ts`, `wc -l src/*.ts`, " +
    "`git log src/`, `for x in *.log; do wc -l \"$x\"; done`",
  "- Dev-tool read-only forms (silent): `git status/diff/log/show`, " +
    "`npm test/check`, `cargo check/test`, `tsc --noEmit`, " +
    "`go vet/test`, `rg`, `jq`, `head`/`tail`/`wc`/`stat` on project paths",

  // ── Layer 3: 弹窗陷阱清单（每条 → 替代方案）────────────────────────
  // 原稿 7 条陷阱全部保留并结构化，追加"敏感系统路径"条（提醒性，
  // 不改变 sensitive.ts 的实际清单或授权判定）。
  "These constructs will prompt for approval — avoid them or pick the " +
    "alternative:",
  "- Forwarders after pipelines: `| xargs`, `| parallel`, `| pforeach` " +
    "→ use a shell loop via dedicated tool, or restructure",
  "- Command / process / heredoc substitution: `$(...)`, backtick, " +
    "`<(...)`, `<<EOF` → inline the value or write a small script file first",
  "- Control-flow as standalone tokens: `while`, `for`, `until`, `if`, " +
    "`case` (esp. `for x in /etc/*.conf; do ...` with absolute prefix, or " +
    "`for x in *.log; do rm \"$x\"; done` with write body) → replace with " +
    "`grep`/`find`/`rg` for read-only relative-prefix loops",
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
  "- Non-read-only dev-tool forms: `npm run build`, `make -f /tmp/x.mk`, " +
    "`git log /etc/passwd` → use read-only forms; check whether a " +
    "project-scoped variant exists",
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
  const ctxRef: { ctx?: PictxLike } = {};

  installPromptGuardrails(pi);

  // session_start (or first tool_call if session_start didn't fire)
  const ensureState = async (ctx: PictxLike): Promise<SessionState> => {
    if (!state) {
      state = await initSession(ctx, opts);
      ctxRef.ctx = ctx;
    }
    return state;
  };

  pi.on("session_start", async (_e: any, ctx: PictxLike) => {
    try {
      state = await initSession(ctx, opts);
      ctxRef.ctx = ctx;
      if (state.warnings.length > 0 && ctx.hasUI && ctx.ui) {
        for (const w of state.warnings) {
          ctx.ui.notify(`[permission] config warning: ${w}`, "warning");
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

    // Emit config warnings once.
    if (s.warnings.length > 0 && !s.configWarningEmitted && ctx.hasUI && ctx.ui) {
      for (const w of s.warnings) {
        ctx.ui.notify(`[permission] config warning: ${w}`, "warning");
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
        tier: "two",
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
          note: decision.denial?.reason +
            (resolvedPath !== target.path ? ` (resolved from ${target.path})` : ""),
        });
        return { block: true, reason: decision.denial?.reason ?? "hard denied" };
      }
      if (decision.kind === "prompt") {
        return handlePromptDecision(event, ctx, state, decision, resolvedPath, command, target.action);
      }
      // auto_allow: continue to next target.
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
        note: decision.denial?.reason +
          (expandedInput !== absPath ? ` (resolved from ${absPath})` : ""),
      });
      if (ctx.hasUI && ctx.ui) {
        ctx.ui.notify(
          `Blocked: ${decision.denial?.reason ?? "hard denied"} (${prettyPath(expandedInput)})`,
          "warning",
        );
      }
      return { block: true, reason: decision.denial?.reason ?? "hard denied" };
    }

    if (decision.kind === "prompt") {
      return handlePromptDecision(event, ctx, state, decision, expandedInput, null, action);
    }

    // auto_allow
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
    if (hasGrant(state, action, absPath)) {
      return {
        kind: "auto_allow",
        region: inside ? "project_inner" : "project_outer",
        declaration: entry?.permission ?? "unconfigured",
        configured: !!entry,
        reason: `Grant memory hit for ${absPath}`,
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

    // Dispatch tier=two subtitle by decision source (design.md D5). The
    // subtitle gives the user a clear remediation path that matches the
    // actual context — the old hard-coded "unconfigured paths" text was
    // misleading for both outer-sensitive-path and bash-unreliable sources.
    let subtitle: string | undefined;
    if (decision.tier === "two") {
      if (bashCommand && bashReason) {
        // Bash-command class prompt: dispatch by extraction reason.
        subtitle = bashSubtitleForReason(bashReason);
      } else if (bashCommand) {
        // Fallback: old-style bash prompt (should not happen post-change).
        subtitle = "命令无法静态解析，请审阅整条命令；无法通过配置持久化。";
      } else if (decision.declaration === "sensitive_default") {
        subtitle = "敏感系统路径不能持久化，如需长期允许请编辑 permission.json。";
      }
    }

    const choice = await promptUser(
      ctx,
      decision.tier,
      message,
      trustedPath,
      subtitle,
      bashCommand && bashReason ? bashReason : null,
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
            createdAt: new Date().toISOString(),
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
            note: `saved to ${prettyPath(state.trust.path)}`,
          });
        } catch (err) {
          // Persistent save failed - fall back to session grant.
          state.trust.addSessionGrant(state.projectHash, action, absPath);
          if (ctx.hasUI && ctx.ui) {
            ctx.ui.notify(
              `Failed to save persistent grant: ${(err as any).message}. Falling back to session-only.`,
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
            commandHash: "",
            rawCommand: bashCommand,
            reason: bashReason ?? "unreliable",
            permission: bashPermission,
            createdAt: new Date().toISOString(),
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
            note: `bash command saved to ${prettyPath(state.trust.path)}`,
          });
        } catch (err) {
          state.trust.addBashSessionGrant(state.projectHash, bashCommand, bashReason ?? "unreliable", bashPermission);
          if (ctx.hasUI && ctx.ui) {
            ctx.ui.notify(
              `Failed to save persistent bash grant: ${(err as any).message}. Falling back to session-only.`,
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
//   - trustedDir: ~/.pi/agent/extensions/@permission-guard/pi
//   - config paths: via configLocations() at session start
export default function (pi: any) {
  const trustedDir = join(homedir(), ".pi/agent/extensions/@permission-guard/pi");
  registerPermissionGate(pi, { trustedDir });
}
