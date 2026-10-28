//
// TDD RED: extension tests. Covers AF1-AF10.
//
// We mock the pi ExtensionAPI and ExtensionContext to test the extension's
// behavior without a real pi runtime.
//
// Contract (post-review design.md D1):
//   - Extension layer checks grants BEFORE calling decide()
//   - If grant hit → skip decide, allow
//   - If no grant → call decide() → if prompt → call ctx.ui.select → write grant + audit
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Import the extension factory. We treat it as a plain function to test with
// a mock pi API.
import { registerPermissionGate } from "../extensions/index.ts";
import { t } from "../src/lib/i18n.ts";
import { detectLang } from "../src/lib/lang-detect.ts";
import type { ReasonCode, UiCode } from "../src/lib/reason-codes.ts";

// i18n-aware UI choice strings. promptUser() matches by identity of the
// localized strings it built, so tests must return the same strings.
// We detect the current test-env lang (same as the extension does at
// session init) so this works regardless of the developer's LANG env var.
const UI = {
  allowOnce: t("choice_allow_once", detectLang(process.env, {})),
  allowSession: t("choice_allow_session", detectLang(process.env, {})),
  alwaysAllow: t("choice_always_allow", detectLang(process.env, {})),
  alwaysAllowCmd: t("choice_always_allow_command", detectLang(process.env, {}), { path: "trusted.json" }),
  deny: t("choice_deny", detectLang(process.env, {})),
};

// Helper: get a localized UI string by code (uses the same detected lang
// as the UI constants above, so tests stay language-agnostic).
const uiText = (code: ReasonCode | UiCode, params?: Record<string, string>) =>
  t(code, detectLang(process.env, {}), params);

// -------- Mocks --------

type UIChoiceHandler = (prompt: string, choices: string[]) => Promise<string>;

interface MockUI {
  select: UIChoiceHandler;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  input: (prompt: string, defaultValue?: string) => Promise<string>;
  setStatus: (key: string, text: string | undefined) => void;
}

interface MockContext {
  hasUI: boolean;
  mode: "tui" | "rpc" | "json" | "print";
  cwd: string;
  ui: MockUI;
  projectRoot: string;
}

interface MockExtensionAPI {
  on: (event: string, handler: Function) => () => void;
  registerCommand: (name: string, opts: { handler: Function; description?: string }) => void;
  // Other API methods the extension might use
  appendEntry: () => void;
}

function createMockPi(opts: {
  trustedDir: string;
  configPaths: { global: string; project: string; local: string };
  uiChoice?: UIChoiceHandler;
  hasUI?: boolean;
  projectRoot?: string;
}): {
  pi: MockExtensionAPI;
  ctx: MockContext;
  notifications: Array<{ message: string; level: string }>;
} {
  const notifications: Array<{ message: string; level: string }> = [];
  const uiChoice =
    opts.uiChoice ??
    (async (_prompt: string, choices: string[]) => choices[0] || UI.allowOnce);

  const ctx: MockContext = {
    hasUI: opts.hasUI ?? true,
    mode: "tui",
    cwd: opts.projectRoot ?? "/proj",
    projectRoot: opts.projectRoot ?? "/proj",
    ui: {
      select: uiChoice,
      notify: (message, level) => {
        notifications.push({ message, level });
      },
      input: async () => "",
      setStatus: () => {},
    },
  };

  const handlers: Record<string, Function[]> = {};
  const commands: Record<string, { handler: Function; description?: string }> = {};
  const pi: MockExtensionAPI = {
    on: (event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return () => {
        // (no-op for test)
      };
    },
    registerCommand: (name: string, opts) => {
      commands[name] = opts;
    },
    appendEntry: () => {},
  };

  // Attach internals so test can inspect what was registered.
  (pi as any)._handlers = handlers;
  (pi as any)._commands = commands;
  (pi as any)._trustedDir = opts.trustedDir;
  (pi as any)._configPaths = opts.configPaths;
  (pi as any)._ctx = ctx;

  return { pi, ctx, notifications };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ext-"));
  try {
    return await fn(dir);
  } finally {
    // Audit logger writes are fire-and-forget through an internal queue.
    // By the time the test body returns, one or two append tasks may still
    // be running inside fs.open/writeFile/close. fs.rm recurses bottom-up,
    // so a stray append that lands between "unlink file" and "rmdir dir"
    // trips ENOTEMPTY. Retry a few times to ride out the race — the queue
    // drains within a few ms, so 5 × 20ms is plenty.
    let cleared = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        cleared = true;
        break;
      } catch (err: any) {
        if (err?.code !== "ENOTEMPTY") throw err;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    if (!cleared) {
      // Last attempt — if this still throws, let it fail loud so we know
      // the temp dir is leaking.
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// Trigger a tool_call event on the mock pi.
async function fireToolCall(
  pi: MockExtensionAPI,
  ctx: MockContext,
  event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const handlers = (pi as any)._handlers["tool_call"] ?? [];
  if (handlers.length === 0) {
    return undefined;
  }
  // Fire all handlers in order; first non-undefined return wins.
  for (const h of handlers) {
    let result = await h(event, ctx);
    if (result !== undefined) return result;
  }
  return undefined;
}

// -------- AF1: three-tier prompt for configured path --------

test("AF1: three_tier_prompt_shows_four_options", async () => {
  await withTmpDir(async (dir) => {
    // Setup global config with read_write for an outer path
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );

    let capturedChoices: string[] | undefined;
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) => {
        capturedChoices = choices;
        return choices[0];
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // Fire tool_call for outer path
    const result = await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-1",
      input: { path: "/opt/x", content: "hi" },
    });

    // Should be blocked (user chose UI.allowOnce but this is tier=three)
    // Actually: with default choice UI.allowOnce, result should be undefined (allow once).
    assert.equal(result, undefined, "allow-once should not block");
    // And choices should have 4 options.
    assert.ok(capturedChoices, "should have shown choices");
    assert.equal(capturedChoices!.length, 4, "expected 4 options for tier=three");
  });
});

