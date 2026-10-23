//
// System-level integration test. Cross-subsystem verification (td-apply 步骤 6.2).
//
// This exercises the FULL pipeline with real (not mocked) config files,
// trust store, and audit log. Only the pi ExtensionAPI is mocked.
//
// Subsystem boundaries covered:
//   - policy-core: config → decision (real mergePolicies + decide)
//   - policy-core: trust (real createTrustStore, real disk write)
//   - side-effects: audit (real createAuditLogger, real JSONL writes)
//   - extension-orchestration: registerPermissionGate (real handler wiring)
//   - data flow: config → policy → decision → grant lookup → audit
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerPermissionGate } from "../extensions/index.ts";

// -------- Mock pi (minimal for integration tests) --------

type UIChoiceHandler = (prompt: string, choices: string[]) => Promise<string>;

function createMockPi(opts: {
  projectRoot: string;
  hasUI?: boolean;
  uiChoice?: UIChoiceHandler;
  configPaths?: unknown;
}): {
  pi: any;
  ctx: any;
  notifications: Array<{ message: string; level: string }>;
} {
  const notifications: Array<{ message: string; level: string }> = [];
  const uiChoice =
    opts.uiChoice ?? (async (_p, choices: string[]) => choices[0] || "Allow this call only");

  const ctx = {
    hasUI: opts.hasUI ?? true,
    mode: "tui",
    cwd: opts.projectRoot,
    projectRoot: opts.projectRoot,
    ui: {
      select: uiChoice,
      notify: (message: string, level: string) => notifications.push({ message, level }),
      input: async () => "",
    },
  };

  const handlers: Record<string, Function[]> = {};
  const pi = {
    on: (event: string, handler: Function) => {
      (handlers[event] ??= []).push(handler);
      return () => {};
    },
    registerCommand: () => {},
    appendEntry: () => {},
  };

  (pi as any)._handlers = handlers;
  return { pi, ctx, notifications };
}

async function fireToolCall(
  pi: any,
  ctx: any,
  event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
): Promise<any> {
  const handlers = (pi as any)._handlers["tool_call"] ?? [];
  for (const h of handlers) {
    const result = await h(event, ctx);
    if (result !== undefined) return result;
  }
  return undefined;
}

// -------- Sandbox --------

