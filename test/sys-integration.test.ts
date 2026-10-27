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
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { registerPermissionGate } from "../extensions/index.ts";
import { t } from "../src/lib/i18n.ts";
import { detectLang } from "../src/lib/lang-detect.ts";

// i18n-aware UI choice strings (see extensions/index.test.ts for rationale).
// Uses detectLang() so tests work regardless of dev env LANG.
const UI = {
  allowOnce: t("choice_allow_once", detectLang(process.env, {})),
  allowSession: t("choice_allow_session", detectLang(process.env, {})),
  alwaysAllow: t("choice_always_allow", detectLang(process.env, {})),
  alwaysAllowCmd: t("choice_always_allow_command", detectLang(process.env, {}), { path: "trusted.json" }),
  deny: t("choice_deny", detectLang(process.env, {})),
};

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
    opts.uiChoice ?? (async (_p, choices: string[]) => choices[0] || UI.allowOnce);

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
          return UI.deny;
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
        uiChoice: async () => UI.alwaysAllow,
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
        uiChoice: async () => UI.deny,
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
        notifications.some((n) => n.level === "warning" && (n.message.includes("Blocked") || n.message.includes("已阻断"))),
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
          return UI.deny;
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
          return UI.deny;
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
          return UI.allowSession;
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

      // First call: prompts, user chooses UI.allowSession
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
          return UI.deny;
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
          return UI.deny;
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
        return UI.deny;
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

// -------- SYS-GRANT: bash symlink target persistent grant reused --------
// Bug (V3): handleBash reliable 分支 prompt 时以 resolvedPath（realpath）存
// 持久 grant，下次 decideTarget 第一次调用以 target.path（字面路径）查
// hasGrant 键不匹配 → 持久 grant 永不命中 → 反复弹窗。
// Fix: decideTarget grant 查询查 absPath || canonicalPath 两键，让 bash 链路
// 的 canonicalPath（= resolvedPath）命中写入端键。
test("SYS-GRANT: bash symlink target persistent grant reused on second call", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      const { symlink, writeFile: wf } = await import("node:fs/promises");
      // 外区非敏感目录必须真正落在 /tmp 之外：Linux CI 的 tmpdir()=/tmp，
      // 若 outerDir 仍在 sandbox（/tmp/pi-sys-*）下，decision step 2c 的
      // isDefaultTmpPath 会把这条外区 write 当成 scratch 写入自动放行，
      // 第一次就不弹窗，V3 grant-key 修复无从验证。改用 homedir 下独立
      // mkdtemp：不在 /tmp、非敏感（无 .ssh/.aws 等凭证目录）。它在
      // sandbox 之外，withSandbox 的 rm(root) 不会回收，需 try/finally 清理。
      const outerDir = await mkdtemp(join(homedir(), "pi-sys-grant-"));
      // 项目内符号链接 → 外区目录
      const linkPath = join(projectRoot, "link_to_outer");
      try {
        await wf(join(outerDir, "file.txt"), "dummy");
        await rm(linkPath, { force: true, recursive: true }).catch(() => {});
        await symlink(outerDir, linkPath);

        let promptCount = 0;
        const { pi, ctx } = createMockPi({
          projectRoot,
          uiChoice: async () => {
            promptCount++;
            return UI.alwaysAllow;
          },
        });
        registerPermissionGate(pi, {
          trustedDir,
          configPaths: {
            global: join(trustedDir, "..", "global", "permission.json"),
            project: join(projectRoot, ".pi", "permission.json"),
            local: join(projectRoot, ".pi/local/permission.json"),
          },
        });

        const command = `truncate -s 0 ${join(linkPath, "file.txt")}`;

        // 第一次：外区非敏感 write → tier=three prompt → "Always allow" 存 grant(resolvedPath)
        promptCount = 0;
        const r1 = await fireToolCall(pi, ctx, {
          toolName: "bash",
          toolCallId: "tc-grant-1",
          input: { command },
        });
        assert.equal(promptCount, 1, "first call should prompt tier=three");
        assert.equal(r1, undefined, "first call should be allowed (Always allow)");

        // 第二次：同命令。V3 bug → 重弹（promptCount=1）。
        // Fix → grant 命中 → auto_allow（promptCount=0, r2=undefined）。
        promptCount = 0;
        const r2 = await fireToolCall(pi, ctx, {
          toolName: "bash",
          toolCallId: "tc-grant-2",
          input: { command },
        });
        assert.equal(promptCount, 0, "second call should NOT prompt (persistent grant hit)");
        assert.equal(r2, undefined, "second call should auto-allow (grant memory hit)");
      } finally {
        // Cleanup：outerDir 在 sandbox 之外，rm(root) 不会回收它。
        await rm(linkPath, { force: true, recursive: true }).catch(() => {});
        await rm(outerDir, { force: true, recursive: true }).catch(() => {});
      }
    },
  );
});

