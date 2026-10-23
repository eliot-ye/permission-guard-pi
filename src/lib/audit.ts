//
// Audit log. Pure module (except for fs). No pi imports.
//
// JSONL append-only log at ~/.pi/agent/extensions/@permission-guard/pi/logs/permission-review.jsonl
//
// Serial queue ensures concurrent tool calls don't interleave on the same
// file descriptor.
//
// Fire-and-forget: append failures MUST NOT throw to the caller.
//
// Permissions (Change A: permission-hardening-cleanup):
//   - Log directory created with 0o700 on first mkdir.
//   - Log file chmod'd to 0o600 before each append, only when the file's
//     uid matches the current process uid. chmod is best-effort: on any
//     failure we log the error to `failures` and proceed with the append.
//   - Long `command` fields (> 512 chars) are truncated to 511 chars +
//     U+2026 with `note: "command truncated"` appended (joined with
//     "; " when a note already exists). Truncation happens in-memory
//     before JSON serialization.
//

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Authorization, GrantSource } from "./decision.ts";

export type AuditEvent =
  | "allow_once"
  | "allow_session"
  | "allow_persistent"
  | "deny"
  | "hard_deny"
  | "conflict_prompt"
  | "auto_allow";

export type AuditTool = "read" | "write" | "edit" | "bash" | "powershell";

export interface AuditRecord {
  event: AuditEvent;
  tool: AuditTool;
  project: string;
  projectRoot: string;
  path: string | null;
  command: string | null;
  region: "project_inner" | "project_outer";
  declaration:
    | "read_write"
    | "read_only"
    | "unread"
    | "sensitive_default"
    | "unconfigured";
  permission: "read_write" | "read_only" | null;
  toolCallId: string;
  note?: string;
  // Design D3: coarse-grained authorization provenance.
  //   "by_person" - human prompt choice (allow_once / allow_session /
  //     allow_persistent / deny / conflict_prompt).
  //   "presumed" - system-derived (hard_deny, auto_allow from decide()).
  // Optional so legacy log lines (no field) keep parsing.
  authorization?: Authorization;
  // Design D3/D4: fine-grained source of the firing rule/memory entry.
  grant_source?: GrantSource;
}

export interface AuditLogger {
  log: (record: AuditRecord) => void;
  path: string;
  // Optional: wait for all pending appends (used in tests).
  flush: () => Promise<void>;
}

const MAX_COMMAND_CHARS = 512;
const TRUNCATION_MARKER = "\u2026"; // …
const TRUNCATION_NOTE = "command truncated";

/**
 * Best-effort chmod. Skips when:
 *   - platform is Windows (fs.chmod is a no-op there).
 *   - stat fails (file doesn't exist yet — that's fine, mkdir handles it).
 *   - the file is owned by a different uid than the current process.
 *
 * Never throws. Errors are pushed to `sink`.
 */
async function ensureFileMode(path: string, mode: number, sink: Error[]): Promise<void> {
  if (process.platform === "win32") return;
  if (typeof process.getuid !== "function") return;
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(path);
  } catch (err) {
    // File may not exist yet (this is the mkdir case) — skip.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      sink.push(err as Error);
    }
    return;
  }
  if (typeof st.uid === "number" && st.uid !== process.getuid()) return;
  try {
    await fs.chmod(path, mode);
  } catch (err) {
    sink.push(err as Error);
  }
}

/**
 * Truncate long command fields in place, appending the truncation note.
 * Returns a new record (does not mutate input).
 */
function truncateCommand(record: AuditRecord): AuditRecord {
  const cmd = record.command;
  if (typeof cmd !== "string" || cmd.length <= MAX_COMMAND_CHARS) return record;
  const truncated = cmd.slice(0, MAX_COMMAND_CHARS - 1) + TRUNCATION_MARKER;
  const existingNote = record.note ?? "";
  const note = existingNote
    ? `${existingNote}; ${TRUNCATION_NOTE}`
    : TRUNCATION_NOTE;
  return { ...record, command: truncated, note };
}

export function createAuditLogger(logPath: string): AuditLogger {
  let queue: Promise<void> = Promise.resolve();
  const failures: Error[] = [];

  const append = async (record: AuditRecord): Promise<void> => {
    try {
      // Ensure the parent directory exists. `mode: 0o700` is only applied
      // when mkdir creates a new directory; existing directories keep
      // their mode.
      await fs.mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
      // Truncate long command fields before serializing.
      const toWrite = truncateCommand(record);
      const line = JSON.stringify({ ...toWrite, ts: new Date().toISOString() });
      // Open with mode 0o600 so that the FIRST line is written under the
      // tightened mode (fs.open's `a` flag creates the file if missing,
      // applying the mode at creation time — this closes the P2-5 gap
      // where fs.appendFile would create the file with the umask'd mode
      // after ensureFileMode skipped due to ENOENT).
      const fd = await fs.open(logPath, "a", 0o600);
      try {
        await fd.writeFile(line + "\n", "utf8");
      } finally {
        await fd.close();
      }
      // Belt-and-braces: also chmod any pre-existing file to 0o600 (in
      // case a previous run created it under a wider umask). Skips
      // silently when the file's uid doesn't match the current process.
      await ensureFileMode(logPath, 0o600, failures);
    } catch (err) {
      // Never fail the decision pipeline because of logging.
      failures.push(err as Error);
    }
  };

  return {
    path: logPath,
    log: (record) => {
      queue = queue.then(() => append(record)).catch(() => {});
    },
    flush: () => queue,
  };
}