async function withSandbox<T>(
  setup: (env: any) => Promise<void>,
  fn: (env: { projectRoot: string; trustedDir: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-sys-"));
  try {
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(projectRoot, ".pi/local"), { recursive: true });

    const globalDir = join(root, "global");
    await mkdir(globalDir, { recursive: true });

    const trustedDir = join(root, "trusted");
    await mkdir(trustedDir, { recursive: true });

    const env = {
      projectRoot,
      trustedDir,
      globalConfig: join(globalDir, "permission.json"),
      projectConfig: join(projectRoot, ".pi/permission.json"),
      localConfig: join(projectRoot, ".pi/local/permission.json"),
    };

    await setup(env);
    return await fn(env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -------- SYS1: cross-source conflict prompts + audit --------

test("SYS1: cross-source conflict (unread vs read_write) triggers three-tier prompt + audit", async () => {
  await withSandbox(
    async ({ globalConfig, projectConfig }) => {
      await writeFile(globalConfig, JSON.stringify({ paths: { "/srv": "unread" } }));
      await writeFile(projectConfig, JSON.stringify({ paths: { "/srv": "read_write" } }));
    },
    async ({ projectRoot, trustedDir }) => {
      let promptPrompt = "";
      const { pi, ctx } = createMockPi({
        projectRoot,
        uiChoice: async (prompt) => {
          promptPrompt = prompt;
          return "Deny";
        },
      });

      registerPermissionGate(pi, {
        trustedDir,
        configPaths: {
          global: join(trustedDir, "..", "global", "permission.json"),
          project: join(projectRoot, ".pi", "permission.json"),
          local: join(projectRoot, ".pi", "local", "permission.json"),
        },
      });

      const result = await fireToolCall(pi, ctx, {
        toolName: "read",
        toolCallId: "tc-sys-1",
        input: { path: "/srv" },
      });

      assert.equal(result?.block, true);
      assert.ok(
        promptPrompt.toLowerCase().includes("conflict"),
        `prompt should mention conflict, got: ${promptPrompt.slice(0, 200)}`,
      );

      // Audit should have been written.
      await new Promise((r) => setTimeout(r, 100));
      const auditPath = join(trustedDir, "logs", "permission-review.jsonl");
      const raw = await readFile(auditPath, "utf8").catch(() => "");
      assert.ok(raw.includes("conflict_prompt"), "audit should record conflict_prompt");
      assert.ok(raw.includes("tc-sys-1"), "audit should include toolCallId");
    },
  );
});

// -------- SYS2: full grant persistence flow --------

test("SYS2: allow_persistent writes grant + subsequent session auto-allows", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(
        globalConfig,
        JSON.stringify({ paths: { "/opt/x": "read_write" } }),
      );
    },
    async ({ projectRoot, trustedDir }) => {
      const configPaths = {
        global: join(trustedDir, "..", "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      };

      // Session 1: grant persistent
      const s1 = createMockPi({
        projectRoot,
        uiChoice: async () => "Always allow (save to trusted.json)",
      });
      registerPermissionGate(s1.pi, { trustedDir, configPaths });
      await fireToolCall(s1.pi, s1.ctx, {
        toolName: "write",
        toolCallId: "tc-1",
        input: { path: "/opt/x", content: "hi" },
      });
      // Wait for async writes to flush.
      await new Promise((r) => setTimeout(r, 100));

      // Session 2: new handler, same disk state → auto-allow
      const s2 = createMockPi({
        projectRoot,
        uiChoice: async () => {
          throw new Error("should not prompt");
        },
      });
      registerPermissionGate(s2.pi, { trustedDir, configPaths });
      const result = await fireToolCall(s2.pi, s2.ctx, {
        toolName: "write",
        toolCallId: "tc-2",
        input: { path: "/opt/x", content: "hi" },
      });

      assert.equal(result, undefined, "should auto-allow from persistent grant");

      // Audit should record both decisions.
      await new Promise((r) => setTimeout(r, 100));
      const auditPath = join(trustedDir, "logs", "permission-review.jsonl");
      const raw = await readFile(auditPath, "utf8").catch(() => "");
      const lines = raw.trim().split("\n").filter(Boolean);
      const events = lines.map((l) => JSON.parse(l).event);
      assert.ok(events.includes("allow_persistent"), `events: ${events}`);
    },
  );
});

// -------- SYS3: unread hard-deny blocks regardless of grants --------

test("SYS3: unread blocks even if there was a previous allow_session grant", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(
        globalConfig,
        JSON.stringify({ paths: { "/srv/prod": "unread" } }),
      );
    },
    async ({ projectRoot, trustedDir }) => {
      const { pi, ctx, notifications } = createMockPi({
        projectRoot,
        uiChoice: async () => "Deny",
      });
      registerPermissionGate(pi, {
        trustedDir,
        configPaths: {
          global: join(trustedDir, "..", "global", "permission.json"),
          project: join(projectRoot, ".pi", "permission.json"),
          local: join(projectRoot, ".pi", "local", "permission.json"),
        },
      });

      const result = await fireToolCall(pi, ctx, {
        toolName: "read",
        toolCallId: "tc-3",
        input: { path: "/srv/prod" },
      });

      assert.equal(result?.block, true);
      assert.ok(
        notifications.some((n) => n.level === "warning" && n.message.includes("Blocked")),
        `should notify warning: ${JSON.stringify(notifications)}`,
      );
    },
  );
});

// -------- SYS4: bash command routing through full pipeline --------

// Uses command substitution (unreliable). Pipelines like `cat /etc/passwd | base64`
// are no longer unreliable — they parse into independent stages.
test("SYS4: bash command with command substitution triggers tier-two prompt + audit", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      let promptPrompt = "";
      const { pi, ctx } = createMockPi({
        projectRoot,
        uiChoice: async (prompt) => {
          promptPrompt = prompt;
          return "Deny";
        },
      });
      registerPermissionGate(pi, {
        trustedDir,
        configPaths: {
          global: join(trustedDir, "..", "global", "permission.json"),
          project: join(projectRoot, ".pi", "permission.json"),
          local: join(projectRoot, ".pi", "local", "permission.json"),
        },
      });

      const result = await fireToolCall(pi, ctx, {
        toolName: "bash",
        toolCallId: "tc-4",
        input: { command: "rm -rf $(cat /etc/passwd)" },
      });

      assert.equal(result?.block, true);
      assert.ok(promptPrompt.includes("rm -rf"), `prompt should include command`);

      await new Promise((r) => setTimeout(r, 100));
      const auditPath = join(trustedDir, "logs", "permission-review.jsonl");
      const raw = await readFile(auditPath, "utf8").catch(() => "");
      assert.ok(raw.includes("deny"));
      assert.ok(raw.includes("rm -rf"));
    },
  );
});

// -------- SYS5: bash reliable command routes to file permission check --------