// -------- AF2: two-tier prompt for unconfigured path --------

test("AF2: two_tier_prompt_shows_three_options", async () => {
  await withTmpDir(async (dir) => {
    // Empty config paths
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    let capturedChoices: string[] | undefined = undefined;
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) => {
        capturedChoices = choices;
        return choices[0];
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // Outer write to /tmp/x is now built-in read_write and should not prompt.
    const autoResult = await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-auto-1",
      input: { path: "/tmp/x.txt", content: "hi" },
    });
    assert.equal(autoResult, undefined);
    assert.equal(capturedChoices, undefined, "/tmp write should be auto-allowed, not prompted");

    // Sensitive unconfigured outer read remains tier=two.
    capturedChoices = undefined;
    await fireToolCall(pi, ctx, {
      toolName: "read",
      toolCallId: "tc-1",
      input: { path: "/Users/x/.ssh/id_rsa" },
    });

    const choices: string[] | undefined = capturedChoices as string[] | undefined;
    assert.ok(choices);
    // Three options only; "Always allow" is not offered for sensitive paths.
    assert.equal(choices!.length, 3, "expected 3 options for tier=two (sensitive outer read)");
  });
});

// -------- AF3: three-tier prompt mentions trusted.json --------

test("AF3: three_tier_prompt_mentions_trusted_json_path", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );

    let capturedPrompt = "";
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (prompt) => {
        capturedPrompt = prompt;
        return UI.deny;
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-1",
      input: { path: "/opt/x", content: "hi" },
    });

    assert.ok(capturedPrompt.includes("trusted.json"), "prompt should mention trusted.json");
  });
});

// -------- AF4: sensitive unconfigured prompt mentions no persistent option --------

// AD16 was updated: outer NON-SENSITIVE unconfigured write is now tier=three
// (persistent allowed). Only SENSITIVE unconfigured stays tier=two with no
// "Always allow" option. This test verifies the sensitive case.

test("AF4: two_tier_prompt_mentions_no_persistent_option", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    let capturedPrompt = "";
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (prompt) => {
        capturedPrompt = prompt;
        return UI.deny;
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // Sensitive unconfigured outer read → tier=two, no "Always allow".
    // (Outer non-sensitive write was moved to tier=three per AD16 update.)
    await fireToolCall(pi, ctx, {
      toolName: "read",
      toolCallId: "tc-1",
      input: { path: "/Users/x/.ssh/id_rsa" },
    });

    assert.ok(
      capturedPrompt.includes(uiText("subtitle_sensitive_hard_not_persistable")),
      `prompt should mention sensitive paths cannot be persisted: ${capturedPrompt}`,
    );
  });
});

// -------- AF5: hard deny notifies warning without prompt --------

test("AF5: hard_deny_notifies_warning_without_prompt", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/srv/prod": "unread" } }),
      "utf8",
    );

    let promptCalled = false;
    const { pi, ctx, notifications } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => {
        promptCalled = true;
        return UI.deny;
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    const result = await fireToolCall(pi, ctx, {
      toolName: "read",
      toolCallId: "tc-1",
      input: { path: "/srv/prod" },
    });

    assert.equal(result?.block, true);
    assert.ok(!promptCalled, "should not prompt for hard deny");
    assert.ok(notifications.some((n) => n.level === "warning"));
  });
});

// -------- AF6: no UI → deny by default --------

test("AF6: prompt_without_ui_blocks_and_audits_deny", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      hasUI: false,
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    const result = await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-1",
      input: { path: "/outside/x.txt", content: "hi" },
    });

    assert.equal(result?.block, true);
    assert.ok(result?.reason?.toLowerCase().includes("no ui") || result?.reason);
  });
});

// -------- AF7: allow-once does not persist --------

test("AF7: allow_once_does_not_persist_to_memory", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => UI.allowOnce,
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // First call - allowed once
    await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-1",
      input: { path: "/outside/x.txt", content: "hi" },
    });

    // Second call - should prompt again (no memory written)
    let promptedCount = 0;
    const promptFn: UIChoiceHandler = async () => {
      promptedCount++;
      return UI.allowOnce;
    };
    ctx.ui.select = promptFn;

    await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-2",
      input: { path: "/outside/x.txt", content: "hi" },
    });

    assert.equal(promptedCount, 1, "should prompt again on second call");
  });
});

// -------- AF8: allow-session persists within session --------

test("AF8: allow_session_persists_within_session", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => UI.allowSession,
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // First call - allowed for session
    await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-1",
      input: { path: "/outside/x.txt", content: "hi" },
    });

    // Second call - should NOT prompt (session grant hit)
    let promptedCount = 0;
    ctx.ui.select = async () => {
      promptedCount++;
      return UI.deny;
    };

    await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-2",
      input: { path: "/outside/x.txt", content: "hi" },
    });

    assert.equal(promptedCount, 0, "should not prompt on second call (session grant)");
  });
});