// ============================================================
// sensitive-soft-pardonable-set: cross-subsystem integration
// Boundary: sensitive-path-classification × access-decision × grant-memory
// Verifies the full pipeline end-to-end: sensitive.level → decide() tier
// dispatch → promptUser option gating → addPersistentGrant / no-grant.
// ============================================================

test("SYS-SOFT: soft outer config.yml read prompts tier three and persists", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      const configPaths = {
        global: join(trustedDir, "..", "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      };
      // Outer, non-hard path whose basename matches soft (<name>.<ext>).
      // dirname is the sandbox root — no .ssh/.aws overlap, so soft wins.
      const configYml = join(projectRoot, "..", "config.yml");
      let choices: string[] = [];

      // Session 1: first read → tier=three prompt, "Always allow" offered.
      const s1 = createMockPi({
        projectRoot,
        uiChoice: async (_p, c) => {
          choices = c;
          return UI.alwaysAllow;
        },
      });
      registerPermissionGate(s1.pi, { trustedDir, configPaths });
      const r1 = await fireToolCall(s1.pi, s1.ctx, {
        toolName: "read",
        toolCallId: "tc-soft-1",
        input: { path: configYml },
      });
      assert.equal(r1, undefined, "first read allowed");
      assert.ok(
        choices.some((c) => c.startsWith(UI.alwaysAllow.slice(0, 4)) || c.startsWith("Always allow")),
        `soft outer read must offer "Always allow" (tier=three), got: ${choices}`,
      );
      // Let async trusted.json writes flush before the next session loads it.
      await new Promise((r) => setTimeout(r, 100));

      // Session 2: fresh handler + fresh state, same disk → the persistent
      // grant must hit and auto-allow WITHOUT prompting.
      const s2 = createMockPi({
        projectRoot,
        uiChoice: async () => {
          throw new Error("should not prompt (persistent grant hit)");
        },
      });
      registerPermissionGate(s2.pi, { trustedDir, configPaths });
      const r2 = await fireToolCall(s2.pi, s2.ctx, {
        toolName: "read",
        toolCallId: "tc-soft-2",
        input: { path: configYml },
      });
      assert.equal(r2, undefined, "second read auto-allows from persistent grant");
    },
  );
});

test("SYS-SOFT: soft outer config.yml write also persists across sessions", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      const configPaths = {
        global: join(trustedDir, "..", "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      };
      const configYml = join(projectRoot, "..", "config.yml");
      let choices: string[] = [];

      // decide() step 2b is action-agnostic, so soft loosens outer WRITE
      // together with read — tier=three, "Always allow" available.
      const s1 = createMockPi({
        projectRoot,
        uiChoice: async (_p, c) => {
          choices = c;
          return UI.alwaysAllow;
        },
      });
      registerPermissionGate(s1.pi, { trustedDir, configPaths });
      const r1 = await fireToolCall(s1.pi, s1.ctx, {
        toolName: "write",
        toolCallId: "tc-soft-w1",
        input: { path: configYml, content: "x" },
      });
      assert.equal(r1, undefined, "outer write allowed");
      assert.ok(
        choices.some((c) => c.startsWith(UI.alwaysAllow.slice(0, 4)) || c.startsWith("Always allow")),
        `soft outer write must offer "Always allow" (tier=three), got: ${choices}`,
      );
      await new Promise((r) => setTimeout(r, 100));

      // Second session, mirroring the read-side test: proves the write grant
      // actually landed on disk. Asserting only the offered option would let a
      // write-path `addPersistentGrant` regression pass silently.
      let prompted = false;
      const s2 = createMockPi({
        projectRoot,
        uiChoice: async () => {
          prompted = true;
          return UI.deny;
        },
      });
      registerPermissionGate(s2.pi, { trustedDir, configPaths });
      const r2 = await fireToolCall(s2.pi, s2.ctx, {
        toolName: "write",
        toolCallId: "tc-soft-w2",
        input: { path: configYml, content: "x" },
      });
      assert.equal(r2, undefined, "second write auto-allows from the persistent grant");
      assert.equal(prompted, false, "no second prompt: the write grant persisted");
    },
  );
});

