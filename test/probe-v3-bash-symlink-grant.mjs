//
// V3 探针（探索会话内验证，非 spec 落盘）：
// bash 可靠提取下符号链接目标的 grant 键是否不一致（存 resolvedPath、查 target.path）。
//
// 构造：truncate -s 0 /proj/link/file.txt（write, 外区非敏感非/tmp → tier=three prompt）
//   - 第一次：uiChoice="Always allow" → grant 存 resolvedPath（realpath）
//   - 第二次：同命令。若 hasGrant(target.path) miss + hasGrant(resolvedPath) hit 但 severity 更低
//             → 走第一次 prompt → 重弹（V3 成立）。若 auto_allow → V3 证伪。
//
// 运行：node --experimental-strip-types test/probe-v3-bash-symlink-grant.mjs
//

import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPermissionGate } from "../extensions/index.ts";
import { extractBashTargets } from "../src/lib/bash-extract.ts";

function createMockPi({ projectRoot, uiChoice }) {
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: projectRoot,
    projectRoot,
    ui: {
      select: uiChoice,
      notify: () => {},
      input: async () => "",
    },
  };
  const handlers = {};
  const pi = {
    on: (event, handler) => { (handlers[event] ??= []).push(handler); return () => {}; },
    registerCommand: () => {},
    appendEntry: () => {},
  };
  pi._handlers = handlers;
  return { pi, ctx };
}

async function fireToolCall(pi, ctx, event) {
  const hs = pi._handlers["tool_call"] ?? [];
  for (const h of hs) {
    const r = await h(event, ctx);
    if (r !== undefined) return r;
  }
  return undefined;
}

async function withSandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-v3-"));
  try {
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(projectRoot, ".pi/local"), { recursive: true });
    const globalDir = join(root, "global");
    await mkdir(globalDir, { recursive: true });
    const trustedDir = join(root, "trusted");
    await mkdir(trustedDir, { recursive: true });
    // 外区非敏感目录（非 /tmp，避开 isDefaultTmpPath 兜底）
    const outerTarget = join(root, "v3target");
    await mkdir(outerTarget, { recursive: true });
    await writeFile(join(outerTarget, "file.txt"), "dummy");
    // 项目内符号链接 → 外区目录
    const linkPath = join(projectRoot, "link_to_outer");
    await rm(linkPath, { force: true, recursive: true }).catch(() => {});
    await symlink(outerTarget, linkPath);
    await writeFile(join(globalDir, "permission.json"), "{}");
    await fn({
      projectRoot, trustedDir,
      globalConfig: join(globalDir, "permission.json"),
      linkPath, outerTarget,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await withSandbox(async ({ projectRoot, trustedDir, globalConfig, linkPath, outerTarget }) => {
  const command = `truncate -s 0 ${join(linkPath, "file.txt")}`;

  // 先打印 extraction，确认 target.path（字面）vs resolvedPath（realpath）不一致
  const ex = extractBashTargets(command, projectRoot);
  console.log("=== V3 探针：bash 可靠提取符号链接目标 grant 键一致性 ===\n");
  console.log("extraction:", JSON.stringify(ex));
  const { realpath } = await import("node:fs/promises");
  const resolved = await realpath(ex.targets[0].path);
  console.log("target.path (命令字面):", ex.targets[0].path);
  console.log("resolvedPath (realpath):", resolved);
  console.log("target.path === resolvedPath?", ex.targets[0].path === resolved, "\n");

  let promptCount = 0;
  const { pi, ctx } = createMockPi({
    projectRoot,
    uiChoice: async (prompt) => { promptCount++; return "Always allow (save to trusted.json)"; },
  });
  registerPermissionGate(pi, {
    trustedDir,
    configPaths: {
      global: globalConfig,
      project: join(projectRoot, ".pi/permission.json"),
      local: join(projectRoot, ".pi/local/permission.json"),
    },
  });
  for (const h of (pi._handlers["session_start"] ?? [])) await h({}, ctx);

  // 第一次：应 prompt tier=three → "Always allow" 存 grant(resolvedPath)
  promptCount = 0;
  const r1 = await fireToolCall(pi, ctx, {
    toolName: "bash", toolCallId: "tc-1", input: { command },
  });
  console.log("[第一次] result:", JSON.stringify(r1), "promptCount:", promptCount);
  console.log("  期望: prompt tier=three → undefined（allow_persistent 存 grant）\n");

  // 第二次：同命令。V3 假设 hasGrant(target.path) miss → 重弹
  promptCount = 0;
  const r2 = await fireToolCall(pi, ctx, {
    toolName: "bash", toolCallId: "tc-2", input: { command },
  });
  console.log("[第二次] result:", JSON.stringify(r2), "promptCount:", promptCount);
  console.log("  期望（V3 成立）: 重弹 → prompt tier=three, promptCount=1");
  console.log("  期望（V3 证伪）: auto_allow → undefined, promptCount=0\n");

  console.log("=== 结论 ===");
  if (r2 === undefined && promptCount === 0) {
    console.log("V3 证伪：第二次 auto_allow，grant 键一致（target.path 查询命中）。");
  } else if (promptCount > 0) {
    console.log("V3 确认：第二次仍弹窗——grant 存 resolvedPath、查 target.path 键不匹配导致重弹。");
  } else {
    console.log("V3 未定：result=", JSON.stringify(r2), "promptCount=", promptCount);
  }
});