// -------- AF9: allow-persistent persists across sessions --------

test("AF9: allow_persistent_persists_across_sessions", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );

    // Session 1: grant persistent
    const session1 = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => UI.alwaysAllow,
      projectRoot: "/proj",
    });

    registerPermissionGate(session1.pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    await fireToolCall(session1.pi, session1.ctx, {
      toolName: "write",
      toolCallId: "tc-1",
      input: { path: "/opt/x", content: "hi" },
    });

    // Wait for persistent write to complete.
    await new Promise((r) => setTimeout(r, 50));

    // Session 2: new store, should not prompt.
    const session2 = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => {
        throw new Error("should not prompt - persistent grant should be hit");
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(session2.pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    const result = await fireToolCall(session2.pi, session2.ctx, {
      toolName: "write",
      toolCallId: "tc-2",
      input: { path: "/opt/x", content: "hi" },
    });

    assert.equal(result, undefined, "should auto-allow from persistent grant");
  });
});

// -------- AF10: user deny writes audit --------

test("AF10: user_deny_writes_audit_record", async () => {  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => UI.deny,
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    const result = await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-deny-1",
      input: { path: "/outside/x.txt", content: "hi" },
    });

    assert.equal(result?.block, true);

    // Wait for audit log to flush
    await new Promise((r) => setTimeout(r, 100));

    const { readFile } = await import("node:fs/promises");
    const auditPath = join(dir, "logs", "permission-review.jsonl");
    const raw = await readFile(auditPath, "utf8").catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "expected at least one audit line");
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, "deny");
    assert.equal(record.toolCallId, "tc-deny-1");
  });
});

// -------- AF11: cross-source conflict emits `conflict_prompt` audit event --------

test("AF11: cross-source conflict + user_deny emits conflict_prompt event", async () => {
  await withTmpDir(async (dir) => {
    // Global: /opt/x = read_write
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "unread" } }),
      "utf8",
    );

    const projectRoot = join(dir, "proj");
    const projLocalDir = join(projectRoot, ".pi", "local");
    await mkdir(projLocalDir, { recursive: true });
    // Local: /opt/x = read_write (local wins by priority; conflicts with global unread)
    // → conflictInvolvesUnread=true → decision.conflict=true → prompt + conflict_prompt audit
    await (await import("node:fs/promises")).writeFile(
      join(projLocalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );

    const configPaths = {
      global: join(globalDir, "permission.json"),
      project: join(projectRoot, ".pi", "permission.json"),
      local: join(projLocalDir, "permission.json"),
    };

    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths,
      uiChoice: async () => UI.deny,
      projectRoot,
    });

    registerPermissionGate(pi, { trustedDir: dir, configPaths });

    const result = await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-conflict-1",
      input: { path: "/opt/x", content: "hi" },
    });

    assert.equal(result?.block, true, "conflict prompt + deny should block");

    await new Promise((r) => setTimeout(r, 100));

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(dir, "logs", "permission-review.jsonl"), "utf8").catch(() => "");
    const record = JSON.parse(raw.trim().split("\n")[0]);
    assert.equal(record.event, "conflict_prompt");
    assert.equal(record.toolCallId, "tc-conflict-1");
    assert.ok(record.note?.includes("conflict") || record.note?.includes("Conflicts"),
      `note should mention conflict, got: ${record.note}`);
  });
});

// -------- PF1: before_agent_start installs bash guardrails --------
//
// The bash extractor refuses to parse pipelines, unquoted globs, and other
// constructs. Every command hitting that path prompts with no persistent
// option. Rather than lean on the LLM to discover that after the fact, we
// seed systemPromptOptions.promptGuidelines at before_agent_start so the
// model prefers the read/grep/find tools first.