test("SYS-SOFT-HARD: hard outer id_rsa and ssh config stay tier two, no persist", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      const configPaths = {
        global: join(trustedDir, "..", "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      };

      // (b) id_rsa outer READ: tier=two → no "Always allow" option.
      let choices: string[] = [];
      let hardChoices: string[] = [];
      const softOuter = join(projectRoot, "..", "app", "auth.json");
      const s1 = createMockPi({
        projectRoot,
        uiChoice: async (_p, c) => {
          choices = c;
          return UI.allowSession;
        },
      });
      registerPermissionGate(s1.pi, { trustedDir, configPaths });
      await fireToolCall(s1.pi, s1.ctx, {
        toolName: "read",
        toolCallId: "tc-hard-1",
        input: { path: "/Users/x/.ssh/id_rsa" },
      });
      assert.equal(
        choices.some((c) => c.startsWith(UI.alwaysAllow.slice(0, 4)) || c.startsWith("Always allow")),
        false,
        `hard outer read must NOT offer "Always allow" (tier=two), got: ${choices}`,
      );
      await new Promise((r) => setTimeout(r, 100));

      // New session: the session grant is NOT persisted for tier=two, so the
      // prompt must reappear. (Contrast with the soft case above, which does
      // not re-prompt.)
      let promptCount = 0;
      const s2 = createMockPi({
        projectRoot,
        uiChoice: async () => {
          promptCount++;
          return UI.allowOnce;
        },
      });
      registerPermissionGate(s2.pi, { trustedDir, configPaths });
      await fireToolCall(s2.pi, s2.ctx, {
        toolName: "read",
        toolCallId: "tc-hard-2",
        input: { path: "/Users/x/.ssh/id_rsa" },
      });
      assert.equal(
        promptCount,
        1,
        "hard outer read must re-prompt in a new session (never persisted)",
      );

      // (c) ~/.ssh/config: no extension → not soft → still hard (tier=two).
      choices = [];
      const s3 = createMockPi({
        projectRoot,
        uiChoice: async (_p, c) => {
          choices = c;
          return UI.allowOnce;
        },
      });
      registerPermissionGate(s3.pi, { trustedDir, configPaths });
      await fireToolCall(s3.pi, s3.ctx, {
        toolName: "read",
        toolCallId: "tc-hard-3",
        input: { path: "/Users/x/.ssh/config" },
      });
      assert.equal(
        choices.some((c) => c.startsWith(UI.alwaysAllow.slice(0, 4)) || c.startsWith("Always allow")),
        false,
        `~/.ssh/config (hard) must NOT offer "Always allow", got: ${choices}`,
      );

      // (e) id_rsa outer WRITE: still tier=two, no "Always allow".
      choices = [];
      const s4 = createMockPi({
        projectRoot,
        uiChoice: async (_p, c) => {
          choices = c;
          return UI.allowSession;
        },
      });
      registerPermissionGate(s4.pi, { trustedDir, configPaths });
      await fireToolCall(s4.pi, s4.ctx, {
        toolName: "write",
        toolCallId: "tc-hard-4",
        input: { path: "/Users/x/.ssh/id_rsa", content: "x" },
      });
      assert.equal(
        choices.some((c) => c.startsWith(UI.alwaysAllow.slice(0, 4)) || c.startsWith("Always allow")),
        false,
        `hard outer write must NOT offer "Always allow" (tier=two), got: ${choices}`,
      );

      // (f) id_rsa outer DELETE: still tier=two, no "Always allow". Delete is
      // only reachable via bash (`rm`) — the file-tool path derives
      // read|write only (extensions/index.ts:679) — so this asserts the
      // sensitive fallback over a real extracted delete target. Contrasts with
      // the soft delete case below: same rm shape, opposite tier.
      hardChoices = [];
      const s5 = createMockPi({
        projectRoot,
        uiChoice: async (_p, c) => {
          hardChoices = c;
          return UI.allowSession;
        },
      });
      registerPermissionGate(s5.pi, { trustedDir, configPaths });
      await fireToolCall(s5.pi, s5.ctx, {
        toolName: "bash",
        toolCallId: "tc-hard-5",
        input: { command: "rm -f /Users/x/.ssh/id_rsa" },
      });
      assert.equal(
        hardChoices.some((c) => c.startsWith(UI.alwaysAllow.slice(0, 4)) || c.startsWith("Always allow")),
        false,
        `hard outer delete must NOT offer "Always allow" (tier=two), got: ${hardChoices}`,
      );

      // (g) soft outer DELETE: tier=three, and the "Always allow" command
      // grant actually persists — this is the accepted-delete decision, so
      // the integration layer pins it too, not only the DEC layer.
      choices = [];
      const s6 = createMockPi({
        projectRoot,
        uiChoice: async (_p, c) => {
          choices = c;
          return UI.alwaysAllowCmd;
        },
      });
      registerPermissionGate(s6.pi, { trustedDir, configPaths });
      await fireToolCall(s6.pi, s6.ctx, {
        toolName: "bash",
        toolCallId: "tc-soft-6",
        input: { command: `rm -f ${softOuter}` },
      });
      assert.equal(
        choices.some((c) => c.startsWith(UI.alwaysAllow.slice(0, 4)) || c.startsWith("Always allow")),
        true,
        `soft outer delete must offer "Always allow" (tier=three), got: ${choices}`,
      );
      await new Promise((r) => setTimeout(r, 100));
      const storeDel = JSON.parse(
        await readFile(join(trustedDir, "trusted.json"), "utf8"),
      ) as {
        grants: Array<{ action: string; path: string }>;
        bashGrants?: Array<{ rawCommand: string }>;
      };
      // Bash grants land in bashGrants (command hash), not the path-grant
      // list — the reliable path here still carries `rm -f <path>`, so assert
      // on whichever store recorded this exact command.
      const cmd = `rm -f ${softOuter}`;
      assert.ok(
        storeDel.grants.some((g) => g.action === "delete" && g.path === softOuter) ||
          (storeDel.bashGrants ?? []).some((g) => g.rawCommand === cmd),
        "soft outer delete persist wrote a grant for this command",
      );
    },
  );
});

