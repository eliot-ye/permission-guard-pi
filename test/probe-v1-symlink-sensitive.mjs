//
// V1 探针（探索会话内复现，非 spec 落盘）：
// 文件工具 read 经项目内符号链接读敏感文件是否静默 auto_allow。
//
// 对照组：直接读敏感路径（不经符号链接）应弹窗 tier=two。
// 实验组：读 /proj/link_to_ssh/test-id_rsa（link → <root>/.ssh）应被 V1 描述为 auto_allow。
//
// 运行：node --experimental-strip-types test/probe-v1-symlink-sensitive.mjs
//

import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPermissionGate } from "../extensions/index.ts";

// -------- 与 sys-integration.test.ts 一致的最小 mock pi --------

function createMockPi({ projectRoot, hasUI = true, uiChoice }) {
  const ctx = {
    hasUI,
    mode: "tui",
    cwd: projectRoot,
    projectRoot,
    ui: {
      select: uiChoice ?? (async (_p, choices) => choices[0] || "Allow this call only"),
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
  const root = await mkdtemp(join(tmpdir(), "pi-v1-"));
  try {
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(projectRoot, ".pi/local"), { recursive: true });
    const globalDir = join(root, "global");
    await mkdir(globalDir, { recursive: true });
    const trustedDir = join(root, "trusted");
    await mkdir(trustedDir, { recursive: true });
    // 敏感目录：basename 必须是 .ssh 以命中 sensitive.ts 规则
    const sensitiveDir = join(root, ".ssh");
    await mkdir(sensitiveDir, { recursive: true });
    await writeFile(join(sensitiveDir, "test-id_rsa"), "dummy");
    // 项目内符号链接 → 敏感目录
    const linkPath = join(projectRoot, "link_to_ssh");
    await rm(linkPath, { force: true, recursive: true }).catch(() => {});
    await symlink(sensitiveDir, linkPath);
    await writeFile(join(globalDir, "permission.json"), "{}");
    await fn({ projectRoot, trustedDir, globalConfig: join(globalDir, "permission.json"), linkPath, sensitiveDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let prompted = null;
const { pi, ctx } = createMockPi({
  projectRoot: "", // 占位，withSandbox 内重新建
  uiChoice: async (prompt) => { prompted = prompt; return "Deny"; },
});

await withSandbox(async ({ projectRoot, trustedDir, globalConfig, linkPath, sensitiveDir }) => {
  // 重新绑定 projectRoot：registerPermissionGate 闭包用 ctx.projectRoot，
  // 我们在 withSandbox 内重建 pi/ctx 以确保 projectRoot 正确。
  const { pi: pi2, ctx: ctx2 } = createMockPi({
    projectRoot,
    uiChoice: async (prompt) => { prompted = prompt; return "Deny"; },
  });
  registerPermissionGate(pi2, {
    trustedDir,
    configPaths: {
      global: globalConfig,
      project: join(projectRoot, ".pi/permission.json"),
      local: join(projectRoot, ".pi/local/permission.json"),
    },
  });

  // 触发 session_start 以初始化 state
  for (const h of (pi2._handlers["session_start"] ?? [])) await h({}, ctx2);

  console.log("=== V1 探针：文件工具 read 经项目内符号链接读敏感文件 ===\n");

  // 对照组：直接读敏感路径（应弹窗 tier=two → block=true，因 uiChoice=Deny）
  prompted = null;
  const direct = await fireToolCall(pi2, ctx2, {
    toolName: "read",
    toolCallId: "tc-direct",
    input: { path: join(sensitiveDir, "test-id_rsa") },
  });
  console.log("[对照] 直接 read <root>/.ssh/test-id_rsa");
  console.log("  result:", JSON.stringify(direct));
  console.log("  prompted:", prompted !== null);
  console.log("  期望: 弹窗 → block=true（sensitive 命中 tier=two）\n");

  // 实验组：经项目内符号链接读同一敏感文件
  prompted = null;
  const viaLink = await fireToolCall(pi2, ctx2, {
    toolName: "read",
    toolCallId: "tc-link",
    input: { path: join(linkPath, "test-id_rsa") },
  });
  console.log("[实验] read /proj/link_to_ssh/test-id_rsa（link → <root>/.ssh）");
  console.log("  result:", JSON.stringify(viaLink));
  console.log("  prompted:", prompted !== null);
  console.log("  期望（若 V1 成立）: auto_allow → result=undefined, prompted=false");

  console.log("\n=== 结论 ===");
  if (viaLink === undefined && !prompted) {
    console.log("V1 确认：文件工具 read 经项目内符号链接静默读取敏感文件，敏感硬底线被绕过。");
  } else if (viaLink?.block === true) {
    console.log("V1 证伪：文件工具 read 经符号链接被阻断/弹窗，敏感判定已覆盖符号链接。");
  } else {
    console.log("V1 部分确认：结果=", JSON.stringify(viaLink), "prompted=", prompted);
  }
});