test("PF1: before_agent_start_appends_bash_guardrails_to_promptGuidelines", async () => {
  const handlers: Record<string, Function[]> = {};
  const pi: MockExtensionAPI = {
    on: (event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return () => {};
    },
    registerCommand: () => {},
    appendEntry: () => {},
  };

  registerPermissionGate(pi, { trustedDir: "/tmp/ignored" });

  // 1. Handler must be registered.
  const beforeAgentStart = handlers["before_agent_start"];
  assert.ok(Array.isArray(beforeAgentStart) && beforeAgentStart.length >= 1,
    "before_agent_start handler should be registered");

  // 2. Handler must mutate systemPromptOptions.promptGuidelines in place.
  const event: any = {
    type: "before_agent_start",
    prompt: "hi",
    systemPrompt: "(system)",
    systemPromptOptions: {
      promptGuidelines: [],
      selectedTools: ["read", "bash"],
      toolGuidelines: {},
      sections: {},
      contextFiles: [],
      skills: [],
      cwd: "/proj",
    },
  };
  await beforeAgentStart[0](event, {});

  const added = event.systemPromptOptions.promptGuidelines;
  assert.ok(Array.isArray(added) && added.length >= 3,
    `expected >= 3 guardrail bullets, got ${added?.length}`);
  // The guardrails are specifically about bash — verify by keyword coverage.
  const joined = added.join("\n").toLowerCase();
  assert.ok(/bash/.test(joined), "guardrails should mention bash");
  assert.ok(/pipe/.test(joined), "guardrails should mention pipes");
  assert.ok(/glob/.test(joined), "guardrails should mention globs");
  assert.ok(/grep|find/.test(joined), "guardrails should steer toward read tools");

  // Layer 1/2/3 三层结构关键词覆盖（bash-guardrails-popup-noise change）。
  // case-sensitive 断言——确保 Layer 标题与 Layer 3 的 `→` 符号原样保留。
  const joinedCs = added.join("\n");
  assert.ok(
    joinedCs.includes("Minimize prompts"),
    "Layer 1 must state the 'Minimize prompts' motivation",
  );
  assert.ok(
    joinedCs.includes("Prefer dedicated tools"),
    "Layer 2 must lead with the 'Prefer dedicated tools' header",
  );
  assert.ok(
    joinedCs.includes("auto-allowed"),
    "Layer 2 must explain the in-project read-only glob auto-allow boundary",
  );
  assert.ok(
    joinedCs.includes("Sensitive system paths"),
    "Layer 3 must include the Sensitive system paths reminder bullet",
  );
  assert.ok(
    joinedCs.includes("\u2192"),
    "Layer 3 bullets must use the → (U+2192) arrow to attach alternatives",
  );

  // 3. Idempotency: re-running on the same event must not duplicate.
  const beforeLen = added.length;
  await beforeAgentStart[0](event, {});
  assert.equal(event.systemPromptOptions.promptGuidelines.length, beforeLen,
    "guardrail injection must be idempotent");

  // 4. Existing guidelines from other extensions must be preserved.
  const otherHandlers: Record<string, Function[]> = {};
  const pi2: MockExtensionAPI = {
    on: (e, h) => { (otherHandlers[e] ??= []).push(h); return () => {}; },
    registerCommand: () => {},
    appendEntry: () => {},
  };
  registerPermissionGate(pi2, { trustedDir: "/tmp/ignored" });
  const ev2: any = {
    systemPromptOptions: {
      promptGuidelines: ["PRE-EXISTING RULE FROM OTHER EXTENSION"],
    },
  };
  await otherHandlers["before_agent_start"][0](ev2, {});
  assert.ok(
    ev2.systemPromptOptions.promptGuidelines.includes("PRE-EXISTING RULE FROM OTHER EXTENSION"),
    "must not drop existing promptGuidelines",
  );

  // 5. Must not throw on malformed event objects (guardrail injection must
  //    never break the agent loop).
  for (const broken of [undefined, null, {}, { systemPromptOptions: null }]) {
    try {
      await otherHandlers["before_agent_start"][0](broken as any, {});
    } catch (err) {
      assert.fail(`handler must not throw on malformed event: ${err}`);
    }
  }
});

// -------- AFS1: tier=two sensitive path prompt shows sensitive subtitle --------

test("AFS1: two_tier_prompt_shows_sensitive_subtitle", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    let capturedPrompt = "";
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (prompt) => {
        capturedPrompt = prompt;
        return UI.deny;
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // Read a sensitive outer file → tier=two, sensitive_default declaration
    await fireToolCall(pi, ctx, {
      toolName: "read",
      toolCallId: "tc-s1",
      input: { path: "/Users/x/.ssh/id_rsa" },
    });

    assert.ok(
      capturedPrompt.includes(uiText("subtitle_sensitive_hard_not_persistable")),
      `sensitive subtitle expected; got: ${capturedPrompt}`,
    );
    // Must NOT mention trusted.json (the bash-unreliable path is different)
    assert.ok(
      !capturedPrompt.includes("trusted.json"),
      `sensitive subtitle must not mention trusted.json; got: ${capturedPrompt}`,
    );
  });
});

// -------- AFS2: tier=two bash-unreliable prompt shows unreliable subtitle --------

test("AFS2: two_tier_prompt_shows_unreliable_bash_subtitle", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    let capturedPrompt = "";
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (prompt) => {
        capturedPrompt = prompt;
        return UI.deny;
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // Heredoc → unreliable bash, tier=two with bash_subtitle
    await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-s2",
      input: { command: "cat <<EOF\nhello\nEOF" },
    });

    assert.ok(
      capturedPrompt.includes(uiText("heredoc")),
      `unreliable bash subtitle expected; got: ${capturedPrompt}`,
    );
    // Must NOT mention permission.json (config cannot fix this)
    assert.ok(
      !capturedPrompt.toLowerCase().includes("permission.json"),
      `unreliable bash subtitle must not mention permission.json; got: ${capturedPrompt}`,
    );
  });
});

// ============================================================
// Phase 6 (bash-stage-b-security-fixes): C5 unread bypass
// for bash-command grant. SYS-B1..SYS-B4 in proposal's
// scenario→test coverage ledger.
//
// Flow: an unreliable bash command (e.g. `bash /tmp/evil.sh
// /etc/passwd` → shell_forwarder) with a session/persistent
// bash grant must still respect `unread` declarations. The
// C5 bypass scans bare-path tokens in the raw command and
// returns hard_deny if any resolve to unread.
// ============================================================

