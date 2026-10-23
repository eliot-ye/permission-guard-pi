//
// Grant memory storage. Pure module - no pi imports.
//
// Two channels:
//   - Session grants: in-memory Map, cleared on session_start.
//   - Persistent grants: JSON file on disk, atomic write.
//
// Key structure: <projectHash>|<action>|<absPath>
// Project hash is passed in by caller (from hashProject).
//
// Bash-command grants live on separate channels keyed by
// <projectHash>|sha256(rawCommand) so that unreliable bash prompts can be
// remembered without touching the path-based grant namespace.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

/**
 * Best-effort chmod. Skips when:
 *   - platform is Windows (fs.chmod is a no-op there).
 *   - the current process has no getuid (defensive).
 *   - stat fails (file may not exist yet — that's fine).
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

export type Action = "read" | "write" | "delete";
export type Permission = "read_write" | "read_only";

/**
 * Provenance of a stored grant (design.md D5).
 *
 * - "by_person": written from a human prompt choice (currently the only
 *   write path in this project — see `handlePromptDecision` in
 *   extensions/index.ts).
 * - "presumed": written by a system rule (reserved for future
 *   config-based auto-grant paths; unused today).
 * - "migration": written by a migration/import path where trust
 *   provenance is uncertain (reserved; unused today).
 *
 * Field is optional so legacy trusted.json files (without `author`) keep
 * parsing. createTrustStore's load path defaults missing values to
 * "by_person" (D5 migration strategy — legacy write path was human-only).
 */
export type GrantAuthor = "by_person" | "presumed" | "migration";

export interface Grant {
  projectHash: string;
  action: Action;
  path: string;
  permission: Permission;
  createdAt: string;
  author?: GrantAuthor;
}

/** Input shape accepted by `addPersistentGrant`. `createdAt` is populated
 *  by the store itself. `author` stays optional so callers can still pass
 *  an explicit value (the store defaults it to "by_person" if omitted).
 *  Keeping the input type separate from the on-disk `Grant` makes the
 *  responsibility boundary explicit. */
export type GrantInput = Omit<Grant, "createdAt">;

export interface BashGrant {
  projectHash: string;
  /** sha256(rawCommand), 64 lowercase hex chars. Stable identity of the command. */
  commandHash: string;
  /** Raw command string. Stored for audit, UI display, and revocation review. */
  rawCommand: string;
  /** Original extraction reason (glob_expansion, shell_forwarder, etc.) */
  reason: string;
  /** Applied permission level (read_only or read_write). */
  permission: Permission;
  createdAt: string;
  author?: GrantAuthor;
}

/** Input shape accepted by `addBashPersistentGrant`. `createdAt` is
 *  populated by the store; `author` is optional. */
export type BashGrantInput = Omit<BashGrant, "createdAt">;

export interface TrustStore {
  // Path-based session-level (in-memory).
  hasSessionGrant: (projectHash: string, action: Action, path: string) => boolean;
  addSessionGrant: (projectHash: string, action: Action, path: string) => void;
  clearSessionGrants: () => void;

  // Path-based persistent (disk-backed, async).
  hasPersistentGrant: (projectHash: string, action: Action, path: string) => boolean;
  addPersistentGrant: (grant: GrantInput) => Promise<void>;
  getAllPersistent: () => Grant[];

  // Bash-command session-level (in-memory).
  hasBashSessionGrant: (projectHash: string, rawCommand: string) => boolean;
  addBashSessionGrant: (projectHash: string, rawCommand: string, reason: string, permission: Permission) => void;
  clearBashGrants: () => void;

  // Bash-command persistent (disk-backed, async).
  hasBashPersistentGrant: (projectHash: string, rawCommand: string) => boolean;
  addBashPersistentGrant: (grant: BashGrantInput) => Promise<void>;
  getAllPersistentBash: () => BashGrant[];

  // Author lookup (added for authorization-classification change).
  // Session grants are always "by_person" (their write path is human prompt
  // choice). Persistent grants inherit the Grant.author field; a missing
  // author (legacy trusted.json) is treated as "by_person" per D5.
  // Returns undefined when neither session nor persistent grant hits.
  lookupGrantAuthor: (projectHash: string, action: Action, path: string) => GrantAuthor | undefined;
  lookupBashGrantAuthor: (projectHash: string, rawCommand: string) => GrantAuthor | undefined;

  flush: () => Promise<void>;
  path: string;
}

interface PersistentFile {
  grants: Grant[];
  bashGrants: BashGrant[];
}

function grantKey(projectHash: string, action: Action, path: string): string {
  return `${projectHash}|${action}|${path}`;
}

function bashKey(projectHash: string, rawCommand: string): string {
  return `${projectHash}|${hashCommand(rawCommand)}`;
}

function hashCommand(rawCommand: string): string {
  return createHash("sha256").update(rawCommand).digest("hex");
}