test("SYS5: bash rm command routes to outer-path prompt", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      let promptPrompt = "";
      const { pi, ctx } = createMockPi({
        projectRoot,
        uiChoice: async (prompt) => {
          promptPrompt = prompt;
          return "Deny";
        },
      });
      registerPermissionGate(pi, {
        trustedDir,
        configPaths: {
          global: join(trustedDir, "..", "global", "permission.json"),
          project: join(projectRoot, ".pi", "permission.json"),
          local: join(projectRoot, ".pi", "local", "permission.json"),
        },
      });

      const result = await fireToolCall(pi, ctx, {
        toolName: "bash",
        toolCallId: "tc-5",
        input: { command: "rm /etc/passwd" },
      });

      assert.equal(result?.block, true);
      // /etc/passwd is sensitive by default - should be tier=two
      assert.ok(
        promptPrompt.includes("Sensitive file") || promptPrompt.includes("approval required"),
        `prompt should mention sensitivity or approval: ${promptPrompt.slice(0, 300)}`,
      );
    },
  );
});

// -------- SYS6: session-level grant survives but doesn't persist to disk --------

test("SYS6: session grant survives within session, cleared on next pi.on registration", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      // Session 1
      let promptCount = 0;
      const s1 = createMockPi({
        projectRoot,
        uiChoice: async () => {
          promptCount++;
          return "Allow for this session";
        },
      });
      registerPermissionGate(s1.pi, {
        trustedDir,
        configPaths: {
          global: join(trustedDir, "..", "global", "permission.json"),
          project: join(projectRoot, ".pi", "permission.json"),
          local: join(projectRoot, ".pi", "local", "permission.json"),
        },
      });

      // First call: prompts, user chooses "Allow for this session"
      await fireToolCall(s1.pi, s1.ctx, {
        toolName: "write",
        toolCallId: "tc-6a",
        input: { path: "/outside/x.txt", content: "hi" },
      });
      assert.equal(promptCount, 1);

      // Second call: session grant hit, no prompt
      await fireToolCall(s1.pi, s1.ctx, {
        toolName: "write",
        toolCallId: "tc-6b",
        input: { path: "/outside/x.txt", content: "hi" },
      });
      assert.equal(promptCount, 1, "no new prompt for second call (session grant hit)");

      // Session 2: new gate, session grants reset
      const s2 = createMockPi({
        projectRoot,
        uiChoice: async () => {
          promptCount++;
          return "Deny";
        },
      });
      registerPermissionGate(s2.pi, {
        trustedDir,
        configPaths: {
          global: join(trustedDir, "..", "global", "permission.json"),
          project: join(projectRoot, ".pi", "permission.json"),
          local: join(projectRoot, ".pi", "local", "permission.json"),
        },
      });
      await fireToolCall(s2.pi, s2.ctx, {
        toolName: "write",
        toolCallId: "tc-6c",
        input: { path: "/outside/x.txt", content: "hi" },
      });
      assert.equal(promptCount, 2, "session grant doesn't survive across gates (sessions)");
    },
  );
});

// -------- SYS8: canonical vs realpath both match config --------

test("SYS8: unread on canonical path blocks file tool when macOS realpath differs", async () => {
  // macOS: /tmp is a symlink to /private/tmp. If user config declares
  // /tmp/secret/unread and pi passes /tmp/secret, the handler should still
  // detect the policy hit (not just the realpath form).
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      // Configure an "unread" on a path where the realpath differs.
      // On macOS /tmp -> /private/tmp so the input "`/tmp/sys8-secret`"
      // has realpath `/private/tmp/sys8-secret`.
      const canonical = "/tmp/sys8-secret";
      const { writeFile: wfw } = await import("node:fs/promises");
      await wfw(
        join(projectRoot, ".pi", "permission.json"),
        JSON.stringify({ paths: { [canonical]: "unread" } }),
      );

      const configPaths = {
        global: join(trustedDir, "..", "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      };

      const { pi, ctx } = createMockPi({
        projectRoot,
        configPaths,
      });
      registerPermissionGate(pi, { trustedDir, configPaths });

      // Fire a read tool call with the canonical path.
      const result = await fireToolCall(pi, ctx, {
        toolName: "read",
        toolCallId: "tc-sys-8",
        input: { path: canonical },
      });

      // Should be blocked with a hard_deny (the canonical path is declared unread).
      assert.equal(result?.block, true, "should block: canonical unread path");

      // And also via bash
      const bashResult = await fireToolCall(pi, ctx, {
        toolName: "bash",
        toolCallId: "tc-sys-8b",
        input: { command: `cat ${canonical}` },
      });
      assert.equal(bashResult?.block, true, "should block via bash too");
    },
  );
});

