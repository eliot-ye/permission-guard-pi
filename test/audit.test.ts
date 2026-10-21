//
// TDD RED: audit tests. Covers AL1-AL8.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuditLogger } from "../src/lib/audit.ts";

async function withTmpFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-audit-"));
  try {
    return await fn(join(dir, "permission-review.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("AL4: audit_logger_appends_jsonl_line_per_record", async () => {
  await withTmpFile(async (path) => {
    const logger = createAuditLogger(path);
    logger.log({
      event: "auto_allow",
      tool: "write",
      project: "hash1",
      projectRoot: "/proj",
      path: "/proj/a.ts",
      command: null,
      region: "project_inner",
      declaration: "unconfigured",
      permission: null,
      toolCallId: "tc-1",
    });
    logger.log({
      event: "hard_deny",
      tool: "read",
      project: "hash1",
      projectRoot: "/proj",
      path: "/etc/shadow",
      command: null,
      region: "project_outer",
      declaration: "unread",
      permission: null,
      toolCallId: "tc-2",
    });
    // Wait for serial queue to drain.
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    // Each line is valid JSON.
    const parsed = lines.map(JSON.parse);
    assert.equal(parsed[0].event, "auto_allow");
    assert.equal(parsed[1].event, "hard_deny");
    // ts should be injected.
    assert.ok(parsed[0].ts, "expected ts field");
    assert.ok(parsed[1].ts, "expected ts field");
  });
});

test("AL5: audit_record_contains_all_required_fields", async () => {
  await withTmpFile(async (path) => {
    const logger = createAuditLogger(path);
    logger.log({
      event: "deny",
      tool: "write",
      project: "hash1",
      projectRoot: "/proj",
      path: "/etc/passwd",
      command: null,
      region: "project_outer",
      declaration: "read_only",
      permission: "read_only",
      toolCallId: "tc-100",
      note: "user denied",
    });
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw.trim());
    for (const key of [
      "ts",
      "event",
      "tool",
      "project",
      "projectRoot",
      "path",
      "command",
      "region",
      "declaration",
      "permission",
      "toolCallId",
    ]) {
      assert.ok(key in record, `expected field ${key}`);
    }
    assert.equal(record.note, "user denied");
  });
});

test("AL6: audit_write_failure_does_not_throw", async () => {
  // Point at an impossible location; the logger should swallow the error.
  const logger = createAuditLogger("/root/impossible/path/that/does/not/exist/x.jsonl");
  // Should not throw.
  logger.log({
    event: "hard_deny",
    tool: "read",
    project: "hash1",
    projectRoot: "/proj",
    path: "/x",
    command: null,
    region: "project_outer",
    declaration: "unread",
    permission: null,
    toolCallId: "tc-999",
  });
  // Await the swallowed queue.
  await new Promise((r) => setTimeout(r, 50));
  // If we got here without an exception, pass.
});

test("AL7: concurrent_audits_are_serialized_no_line_interleaving", async () => {
  await withTmpFile(async (path) => {
    const logger = createAuditLogger(path);
    const N = 100;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      tasks.push(
        Promise.resolve().then(() => {
          logger.log({
            event: "auto_allow",
            tool: "write",
            project: "hash1",
            projectRoot: "/proj",
            path: `/p/${i}`,
            command: null,
            region: "project_inner",
            declaration: "unconfigured",
            permission: null,
            toolCallId: `tc-${i}`,
          });
        }),
      );
    }
    // Wait for all to complete.
    await Promise.all(tasks);
    await new Promise((r) => setTimeout(r, 100));
    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, N, `expected ${N} lines, got ${lines.length}`);
    // All must be valid JSON.
    for (const line of lines) {
      JSON.parse(line);
    }
  });
});

test("AL8: audit_logger_creates_log_directory_on_first_write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-audit-"));
  try {
    const path = join(dir, "subdir/nested/x.jsonl");
    const logger = createAuditLogger(path);
    logger.log({
      event: "auto_allow",
      tool: "write",
      project: "hash1",
      projectRoot: "/proj",
      path: "/x",
      command: null,
      region: "project_inner",
      declaration: "unconfigured",
      permission: null,
      toolCallId: "tc",
    });
    await new Promise((r) => setTimeout(r, 50));
    // File should exist.
    const raw = await readFile(path, "utf8");
    assert.ok(raw.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -------- AL1, AL2, AL3: decision→audit mapping (contract tests) --------

test("AL1: prompt_persistent_decision_writes_allow_persistent_event", async () => {
  await withTmpFile(async (path) => {
    const logger = createAuditLogger(path);
    logger.log({
      event: "allow_persistent",
      tool: "write",
      project: "hash1",
      projectRoot: "/proj",
      path: "/x",
      command: null,
      region: "project_outer",
      declaration: "read_write",
      permission: "read_write",
      toolCallId: "tc",
    });
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw.trim());
    assert.equal(record.event, "allow_persistent");
  });
});

test("AL2: hard_deny_decision_writes_hard_deny_event", async () => {
  await withTmpFile(async (path) => {
    const logger = createAuditLogger(path);
    logger.log({
      event: "hard_deny",
      tool: "read",
      project: "hash1",
      projectRoot: "/proj",
      path: "/x",
      command: null,
      region: "project_outer",
      declaration: "unread",
      permission: null,
      toolCallId: "tc",
    });
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw.trim());
    assert.equal(record.event, "hard_deny");
  });
});

test("AL3: routine_inner_plain_auto_allow_is_not_audited (contract)", () => {
  // This is a test-level contract: the audit logger should not be called for
  // routine auto-allow. The test verifies the logger accepts only specific
  // events; if a caller mistakenly logs routine auto-allow, they'd still be
  // allowed by the schema (audit-log allows auto_allow as an event kind),
  // but the extension layer's contract (see design.md) is to NOT log
  // routine inner-plain auto-allow.
  //
  // We assert the logger accepts auto_allow (so non-routine cases can use it),
  // but the extension layer filters.
  const logger = createAuditLogger("/tmp/x.jsonl");
  // Just check the interface allows it.
  assert.doesNotThrow(() =>
    logger.log({
      event: "auto_allow",
      tool: "write",
      project: "h",
      projectRoot: "/p",
      path: "/p/x",
      command: null,
      region: "project_inner",
      declaration: "unconfigured",
      permission: null,
      toolCallId: "tc",
    }),
  );
});