// ---- 4.3-a: explicit config declaration beats the soft sensitive fallback ----

test("SYS-SOFT-DECL: explicit config declaration overrides soft sensitive", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      // The user has spoken: this exact path is read_only. decide() step 1
      // (config declaration) precedes step 2b (sensitive fallback), so the
      // declaration must win and the read auto-allow — soft must not re-prompt
      // a path the user has explicitly authorized.
      await writeFile(
        globalConfig,
        JSON.stringify({ paths: { "/declared/config.json": "read_only" } }),
      );
    },
    async ({ projectRoot, trustedDir }) => {
      const configPaths = {
        global: join(trustedDir, "..", "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      };
      let prompted = false;
      const { pi, ctx } = createMockPi({
        projectRoot,
        uiChoice: async () => {
          prompted = true;
          return UI.deny;
        },
      });
      registerPermissionGate(pi, { trustedDir, configPaths });
      const r = await fireToolCall(pi, ctx, {
        toolName: "read",
        toolCallId: "tc-soft-decl",
        input: { path: "/declared/config.json" },
      });
      assert.equal(r, undefined, "declared read_only read auto-allows");
      assert.equal(
        prompted,
        false,
        "no prompt: config declaration beats soft sensitive fallback",
      );
    },
  );
});

// ---- 4.3-b: revoking the soft persistent grant re-prompts ----