test("SYS-B1: bash session grant + unread path → hard_deny audit (grant bypassed)", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/etc/passwd": "unread" } }),
      "utf8",
    );

    const command = "bash /tmp/evil.sh /etc/passwd";
    let allowSessionCount = 0;
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) => {
        allowSessionCount++;
        // First time → UI.allowSession. Second time shouldn't
        // hit the prompt at all (grant should be active).
        return UI.allowSession;
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // First call: no grant yet, tier=two prompt → user picks UI.allowSession
    const firstResult = await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-c5-1",
      input: { command },
    });
    // First call should be allowed (choice is UI.allowSession)
    assert.equal(firstResult, undefined, "first call should be allowed (allow_session)");
    assert.equal(allowSessionCount, 1, "should have prompted once");

    // Second call: bash session grant should hit; C5 must bypass it
    // because /etc/passwd is unread.
    const secondResult = await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-c5-2",
      input: { command },
    });
    assert.equal(secondResult?.block, true, "second call should be hard-denied by C5");
    assert.equal(allowSessionCount, 1, "should NOT prompt again (grant hit, bypassed by unread)");

    // Wait for audit flush and verify the hard_deny event
    await new Promise((r) => setTimeout(r, 100));
    const { readFile } = await import("node:fs/promises");
    const auditPath = join(dir, "logs", "permission-review.jsonl");
    const raw = await readFile(auditPath, "utf8").catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const c5Line = lines.find((l) => l.toolCallId === "tc-c5-2");
    assert.ok(c5Line, "expected audit entry for tc-c5-2");
    assert.equal(c5Line.event, "hard_deny");
    assert.ok(
      String(c5Line.note).includes("Bash command grant bypassed"),
      `expected bypass note, got: ${c5Line.note}`,
    );
    assert.ok(
      String(c5Line.note).includes("/etc/passwd"),
      `expected path in note, got: ${c5Line.note}`,
    );
  });
});

test("SYS-B2: bash persistent grant + unread path → hard_deny (grant bypassed)", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/etc/passwd": "unread" } }),
      "utf8",
    );


    const command = "bash /tmp/evil.sh /etc/passwd";

    // Session 1: user picks "Always allow" → persistent bash grant written
    const session1 = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) => {
        return UI.alwaysAllowCmd;
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(session1.pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // First call: prompt → Always allow → persistent bash grant
    const firstResult = await fireToolCall(session1.pi, session1.ctx, {
      toolName: "bash",
      toolCallId: "tc-c5-p1",
      input: { command },
    });
    assert.equal(firstResult, undefined, "first call should be allowed");
    // Wait for persistent write
    await new Promise((r) => setTimeout(r, 50));

    // Session 2: new trust store, but persistent grant on disk should be
    // reloaded. Same unread config → C5 must still hard-deny.
    const session2 = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => {
        throw new Error("should not prompt - persistent bash grant should be hit");
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(session2.pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    const secondResult = await fireToolCall(session2.pi, session2.ctx, {
      toolName: "bash",
      toolCallId: "tc-c5-p2",
      input: { command },
    });
    assert.equal(secondResult?.block, true, "second session should hard-deny via C5");

    // Wait for audit and verify
    await new Promise((r) => setTimeout(r, 100));
    const { readFile } = await import("node:fs/promises");
    const auditPath = join(dir, "logs", "permission-review.jsonl");
    const raw = await readFile(auditPath, "utf8").catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const p2 = lines.find((l) => l.toolCallId === "tc-c5-p2");
    assert.ok(p2, "expected audit for tc-c5-p2");
    assert.equal(p2.event, "hard_deny");
    assert.ok(String(p2.note).includes("Bash command grant bypassed"));
  });
});

// D2 (reverse-spec 2026-10-27): reliable bash command (no grant) whose target
// hits an `unread` declaration must produce a hard_deny audit record that
// carries `authorization: "presumed"` — the same provenance as the file-tool
// hard_deny path (index.ts handleFileTool). Previously the reliable-bash
// hard_deny emit (index.ts handleBash) omitted the authorization field.
test("SYS-B2a: reliable_bash_unread_target_hard_deny_carries_presumed_authorization", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/etc/passwd": "unread" } }),
      "utf8",
    );

    // Reliable bash read command (cat is in READ_ONLY_COMMANDS) with a target
    // that is declared unread. No grant seeded → goes through decideTarget.
    const command = "cat /etc/passwd";
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    const result = await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-b2a",
      input: { command },
    });
    assert.equal(result?.block, true, "unread target should hard-deny the reliable bash command");

    await new Promise((r) => setTimeout(r, 100));
    const raw = await (await import("node:fs/promises")).readFile(
      join(dir, "logs", "permission-review.jsonl"),
      "utf8",
    ).catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.toolCallId === "tc-b2a");
    assert.ok(rec, "expected hard_deny audit for tc-b2a");
    assert.equal(rec.event, "hard_deny");
    assert.equal(rec.authorization, "presumed", "reliable-bash hard_deny MUST carry authorization: presumed");
    assert.equal("grant_source" in rec, false, "hard_deny MUST NOT carry grant_source");
  });
});