export async function createTrustStore(trustedFilePath: string): Promise<TrustStore> {
  // Ensure parent dir exists with 0o700 permissions. `mode: 0o700` only
  // applies when mkdir actually creates the directory; existing dirs keep
  // their mode. Explicitly chmod afterwards so an existing permissive dir
  // (e.g. created by an earlier version under a wider umask) gets
  // re-tightened. Windows: fs.chmod is a no-op, mode is ignored.
  const parentDir = dirname(trustedFilePath);
  await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    try {
      const st = await fs.stat(parentDir);
      if (typeof st.uid === "number" && st.uid === process.getuid()) {
        await fs.chmod(parentDir, 0o700);
      }
    } catch {
      // Best-effort: if chmod fails (read-only mount, etc.), proceed —
      // the file itself is still created under 0o600 and the audit
      // log captures permission-related failures separately.
    }
  }

  // Load persistent grants. If file doesn't exist, empty. If file is corrupt,
  // start with empty (surface error via warning to caller if we cared).
  // Migration (authorization-classification D5): legacy trusted.json entries
  // without an `author` field default to "by_person" — the only historical
  // write path was a human prompt choice. This is an in-memory view migration;
  // the disk file is left untouched until a subsequent write.
  let persistentGrants: Grant[] = [];
  let persistentBashGrants: BashGrant[] = [];
  try {
    const raw = await fs.readFile(trustedFilePath, "utf8");
    const parsed = JSON.parse(raw) as PersistentFile;
    if (Array.isArray(parsed.grants)) {
      persistentGrants = parsed.grants.map((g) => ({ ...g, author: g.author ?? "by_person" }));
    }
    if (Array.isArray(parsed.bashGrants)) {
      persistentBashGrants = parsed.bashGrants.map((g) => ({ ...g, author: g.author ?? "by_person" }));
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      // Corrupt file - we still start with empty; the caller can surface this.
      persistentGrants = [];
    }
  }

  // Session grants (in-memory).
  const sessionGrants = new Set<string>();
  // Bash-command session grants (in-memory).
  const bashSessionGrants = new Set<string>();

  return {
    path: trustedFilePath,

    hasSessionGrant: (projectHash, action, path) => {
      return sessionGrants.has(grantKey(projectHash, action, path));
    },

    addSessionGrant: (projectHash, action, path) => {
      sessionGrants.add(grantKey(projectHash, action, path));
    },

    clearSessionGrants: () => {
      sessionGrants.clear();
      bashSessionGrants.clear();
    },

    hasPersistentGrant: (projectHash, action, path) => {
      const key = grantKey(projectHash, action, path);
      return persistentGrants.some((g) => grantKey(g.projectHash, g.action, g.path) === key);
    },

    addPersistentGrant: async (grant: GrantInput) => {
      // Upsert by key.
      const key = grantKey(grant.projectHash, grant.action, grant.path);
      persistentGrants = persistentGrants.filter(
        (g) => grantKey(g.projectHash, g.action, g.path) !== key,
      );
      // Default author to "by_person" if caller omitted it (design.md D5):
      // the only current write path is a human prompt choice.
      persistentGrants.push({
        ...grant,
        author: grant.author ?? "by_person",
        createdAt: new Date().toISOString(),
      } as Grant);
      await atomicWrite(trustedFilePath, { grants: persistentGrants, bashGrants: persistentBashGrants });
    },

    getAllPersistent: () => {
      return [...persistentGrants];
    },

    hasBashSessionGrant: (projectHash, rawCommand) => {
      return bashSessionGrants.has(bashKey(projectHash, rawCommand));
    },

    addBashSessionGrant: (projectHash, rawCommand, _reason, _permission) => {
      // Reason and permission are recorded for future lookup but not part
      // of the session key (session grants are always exact-command match).
      void _reason;
      void _permission;
      bashSessionGrants.add(bashKey(projectHash, rawCommand));
    },

    clearBashGrants: () => {
      bashSessionGrants.clear();
    },

    hasBashPersistentGrant: (projectHash, rawCommand) => {
      const key = bashKey(projectHash, rawCommand);
      return persistentBashGrants.some((g) => bashKey(g.projectHash, g.rawCommand) === key);
    },

    addBashPersistentGrant: async (grant: BashGrantInput) => {
      // Upsert by (projectHash, commandHash).
      const key = bashKey(grant.projectHash, grant.rawCommand);
      persistentBashGrants = persistentBashGrants.filter(
        (g) => bashKey(g.projectHash, g.rawCommand) !== key,
      );
      persistentBashGrants.push({
        ...grant,
        author: grant.author ?? "by_person",
        commandHash: hashCommand(grant.rawCommand),
        createdAt: new Date().toISOString(),
      });
      await atomicWrite(trustedFilePath, { grants: persistentGrants, bashGrants: persistentBashGrants });
    },

    getAllPersistentBash: () => {
      return [...persistentBashGrants];
    },

    lookupGrantAuthor: (projectHash, action, path) => {
      // Session grant hits are always by_person (human prompt write path).
      if (sessionGrants.has(grantKey(projectHash, action, path))) {
        return "by_person";
      }
      const key = grantKey(projectHash, action, path);
      const hit = persistentGrants.find((g) => grantKey(g.projectHash, g.action, g.path) === key);
      return hit ? (hit.author ?? "by_person") : undefined;
    },

    lookupBashGrantAuthor: (projectHash, rawCommand) => {
      // Session grant hits are always by_person (human prompt write path).
      if (bashSessionGrants.has(bashKey(projectHash, rawCommand))) {
        return "by_person";
      }
      const key = bashKey(projectHash, rawCommand);
      const hit = persistentBashGrants.find((g) => bashKey(g.projectHash, g.rawCommand) === key);
      return hit ? (hit.author ?? "by_person") : undefined;
    },

    flush: async () => {
      await atomicWrite(trustedFilePath, { grants: persistentGrants, bashGrants: persistentBashGrants });
    },
  };
}

// Atomic write: write to a temp file in the same directory, then rename.
// After rename, chmod the target to 0o600 best-effort so that a
// previously-permissive trusted.json gets re-tightened on every write
// (spec: trusted.json 文件与目录权限).
async function atomicWrite(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, path);
    // Belt-and-braces: even if the tmp file was created with mode 0o600,
    // umask might have widened it (Node uses `mode & ~umask` for new
    // files). Chmod the final path to force 0o600.
    const chmodSink: Error[] = [];
    await ensureFileMode(path, 0o600, chmodSink);
  } catch (err) {
    // Best-effort cleanup of temp file on failure.
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
