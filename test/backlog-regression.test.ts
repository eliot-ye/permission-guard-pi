//
// Regression tests for the backlog fixes (task 15 + task 18).
//
// Task 15: bash session-grant should use the actual target action,
//          not a hardcoded "write" default. A "read" grant from
//          `cat X` should NOT silently cover a subsequent `write X`.
//
// Task 18: sensitive-path fallback should only apply to outer-region
//          paths. A sensitive-looking path INSIDE the project should
//          auto-allow (user has explicit control inside the project).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

import { registerPermissionGate } from "../extensions/index.ts";
import { t } from "../src/lib/i18n.ts";
import { detectLang } from "../src/lib/lang-detect.ts";

const UI = {
  allowOnce: t("choice_allow_once", detectLang(process.env, {})),
  allowSession: t("choice_allow_session", detectLang(process.env, {})),
  alwaysAllow: t("choice_always_allow", detectLang(process.env, {})),
  alwaysAllowCmd: t("choice_always_allow_command", detectLang(process.env, {}), { path: "trusted.json" }),
  deny: t("choice_deny", detectLang(process.env, {})),
};

// -------- Mock pi (same shape as sys-integration.test.ts) --------

type UIChoiceHandler = (prompt: string, choices: string[]) => Promise<string>;

function createMockPi(opts: {
  projectRoot: string;
  uiChoice?: UIChoiceHandler;
}): { pi: any; ctx: any } {
  const uiChoice =
    opts.uiChoice ??
    (async (_p: string, choices: string[]) => choices[0] || "Allow this call only");
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: opts.projectRoot,
    projectRoot: opts.projectRoot,
    ui: {
      select: uiChoice,
      notify: () => {},
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
  return { pi, ctx };
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

// -------- SYS9: bash read-grant doesn't cover file write (task 15) --------

test("SYS9: bash cat sensitive-outer with allow_session does not silently grant bash write", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "perm-e2e-"));
  const projectRootRaw = join(workDir, "proj");
  const fakeHomeRaw = join(workDir, "home");
  const globalDir = join(workDir, "global");
  const trustedDir = join(workDir, "trust");
  await mkdir(projectRootRaw, { recursive: true });
  await mkdir(fakeHomeRaw, { recursive: true });
  await mkdir(globalDir, { recursive: true });
  await mkdir(trustedDir, { recursive: true });
  await writeFile(join(globalDir, "permission.json"), "{}");

  try {
    const projectRoot = await realpath(projectRootRaw);
    const fakeHome = await realpath(fakeHomeRaw);
    // Sensitive-looking file OUTSIDE projectRoot.
    await mkdir(join(fakeHome, ".ssh"), { recursive: true });
    await writeFile(join(fakeHome, ".ssh", "id_rsa"), "fake key");
    const sensitivePath = join(fakeHome, ".ssh", "id_rsa");

    let promptCalls = 0;
    const { pi, ctx } = createMockPi({
      projectRoot,
      uiChoice: async () => {
        promptCalls++;
        return UI.allowSession;
      },
    });
    registerPermissionGate(pi, {
      trustedDir,
      configPaths: {
        global: join(globalDir, "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      },
    });

    // Step 1: bash `cat <sensitive outer>` - read action. User picks "Allow for session".
    const r1 = await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-sys9-1",
      input: { command: `cat ${sensitivePath}` },
    });
    assert.equal(r1, undefined, "session grant should allow the bash call");
    assert.equal(promptCalls, 1, `one prompt expected for bash cat (got ${promptCalls})`);

    // Step 2: bash `mv <somefile> <sensitive outer>` - write action on same path.
    // The session grant from step 1 was for READ, so WRITE must still prompt.
    // If the code wrongly used toolName-based default "write" for both bash
    // invocations, this second call would silently pass (grant hit).
    const r2 = await fireToolCall(pi, ctx, {
      toolName: "bash",
      toolCallId: "tc-sys9-2",
      input: { command: `mv ${projectRoot}/inner/somefile ${sensitivePath}` },
    });
    // r2 is undefined because user chose "allow_session" again - that's fine.
    // The KEY assertion is that a SECOND prompt fired - proving the read-
    // grant from step 1 did NOT cover the write action in step 2.
    assert.equal(
      promptCalls,
      2,
      `second prompt expected for bash write (task 15 regression): got ${promptCalls}`,
    );
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
});

// -------- SYS10: sensitive inside project prompts tier=three (task 18 update) --------

// AD15 (spec update): inner sensitive is now tier=three (persistent allowed),
// outer sensitive remains tier=two. This test verifies the inner case.

test("SYS10: sensitive path INSIDE project prompts tier=three (persistent allowed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perm-e2e-"));
  try {
    const projectRoot = await realpath(dir);
    await mkdir(join(projectRoot, ".ssh"), { recursive: true });
    await writeFile(join(projectRoot, ".ssh", "id_rsa"), "fake");

    await mkdir(join(dir, "global"), { recursive: true });
    await writeFile(join(dir, "global", "permission.json"), "{}");

    const trustedDir = join(dir, "trust");
    await mkdir(trustedDir, { recursive: true });

    let capturedChoices: string[] | undefined;
    const { pi, ctx } = createMockPi({
      projectRoot,
      uiChoice: async (_p, choices) => {
        capturedChoices = choices;
        return UI.deny;
      },
    });
    registerPermissionGate(pi, {
      trustedDir,
      configPaths: {
        global: join(dir, "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      },
    });

    // Inner sensitive path → tier=three (4 choices incl. "Always allow").
    const innerSensitivePath = join(projectRoot, ".ssh", "id_rsa");
    const r = await fireToolCall(pi, ctx, {
      toolName: "read",
      toolCallId: "tc-sys10-1",
      input: { path: innerSensitivePath },
    });

    assert.equal(r?.block, true, "user denied should block");
    assert.equal(capturedChoices?.length, 4, "tier=three has 4 options incl. 'Always allow'");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// -------- SYS11: explicit read_write overrides inner sensitive --------

test("SYS11: explicit config overrides inner sensitive (still auto-allows)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "perm-e2e-"));
  try {
    const projectRoot = await realpath(dir);
    await mkdir(join(projectRoot, ".ssh"), { recursive: true });
    await writeFile(join(projectRoot, ".ssh", "id_rsa"), "fake");

    await mkdir(join(dir, "global"), { recursive: true });
    await writeFile(
      join(dir, "global", "permission.json"),
      JSON.stringify({ paths: { [join(projectRoot, ".ssh", "id_rsa")]: "read_write" } }),
    );

    const trustedDir = join(dir, "trust");
    await mkdir(trustedDir, { recursive: true });

    let promptCalled = false;
    const { pi, ctx } = createMockPi({
      projectRoot,
      uiChoice: async () => {
        promptCalled = true;
        return UI.deny;
      },
    });
    registerPermissionGate(pi, {
      trustedDir,
      configPaths: {
        global: join(dir, "global", "permission.json"),
        project: join(projectRoot, ".pi", "permission.json"),
        local: join(projectRoot, ".pi", "local", "permission.json"),
      },
    });

    // Explicit read_write inside project overrides the sensitive fallback.
    const r = await fireToolCall(pi, ctx, {
      toolName: "read",
      toolCallId: "tc-sys11-1",
      input: { path: join(projectRoot, ".ssh", "id_rsa") },
    });

    assert.equal(r, undefined, "explicit read_write inside project should auto-allow");
    assert.equal(promptCalled, false, "no prompt for explicit config");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