// D1 (reverse-spec 2026-10-27): a config-declared auto_allow (read_only read)
// MUST produce an audit record with event="auto_allow" and the decision's
// authorization/grant_source passed through (audit-log spec "auto_allow 从决策
// 对象透传"). Previously the file-tool auto_allow path (index.ts handleFileTool)
// returned undefined with no audit.log for config-declared / allow-rule reads.
test("SYS-B2b: config_declared_read_only_read_auto_allow_audited", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/etc/hosts": "read_only" } }),
      "utf8",
    );

    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // read of a read_only-declared path is auto_allow (decision.ts 1c).
    const result = await fireToolCall(pi, ctx, {
      toolName: "read",
      toolCallId: "tc-b2b",
      input: { path: "/etc/hosts" },
    });
    assert.equal(result, undefined, "read_only read should auto-allow (no block)");

    await new Promise((r) => setTimeout(r, 100));
    const raw = await (await import("node:fs/promises")).readFile(
      join(dir, "logs", "permission-review.jsonl"),
      "utf8",
    ).catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.toolCallId === "tc-b2b");
    assert.ok(rec, "expected auto_allow audit for config-declared read");
    assert.equal(rec.event, "auto_allow");
    assert.equal(rec.authorization, "presumed", "config-declared auto_allow is a system decision → presumed");
    assert.equal(rec.grant_source, "config_declaration", "grant_source must pass through from the decision");
  });
});

// D1 (reverse-spec 2026-10-27): reliable bash auto_allow (config-declared
// target) MUST produce a command-level auto_allow audit record with the
// decision's authorization/grant_source passed through.
test("SYS-B2c: reliable_bash_config_declared_auto_allow_audited", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/etc/hosts": "read_only" } }),
      "utf8",
    );

    // Reliable bash read command; /etc/hosts is read_only → auto_allow.
    const command = "cat /etc/hosts";
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    const result = await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-b2c",
      input: { command },
    });
    assert.equal(result, undefined, "reliable bash read_only read should auto-allow");

    await new Promise((r) => setTimeout(r, 100));
    const raw = await (await import("node:fs/promises")).readFile(
      join(dir, "logs", "permission-review.jsonl"),
      "utf8",
    ).catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.toolCallId === "tc-b2c");
    assert.ok(rec, "expected auto_allow audit for reliable bash config-declared target");
    assert.equal(rec.event, "auto_allow");
    assert.equal(rec.tool, "bash");
    assert.equal(rec.authorization, "presumed", "config-declared auto_allow → presumed");
    assert.equal(rec.grant_source, "config_declaration");
  });
});

test("SYS-B3: bash grant hit + no unread → grant still auto-allow", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    // Empty config — no unread anywhere
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    const command = "bash /tmp/evil.sh /tmp/x.txt";
    let promptCount = 0;
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) => {
        promptCount++;
        return UI.allowSession;
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // First call: prompt → allow session
    await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-c5-3a",
      input: { command },
    });
    assert.equal(promptCount, 1);

    // Second call: grant hit, no unread → auto_allow, no prompt
    const secondResult = await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-c5-3b",
      input: { command },
    });
    assert.equal(secondResult, undefined, "should auto-allow from grant");
    assert.equal(promptCount, 1, "should NOT prompt again");

    // Verify audit: no hard_deny for the second call
    await new Promise((r) => setTimeout(r, 100));
    const { readFile } = await import("node:fs/promises");
    const auditPath = join(dir, "logs", "permission-review.jsonl");
    const raw = await readFile(auditPath, "utf8").catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const secondLine = lines.find((l) => l.toolCallId === "tc-c5-3b");
    assert.ok(secondLine, "expected audit for second call");
    assert.equal(secondLine.event, "auto_allow");
  });
});

test("SYS-B4: bash grant + multi-path where ONE is unread → hard_deny", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    // /etc/passwd unread, /tmp/x.txt unconfigured
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/etc/passwd": "unread" } }),
      "utf8",
    );

    const command = "bash /tmp/evil.sh /tmp/x.txt /etc/passwd";
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) => UI.allowSession,
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // First: prompt → allow session
    await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-c5-4a",
      input: { command },
    });

    // Second: grant hit, C5 finds /etc/passwd → hard_deny
    const secondResult = await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-c5-4b",
      input: { command },
    });
    assert.equal(secondResult?.block, true);

    await new Promise((r) => setTimeout(r, 100));
    const { readFile } = await import("node:fs/promises");
    const auditPath = join(dir, "logs", "permission-review.jsonl");
    const raw = await readFile(auditPath, "utf8").catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const secondLine = lines.find((l) => l.toolCallId === "tc-c5-4b");
    assert.ok(secondLine);
    assert.equal(secondLine.event, "hard_deny");
    assert.ok(
      String(secondLine.note).includes("/etc/passwd"),
      `expected /etc/passwd in note, got: ${secondLine.note}`,
    );
  });
});

// ============================================================
// authorization-classification (D3 event→authorization + D4 grant_source)
// Verifies audit.log call sites emit correct authorization + grant_source.
// Also covers T4.2: bash grant memory hit → grant_source = bash_grant_memory.
// ============================================================

test("T-EXT-P1: allow_persistent_audit_carries_by_person_and_config_declaration", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    // Outer path declared read_write → tier=three prompt.
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => UI.alwaysAllow,
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });
    await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-p1",
      input: { path: "/opt/x", content: "hi" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const raw = await (await import("node:fs/promises")).readFile(
      join(dir, "logs", "permission-review.jsonl"),
      "utf8",
    ).catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.toolCallId === "tc-p1");
    assert.ok(rec, "expected audit record for tc-p1");
    assert.equal(rec.event, "allow_persistent");
    assert.equal(rec.authorization, "by_person");
    assert.equal(rec.grant_source, "config_declaration");
  });
});

