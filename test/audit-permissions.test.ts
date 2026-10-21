//
// TDD RED: audit-log file/dir permissions + command field truncation.
// Covers ALP1-ALP6 (Change A: permission-hardening-cleanup).
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { createAuditLogger } from "../src/lib/audit.ts";

const MAX_COMMAND_LEN = 512;
const TRUNCATION_MARKER = "\u2026"; // …

import type { AuditRecord } from "../src/lib/audit.ts";

function baseRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    event: "deny",
    tool: "bash",
    project: "hash1",
    projectRoot: "/proj",
    path: "/etc/passwd",
    command: "cat /etc/passwd",
    region: "project_outer",
    declaration: "read_only",
    permission: "read_only",
    toolCallId: "tc-1",
    ...overrides,
  };
}

async function withTmpFile<T>(fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-audit-perm-"));
  try {
    return await fn(join(dir, "permission-review.jsonl"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ALP1: audit_logger_creates_log_directory_with_0700_permissions", async () => {
  await withTmpFile(async (_path, dir) => {
    const logPath = join(dir, "subdir", "permission-review.jsonl");
    const logger = createAuditLogger(logPath);
    logger.log(baseRecord());
    await new Promise((r) => setTimeout(r, 50));
    // Both parent dir and log parent (subdir) should be 0o700.
    const dirStat = await stat(dirname(logPath));
    const mode = dirStat.mode & 0o777;
    assert.equal(mode, 0o700, `expected log directory to be 0700, got ${mode.toString(8)}`);
  });
});

test("ALP2: audit_logger_chmods_existing_log_file_to_0600", async () => {
  await withTmpFile(async (path, dir) => {
    // Pre-create log file with 0o644.
    await writeFile(path, "");
    await writeFile(dirname(path) === dir ? path : path, "", { mode: 0o644 });
    // Reset to 0o644 to be explicit (mkdtemp's dir is 0o700 by default).
    const fs = await import("node:fs/promises");
    await fs.chmod(path, 0o644);
    const before = await stat(path);
    assert.equal(before.mode & 0o777, 0o644);

    const logger = createAuditLogger(path);
    logger.log(baseRecord());
    await new Promise((r) => setTimeout(r, 50));

    const after = await stat(path);
    assert.equal(after.mode & 0o777, 0o600, "log file must be chmod'd to 0600 on first write");
  });
});

test("ALP3: audit_logger_skips_chmod_when_file_not_owned_by_current_user", async () => {
  // This is a best-effort test: on Windows we have no uid comparison, and
  // running as root would break this test. We verify the code path is
  // exercised by checking the file remains writable by other users only if
  // it was created with that mode; if the ownership check kicks in on
  // Linux, no chmod is attempted.
  await withTmpFile(async (path) => {
    await writeFile(path, "");
    // Simulate "not owned" case by attempting the log write on a file
    // whose mode is 0o644 — the implementation must NOT throw.
    const logger = createAuditLogger(path);
    logger.log(baseRecord());
    await new Promise((r) => setTimeout(r, 50));
    // Whatever the mode is, the log line must be written.
    const raw = await readFile(path, "utf8");
    assert.ok(raw.includes("toolCallId"), "log line should still be appended");
  });
});

test("ALP4: audit_logger_truncates_command_field_over_512_chars", async () => {
  await withTmpFile(async (path) => {
    const longCmd = "x".repeat(800);
    const logger = createAuditLogger(path);
    logger.log(baseRecord({ command: longCmd }));
    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw.trim());
    assert.equal(record.command.length, MAX_COMMAND_LEN, `expected truncated length ${MAX_COMMAND_LEN}, got ${record.command.length}`);
    assert.ok(record.command.endsWith(TRUNCATION_MARKER), `expected ${TRUNCATION_MARKER} at end, got tail: "${record.command.slice(-10)}"`);
    assert.ok(record.command.startsWith("x".repeat(100)), "should preserve first N chars");
    assert.ok(record.note && record.note.includes("command truncated"), `expected note to mention truncation, got: ${record.note}`);
  });
});

test("ALP5: audit_logger_preserves_short_command_field", async () => {
  await withTmpFile(async (path) => {
    const shortCmd = "git status";
    const logger = createAuditLogger(path);
    logger.log(baseRecord({ command: shortCmd }));
    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw.trim());
    assert.equal(record.command, shortCmd);
    assert.ok(!record.note || !record.note.includes("command truncated"), "short command must not have truncation note");
  });
});

test("ALP6: audit_logger_truncation_note_coexists_with_existing_note", async () => {
  await withTmpFile(async (path) => {
    const longCmd = "y".repeat(700);
    const logger = createAuditLogger(path);
    logger.log(baseRecord({ command: longCmd, note: "unreliable bash extraction" }));
    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(path, "utf8");
    const record = JSON.parse(raw.trim());
    assert.ok(record.note.includes("unreliable bash extraction"), "existing note must be preserved");
    assert.ok(record.note.includes("command truncated"), "truncation marker must be appended");
    assert.equal(record.command.length, MAX_COMMAND_LEN);
  });
});