test("SYS-SOFT-REVOKE: revoking the soft persistent grant re-prompts", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      const configPaths = {
        global: join(trustedDir, "..", "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      };
      const configJson = join(projectRoot, "..", "config.json");
      const trustPath = join(trustedDir, "trusted.json");

      // Session 1: persist the grant.
      const s1 = createMockPi({
        projectRoot,
        uiChoice: async () => UI.alwaysAllow,
      });
      registerPermissionGate(s1.pi, { trustedDir, configPaths });
      await fireToolCall(s1.pi, s1.ctx, {
        toolName: "read",
        toolCallId: "tc-revoke-1",
        input: { path: configJson },
      });
      await new Promise((r) => setTimeout(r, 100));

      const store = JSON.parse(await readFile(trustPath, "utf8"));
      assert.ok(store.grants.length > 0, "grant written to trusted.json");

      // Revocation path documented in spec: the user edits trusted.json
      // directly and removes the entry.
      store.grants = [];
      await writeFile(trustPath, JSON.stringify(store, null, 2));

      // Session 2: no grant on disk → the soft prompt must reappear. Contrast
      // with the tier=two hard case, where a session grant is also dropped
      // between sessions — but there it is dropped because tier=two never
      // wrote one in the first place.
      let promptCount = 0;
      const s2 = createMockPi({
        projectRoot,
        uiChoice: async () => {
          promptCount++;
          return UI.allowOnce;
        },
      });
      registerPermissionGate(s2.pi, { trustedDir, configPaths });
      await fireToolCall(s2.pi, s2.ctx, {
        toolName: "read",
        toolCallId: "tc-revoke-2",
        input: { path: configJson },
      });
      assert.equal(promptCount, 1, "revoked grant must re-prompt");
    },
  );
});

// ---- 4.3-c: grant keyed by file, never widened to its directory ----

test("SYS-SOFT-FILE: soft persistent grant is keyed by file, not directory", async () => {
  await withSandbox(
    async ({ globalConfig }) => {
      await writeFile(globalConfig, "{}");
    },
    async ({ projectRoot, trustedDir }) => {
      const { mkdir: mkdirP } = await import("node:fs/promises");
      const configPaths = {
        global: join(trustedDir, "..", "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      };
      // Two soft files in one outer directory. Granting one must NOT widen to
      // the other — the grant key is the full path.
      const outerDir = join(projectRoot, "..", "softcfg");
      await mkdirP(outerDir, { recursive: true });
      const configJson = join(outerDir, "config.json");
      const authJson = join(outerDir, "auth.json");

      // Session 1: persist a grant for config.json only.
      const s1 = createMockPi({
        projectRoot,
        uiChoice: async () => UI.alwaysAllow,
      });
      registerPermissionGate(s1.pi, { trustedDir, configPaths });
      await fireToolCall(s1.pi, s1.ctx, {
        toolName: "read",
        toolCallId: "tc-file-1",
        input: { path: configJson },
      });
      await new Promise((r) => setTimeout(r, 100));

      // Session 2: config.json auto-allows; the sibling auth.json must still
      // prompt despite sharing the directory.
      let promptCount = 0;
      const s2 = createMockPi({
        projectRoot,
        uiChoice: async () => {
          promptCount++;
          return UI.allowOnce;
        },
      });
      registerPermissionGate(s2.pi, { trustedDir, configPaths });
      const r1 = await fireToolCall(s2.pi, s2.ctx, {
        toolName: "read",
        toolCallId: "tc-file-2",
        input: { path: configJson },
      });
      assert.equal(r1, undefined, "granted file auto-allows");
      assert.equal(promptCount, 0, "granted file must NOT prompt");

      await fireToolCall(s2.pi, s2.ctx, {
        toolName: "read",
        toolCallId: "tc-file-3",
        input: { path: authJson },
      });
      assert.equal(
        promptCount,
        1,
        "sibling soft file in the same dir must still prompt (no dir widening)",
      );
    },
  );
});