test("T-EXT-P2: user_deny_audit_carries_by_person", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async () => UI.deny,
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });
    await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "tc-p2",
      input: { path: "/outside/x.txt", content: "hi" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const raw = await (await import("node:fs/promises")).readFile(
      join(dir, "logs", "permission-review.jsonl"),
      "utf8",
    ).catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.toolCallId === "tc-p2");
    assert.ok(rec);
    assert.equal(rec.event, "deny");
    assert.equal(rec.authorization, "by_person");
  });
});

test("T-EXT-F2: hard_deny_audit_carries_presumed", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/etc/shadow": "unread" } }),
      "utf8",
    );
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });
    await fireToolCall(pi, ctx, {
      toolName: "read",
      toolCallId: "tc-f2",
      input: { path: "/etc/shadow" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const raw = await (await import("node:fs/promises")).readFile(
      join(dir, "logs", "permission-review.jsonl"),
      "utf8",
    ).catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.toolCallId === "tc-f2");
    assert.ok(rec);
    assert.equal(rec.event, "hard_deny");
    assert.equal(rec.authorization, "presumed");
    // grant_source is intentionally omitted (undefined) for hard_deny
    // — it's not a grant event at all.
    assert.equal("grant_source" in rec, false, "hard_deny MUST NOT carry grant_source");
  });
});

test("T-EXT-P3: bash_session_grant_audit_grant_source_is_bash_grant_memory", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) =>
        UI.allowSession,
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });
    // Unreliable bash command → tier=two prompt → allow_session
    await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-p3",
      input: { command: "cat /tmp/*.log" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const raw = await (await import("node:fs/promises")).readFile(
      join(dir, "logs", "permission-review.jsonl"),
      "utf8",
    ).catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.toolCallId === "tc-p3");
    assert.ok(rec);
    assert.equal(rec.event, "allow_session");
    assert.equal(rec.authorization, "by_person");
    assert.equal(rec.grant_source, "bash_grant_memory");
  });
});

// T4.2 coverage: bash grant memory HIT → auto_allow audit with
// authorization by_person + grant_source bash_grant_memory.
test("T-EXT-B1: bash_grant_memory_hit_auto_allow_audit_carries_bash_grant_memory", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) =>
        UI.allowSession,
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });
    // First call: prompt + allow_session
    await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-b1-1",
      input: { command: "cat /tmp/*.log" },
    });
    // Second call: grant hit → auto_allow audit (bash memory hit path)
    await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-b1-2",
      input: { command: "cat /tmp/*.log" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const raw = await (await import("node:fs/promises")).readFile(
      join(dir, "logs", "permission-review.jsonl"),
      "utf8",
    ).catch(() => "");
    const lines = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const hit = lines.find((l) => l.toolCallId === "tc-b1-2");
    assert.ok(hit, "expected auto_allow audit for grant memory hit");
    assert.equal(hit.event, "auto_allow");
    assert.equal(hit.authorization, "by_person");
    assert.equal(hit.grant_source, "bash_grant_memory");
  });
});

// T4.1 coverage: path-based grant memory HIT → auto_allow audit with
// grant_source = grant_memory.
// We use a reliable bash target (write to a path under a persistent grant)
// so the flow reaches the audit.log auto_allow emit for path grants.
//
// Note: reliable bash auto_allow decisions do NOT emit audit records in
// the current extension (baseline behavior — audit-log spec only requires
// all decisions "except routine project_inner non-sensitive" to be logged,
// and this path is inside an already-authorized path). The path-based
// grant_source = grant_memory is verified at the decide() level (T-DEC-*)
// and at the trust level (T-TRUST-LA-*); E2E confirmation here is limited
// to the observable audit behavior.
test("T-EXT-G1: path_grant_memory_hit_produces_auto_allow_decision", async () => {
  // This is a unit-level integration check: seed a persistent grant,
  // then verify lookupGrantAuthor returns by_person so that
  // decideTarget's auto_allow branches correctly.
  const { createTrustStore } = await import("../src/lib/trust.ts");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pi-ext-g1-"));
  try {
    const path = join(dir, "trusted.json");
    const store = await createTrustStore(path);
    await store.addPersistentGrant({
      projectHash: "projA",
      action: "read",
      path: "/opt/authorized",
      permission: "read_write",
    });
    const author = store.lookupGrantAuthor("projA", "read", "/opt/authorized");
    assert.equal(author, "by_person", "persistent grant memory hit → by_person author");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// permission-toggle (P3): gate disabled → tool_call no-op
// ============================================================

test("PT1: gate_disabled_returns_undefined_no_op", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );
    // settings.json with enabled: false
    await (await import("node:fs/promises")).writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ enabled: false }),
      "utf8",
    );

    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // A write to an outer read_write path would normally prompt. But gate is
    // disabled → tool_call returns undefined (no-op, pi handles natively).
    const result = await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "pt1",
      input: { path: "/opt/x", content: "y" },
    });
    assert.equal(result, undefined, "disabled gate → no-op (undefined)");
  });
});

test("PT2: gate_enabled_default_prompts_normally", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );
    // No settings.json → enabled defaults true → gate active (prompts).
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    const result = await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "pt2",
      input: { path: "/opt/x", content: "y" },
    });
    // Wait for the fire-and-forget audit queue to drain.
    await new Promise((r) => setTimeout(r, 80));
    // Gate active → prompt shown → default choice allow_once → no block
    // (undefined result), BUT the gate RAN: it wrote an audit log entry
    // for the decision. The distinguishing signal vs the disabled no-op is
    // the audit log (disabled gate writes nothing).
    const auditFile = join(dir, "logs", "permission-review.jsonl");
    const raw = await readFile(auditFile, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.ok(lines.length > 0, "enabled gate → audit log written (gate ran)");
  });
});