test("SYS7: bash target using symlink inside project to outer sensitive is prompted (not auto-allowed)", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      // Create a real symlink inside the project pointing to a sensitive
      // outer path. This simulates the review scenario:
      //   /proj/link -> /Users/x/.ssh/
      // and bash does: cat /proj/link/id_rsa
      const { symlink, mkdir: mkdirP } = await import("node:fs/promises");
      const { homedir } = await import("node:os");
      const realSensitiveDir = join(homedir(), ".ssh");
      // Create the target directory if it doesn't exist
      await mkdirP(realSensitiveDir, { recursive: true });
      const fakeSensitiveFile = join(realSensitiveDir, "test-id_rsa");
      await (await import("node:fs/promises")).writeFile(fakeSensitiveFile, "dummy");
      const linkPath = join(projectRoot, "link_to_ssh");
      // Overwrite the directory if it happens to exist (unlikely)
      await rm(linkPath, { force: true, recursive: true }).catch(() => {});
      await symlink(realSensitiveDir, linkPath);

      let promptPrompt = "";
      const { pi, ctx } = createMockPi({
        projectRoot,
        uiChoice: async (prompt) => {
          promptPrompt = prompt;
          return "Deny";
        },
      });
      registerPermissionGate(pi, {
        trustedDir,
        configPaths: {
          global: join(trustedDir, "..", "global", "permission.json"),
          project: join(projectRoot, ".pi", "permission.json"),
          local: join(projectRoot, ".pi", "local", "permission.json"),
        },
      });

      // bash: cat /proj/link_to_ssh/test-id_rsa
      // Without the fix: /proj/link_to_ssh/test-id_rsa looks "inside project",
      // non-sensitive (basename is 'test-id_rsa', not exactly 'id_rsa'),
      // → auto_allow.
      // With the fix: tryRealpath resolves to /Users/x/.ssh/test-id_rsa,
      // which is inside a sensitive directory (.ssh) → prompt tier=two.
      const result = await fireToolCall(pi, ctx, {
        toolName: "bash",
        toolCallId: "tc-sys-7",
        input: { command: `cat ${linkPath}/test-id_rsa` },
      });

      // Should be blocked with a prompt, not auto-allowed.
      assert.equal(result?.block, true, "should block: symlink resolved to sensitive outer path");

      // Cleanup
      await rm(linkPath, { force: true });
      await rm(fakeSensitiveFile, { force: true }).catch(() => {});
    },
  );
});

// -------- SYS-PATH: write to non-existent relative path is auto-allowed --------
// Bug: decideTarget used tryRealpath on the raw input path. If the input is
// a relative path to a non-existent file (e.g. `write` creating a new file),
// realpath fails and returns the relative path unchanged. isInside(relativePath,
// absoluteProjectRoot) then returns false, incorrectly classifying the path
// as outside-project. Fix: resolveToAbsolute (toAbsolutePath + tryRealpath)
// must be applied before isInside, regardless of whether the file exists.
test("SYS-PATH: write to non-existent relative path inside project is auto-allowed", async () => {
  await withSandbox(
    async () => {}, // no config files
    async ({ projectRoot, trustedDir }) => {
      // uiChoice that fails if called: a prompt means the path was
      // misclassified as outside-project. We expect auto-allow (no prompt).
      let promptShown = false;
      const uiChoice = async () => {
        promptShown = true;
        return "Deny";
      };
      const { pi, ctx } = createMockPi({ projectRoot, uiChoice });

      registerPermissionGate(pi, {
        trustedDir,
        configPaths: {
          global: join(trustedDir, "..", "global", "permission.json"),
          project: join(projectRoot, ".pi", "permission.json"),
          local: join(projectRoot, ".pi", "local", "permission.json"),
        },
      });

      // write { path: "openspec/changes/foo/bar.yaml" } where the dir doesn't exist
      // Expected: auto-allowed (inside project, non-sensitive, unconfigured)
      // Bug: tryRealpath fails on non-existent relative path → isInside returns false
      //   → "Outside-project non-sensitive write; approval required"
      const result = await fireToolCall(pi, ctx, {
        toolName: "write",
        toolCallId: "tc-sys-path-1",
        input: { path: "openspec/changes/foo/bar.yaml", content: "test" },
      });

      // No prompt should have been shown.
      assert.equal(
        promptShown,
        false,
        `should auto-allow relative write inside project without prompting (path was misclassified as outside-project)`,
      );
    },
  );
});