// ============================================================
// permission-toggle (P3): /permission slash command
// ============================================================

test("PT3: permission_command_toggles_off_and_persists", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );
    // No settings.json → enabled defaults true.
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // /permission off
    const cmd = (pi as any)._commands["permission"];
    assert.ok(cmd, "permission command should be registered");
    await cmd.handler("off", ctx);

    // settings.json should now have enabled: false
    const settingsFile = join(dir, "settings.json");
    const raw = await readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.enabled, false, "settings.json should have enabled: false");

    // Gate should now be disabled → tool_call no-op.
    const result = await fireToolCall(pi, ctx, {
      toolName: "write",
      toolCallId: "pt3",
      input: { path: "/opt/x", content: "y" },
    });
    assert.equal(result, undefined, "after /permission off → no-op");
  });
});

test("PT4: permission_command_toggles_on_and_persists", async () => {
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      "utf8",
    );
    // Start disabled.
    await (await import("node:fs/promises")).writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ enabled: false }),
      "utf8",
    );
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      projectRoot: "/proj",
    });

    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // /permission on
    const cmd = (pi as any)._commands["permission"];
    await cmd.handler("on", ctx);

    const settingsFile = join(dir, "settings.json");
    const raw = await readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.enabled, true, "settings.json should have enabled: true");
  });
});

// ============================================================
// tier-contract-consistency A1: unreliable bash → tier=three with
// "Always allow this command" (bash_grant_memory persistent grant)
// ============================================================

test("AF1-A1: unreliable bash prompt shows FOUR options (tier=three)", async () => {
  // After A1: unreliable bash moves from tier=two to tier=three, so the
  // prompt must offer "Always allow this command" (rawCommand persistable).
  // Before A1 GREEN this test fails — the tier=two branch hides the
  // "Always allow" option for bash-unreliable prompts.
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    let capturedChoices: string[] | undefined;
    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) => {
        capturedChoices = choices;
        return UI.deny;
      },
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // Heredoc → unreliable bash → should be tier=three (4 options)
    await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-a1-four",
      input: { command: "cat <<EOF\nhello\nEOF" },
    });

    assert.ok(capturedChoices, "prompt must have been shown");
    assert.equal(
      capturedChoices!.length,
      4,
      `unreliable bash should show 4 options (tier=three); got ${capturedChoices!.length}: ${capturedChoices!.join(", ")}`,
    );
    assert.ok(
      capturedChoices!.some((c) => c.startsWith(UI.alwaysAllow.slice(0, 4)) || c.startsWith("Always allow")),
      `unreliable bash prompt must offer "Always allow"; got: ${capturedChoices!.join(", ")}`,
    );
  });
});

test("AF2-A1: unreliable bash \"always allow this command\" persists to bashGrants", async () => {
  // A1 critical regression protection: after user picks "Always allow this
  // command", a persistent bash grant must be written to trusted.json so
  // the same rawCommand auto-allows across sessions. Without A1, tier=two
  // never offers this option, so this test fails with no persistent grant.
  await withTmpDir(async (dir) => {
    const globalDir = join(dir, "global");
    await mkdir(globalDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(
      join(globalDir, "permission.json"),
      "{}",
      "utf8",
    );

    const { pi, ctx } = createMockPi({
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
      uiChoice: async (_p, choices) => {
        return UI.alwaysAllowCmd;
      },
      projectRoot: "/proj",
    });
    registerPermissionGate(pi, {
      trustedDir: dir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join("/proj", ".pi/permission.json"),
        local: join("/proj", ".pi/local/permission.json"),
      },
    });

    // Fire an unreliable bash command. The uiChoice handler picks "Always allow..."
    await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-a1-persist",
      input: { command: "cat $SECRETS" },
    });

    // Give the trust store time to write trusted.json
    await new Promise((r) => setTimeout(r, 200));

    // Verify bashGrants entry was written
    const trustPath = join(dir, "trusted.json");
    const trustRaw = await (await import("node:fs/promises")).readFile(trustPath, "utf8").catch(() => "");
    const trust = JSON.parse(trustRaw || "{}");
    const bashGrants = (trust.bashGrants ?? []) as any[];
    assert.ok(
      bashGrants.length >= 1,
      `expected at least 1 bash grant to be persisted after "Always allow this command"; got: ${JSON.stringify(trust)}`,
    );
    assert.ok(
      bashGrants.some((g) => g.rawCommand === "cat $SECRETS"),
      `expected bash grant for exact rawCommand 'cat $SECRETS'; got: ${JSON.stringify(bashGrants)}`,
    );

    // Verify the audit log has event=allow_persistent with grant_source=bash_grant_memory
    const logPath = join(dir, "logs", "permission-review.jsonl");
    const logRaw = await (await import("node:fs/promises")).readFile(logPath, "utf8").catch(() => "");
    const lines = logRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.toolCallId === "tc-a1-persist");
    assert.ok(rec, "audit record must exist for tc-a1-persist");
    assert.equal(rec.event, "allow_persistent");
    assert.equal(rec.grant_source, "bash_grant_memory");
  });
});
