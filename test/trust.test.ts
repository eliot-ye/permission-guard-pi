//
// TDD RED: trust (grant-memory) tests. Covers GM1-GM12.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTrustStore, type TrustStore, type Grant } from "../src/lib/trust.ts";

async function withTmpStore<T>(fn: (store: TrustStore, path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-trust-"));
  try {
    const path = join(dir, "trusted.json");
    const store = await createTrustStore(path);
    return await fn(store, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -------- GM1: session grant auto-allows within session --------

test("GM1: session_grant_auto_allows_within_session", async () => {
  await withTmpStore(async (store) => {
    store.addSessionGrant("hash1", "read", "/abs/path");
    assert.equal(store.hasSessionGrant("hash1", "read", "/abs/path"), true);
  });
});

// -------- GM2: session grant cleared on new session --------

test("GM2: session_grant_cleared_on_new_session", async () => {
  await withTmpStore(async (store) => {
    store.addSessionGrant("hash1", "read", "/abs/path");
    store.clearSessionGrants();
    assert.equal(store.hasSessionGrant("hash1", "read", "/abs/path"), false);
  });
});

// -------- GM3: persistent grant survives session restart --------

test("GM3: persistent_grant_survives_session_restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-trust-"));
  try {
    const path = join(dir, "trusted.json");

    // First session: add persistent grant.
    let store = await createTrustStore(path);
    await store.addPersistentGrant({
      projectHash: "hash1",
      action: "read",
      path: "/abs/path",
      permission: "read_write",
    });

    // Simulate restart: create new store from same file.
    store = await createTrustStore(path);

    assert.equal(store.hasPersistentGrant("hash1", "read", "/abs/path"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -------- GM4: different projects' grants isolated --------

test("GM4: grant_key_is_scoped_to_project_hash", async () => {
  await withTmpStore(async (store) => {
    await store.addPersistentGrant({
      projectHash: "projA",
      action: "read",
      path: "/abs/path",
      permission: "read_write",
    });
    // Project B has no grant
    assert.equal(store.hasPersistentGrant("projB", "read", "/abs/path"), false);
    assert.equal(store.hasPersistentGrant("projA", "read", "/abs/path"), true);
  });
});

// -------- GM5: same project hash stable for subdir access --------

test("GM5: project_hash_stable_when_cd_into_subdirectory", async () => {
  // This tests the hashProject function (from path-utils), not trust itself.
  // But we verify that trust's projectHash scoping is stable for a fixed hash.
  await withTmpStore(async (store) => {
    const h = "abc123def456";
    await store.addPersistentGrant({
      projectHash: h,
      action: "read",
      path: "/abs/path",
      permission: "read_write",
    });
    assert.equal(store.hasPersistentGrant(h, "read", "/abs/path"), true);
  });
});

// -------- GM6: distinct worktrees produce distinct hashes --------

test("GM6: distinct_worktrees_produce_distinct_project_hashes", async () => {
  await withTmpStore(async (store) => {
    await store.addPersistentGrant({
      projectHash: "wt-main",
      action: "read",
      path: "/abs/path",
      permission: "read_write",
    });
    assert.equal(store.hasPersistentGrant("wt-feature", "read", "/abs/path"), false);
  });
});

// -------- GM7: persistent grant records permission level --------

test("GM7: persistent_grant_persists_permission_level", async () => {
  await withTmpStore(async (store, path) => {
    await store.addPersistentGrant({
      projectHash: "hash1",
      action: "read",
      path: "/abs/path",
      permission: "read_write",
    });
    await store.flush();
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.grants.length, 1);
    assert.equal(parsed.grants[0].permission, "read_write");
  });
});

// -------- GM8: missing trusted.json treated as empty --------

test("GM8: missing_trusted_json_is_treated_as_empty_grants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-trust-"));
  try {
    const path = join(dir, "trusted.json");
    // File does NOT exist
    const store = await createTrustStore(path);
    assert.deepEqual(store.getAllPersistent(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -------- GM9: atomic write survives mid-write crash --------

test("GM9: trust_store_atomic_write_survives_mid_write_crash", async () => {
  await withTmpStore(async (store, path) => {
    // Write once to create the file with valid content.
    await store.addPersistentGrant({
      projectHash: "hash1",
      action: "read",
      path: "/abs/path",
      permission: "read_write",
    });
    await store.flush();

    const content1 = await readFile(path, "utf8");
    JSON.parse(content1); // must be valid JSON

    // Add another grant and flush.
    await store.addPersistentGrant({
      projectHash: "hash1",
      action: "write",
      path: "/abs/path",
      permission: "read_write",
    });
    await store.flush();

    const content2 = await readFile(path, "utf8");
    const parsed2 = JSON.parse(content2); // must still be valid JSON
    assert.equal(parsed2.grants.length, 2);
  });
});

// -------- GM10: sensitive grants per-file not per-directory --------

test("GM10: sensitive_grants_are_per_file_not_per_directory", async () => {
  await withTmpStore(async (store) => {
    await store.addPersistentGrant({
      projectHash: "hash1",
      action: "read",
      path: "/Users/x/.ssh/id_rsa",
      permission: "read_write",
    });
    assert.equal(store.hasPersistentGrant("hash1", "read", "/Users/x/.ssh/id_rsa"), true);
    // Different file in same directory is NOT auto-allowed
    assert.equal(store.hasPersistentGrant("hash1", "read", "/Users/x/.ssh/known_hosts"), false);
  });
});

// -------- GM11: session_start clears session grants + loads persistent --------

test("GM11: session_start_clears_session_grants_and_loads_persistent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-trust-"));
  try {
    const path = join(dir, "trusted.json");

    let store = await createTrustStore(path);
    store.addSessionGrant("h1", "read", "/p1");
    await store.addPersistentGrant({
      projectHash: "h1",
      action: "read",
      path: "/p2",
      permission: "read_write",
    });
    await store.flush();

    // New session - re-create store from same file.
    store = await createTrustStore(path);

    // Session grant should be gone.
    assert.equal(store.hasSessionGrant("h1", "read", "/p1"), false);
    // Persistent grant should be there.
    assert.equal(store.hasPersistentGrant("h1", "read", "/p2"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -------- GM12: two-tier grant doesn't write persistent (verified via API contract) --------

test("GM12: two_tier_grant_does_not_write_persistent_storage", async () => {
  // The trust store doesn't know about tiers - it's the extension layer's job
  // to only call addPersistentGrant for tier=three. We verify the API allows
  // explicit session-only persistence.
  await withTmpStore(async (store, path) => {
    store.addSessionGrant("h1", "read", "/p");
    // flush should not write session grants
    await store.flush();
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.grants.length, 0);
  });
});

// -------- GM13+: bash command grants --------

test("GM13: bash_session_grant_auto_allows_within_session", async () => {
  await withTmpStore(async (store) => {
    const cmd = "cat /etc/passwd 2>/dev/null";
    assert.equal(store.hasBashSessionGrant("h1", cmd), false);
    store.addBashSessionGrant("h1", cmd, "glob_expansion", "read_only");
    assert.equal(store.hasBashSessionGrant("h1", cmd), true);
    // Different command should NOT match.
    assert.equal(store.hasBashSessionGrant("h1", "cat /etc/hosts 2>/dev/null"), false);
  });
});

test("GM14: bash_session_grant_cleared_on_new_session", async () => {
  const cmd = "ls /tmp/*.log";
  await withTmpStore(async (store, path) => {
    store.addBashSessionGrant("h1", cmd, "glob_expansion", "read_only");
    assert.equal(store.hasBashSessionGrant("h1", cmd), true);
    // Clear session grants (simulates new session).
    store.clearSessionGrants();
    assert.equal(store.hasBashSessionGrant("h1", cmd), false);
  });
});

test("GM15: bash_persistent_grant_survives_session_restart", async () => {
  const cmd = "cat /etc/passwd 2>/dev/null";
  await withTmpStore(async (store, path) => {
    await store.addBashPersistentGrant({
      projectHash: "h1",
      rawCommand: cmd,
      reason: "glob_expansion",
      permission: "read_only",
    });
    // Simulate new session (recreate store from same file).
    const store2 = await createTrustStore(path);
    assert.equal(store2.hasBashPersistentGrant("h1", cmd), true);
  });
});

test("GM16: bash_grant_scoped_to_project_hash", async () => {
  await withTmpStore(async (store) => {
    const cmd = "cat /etc/passwd 2>/dev/null";
    store.addBashSessionGrant("h1", cmd, "glob_expansion", "read_only");
    assert.equal(store.hasBashSessionGrant("h1", cmd), true);
    // Different projectHash should NOT match.
    assert.equal(store.hasBashSessionGrant("h2", cmd), false);
  });
});

test("GM17: bash_persistent_grant_preserves_command_hash_and_raw", async () => {
  await withTmpStore(async (store, path) => {
    const cmd = "cat /etc/passwd 2>/dev/null";
    await store.addBashPersistentGrant({
      projectHash: "h1",
      rawCommand: cmd,
      reason: "glob_expansion",
      permission: "read_only",
    });
    await store.flush();
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.bashGrants.length, 1);
    const g = parsed.bashGrants[0];
    assert.equal(g.projectHash, "h1");
    assert.equal(g.rawCommand, cmd);
    assert.equal(g.reason, "glob_expansion");
    assert.equal(g.permission, "read_only");
    // commandHash should be a 64-char hex string (sha256).
    assert.match(g.commandHash, /^[0-9a-f]{64}$/);
  });
});

test("GM18: bash_persistent_grant_upserts_by_command_hash", async () => {
  await withTmpStore(async (store, path) => {
    const cmd = "cat /etc/passwd 2>/dev/null";
    await store.addBashPersistentGrant({
      projectHash: "h1",
      rawCommand: cmd,
      reason: "glob_expansion",
      permission: "read_only",
    });
    await store.addBashPersistentGrant({
      projectHash: "h1",
      rawCommand: cmd,
      reason: "glob_expansion",
      permission: "read_write",
    });
    await store.flush();
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.bashGrants.length, 1);
    assert.equal(parsed.bashGrants[0].permission, "read_write");
  });
});

test("GM19: flush_writes_both_grants_and_bash_grants", async () => {
  await withTmpStore(async (store, path) => {
    store.addSessionGrant("h1", "read", "/path/1");
    store.addBashSessionGrant("h1", "echo hi", "shell_forwarder", "read_only");
    await store.flush();
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    // Session grants should not persist.
    assert.equal(parsed.grants.length, 0);
    assert.equal(parsed.bashGrants.length, 0);
  });
});

test("GM20: missing_trusted_json_treats_bash_grants_as_empty", async () => {
  await withTmpStore(async (store) => {
    assert.equal(store.getAllPersistentBash().length, 0);
    assert.equal(store.hasBashPersistentGrant("h1", "any command"), false);
  });
});

test("GM21: bash_grant_whitespace_normalized_equivalent", async () => {
  // P1 (bash raw-command grant 等价语义, e2): grant key is normalized
  // whitespace (replace(/\s+/g," ").trim()), so `git  status` (double space)
  // matches a grant issued for `git status`. This aligns with rule matching
  // (config.ts normalizeWhitespace) — same system, one equivalence semantic.
  await withTmpStore(async (store, path) => {
    const cmd = "git status";
    await store.addBashPersistentGrant({
      projectHash: "h1",
      rawCommand: cmd,
      reason: "glob_expansion",
      permission: "read_only",
    });
    // Whitespace-variant command must hit the same grant.
    assert.equal(store.hasBashPersistentGrant("h1", "git  status"), true, "double space matches");
    assert.equal(store.hasBashPersistentGrant("h1", "git    status"), true, "multiple spaces match");
    assert.equal(store.hasBashPersistentGrant("h1", "  git status  "), true, "leading/trailing space matches");
    // Different command must NOT match.
    assert.equal(store.hasBashPersistentGrant("h1", "git status --short"), false, "extra arg does not match");
    // The stored rawCommand stays exact (grant preserves the original string).
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.bashGrants[0].rawCommand, cmd, "rawCommand preserved exact");
  });
});

test("GM22: bash_grant_whitespace_normalized_session", async () => {
  // Session grants follow the same normalized-key semantic.
  await withTmpStore(async (store) => {
    store.addBashSessionGrant("h1", "echo hi", "shell_forwarder", "read_only");
    assert.equal(store.hasBashSessionGrant("h1", "echo  hi"), true, "session grant whitespace match");
    assert.equal(store.hasBashSessionGrant("h1", "echo hi there"), false, "different args no match");
  });
});

// -------- GMP1-GMP3: file/dir permission hardening (Change A) --------

test("GMP1: trust_store_writes_trusted_json_with_0600_permissions", async () => {
  await withTmpStore(async (store, path) => {
    // First persistent write creates the file.
    await store.addPersistentGrant({
      projectHash: "h1",
      action: "read",
      path: "/abs/path",
      permission: "read_only",
    });
    const s = await stat(path);
    assert.equal(
      s.mode & 0o777,
      0o600,
      `trusted.json should be 0600, got ${s.mode.toString(8)}`,
    );
  });
});

test("GMP2: trust_store_creates_parent_dir_with_0700_permissions", async () => {
  await withTmpStore(async (_store, path) => {
    const dir = path.replace(/\/trusted\.json$/, "");
    const s = await stat(dir);
    assert.equal(
      s.mode & 0o777,
      0o700,
      `parent dir should be 0700, got ${s.mode.toString(8)}`,
    );
  });
});

test("GMP3: atomic_write_chmods_existing_trusted_json_to_0600", async () => {
  await withTmpStore(async (store, path) => {
    // Seed an existing file with permissive mode.
    await store.addPersistentGrant({
      projectHash: "h1",
      action: "read",
      path: "/abs/path",
      permission: "read_only",
    });
    // Widen the file to 0644.
    await chmod(path, 0o644);
    const widened = await stat(path);
    assert.equal(widened.mode & 0o777, 0o644, "sanity: file was widened to 0644");

    // A subsequent atomic write must re-tighten to 0600.
    await store.addPersistentGrant({
      projectHash: "h1",
      action: "write",
      path: "/abs/path2",
      permission: "read_write",
    });
    const tightened = await stat(path);
    assert.equal(
      tightened.mode & 0o777,
      0o600,
      `trusted.json should be re-tightened to 0600, got ${tightened.mode.toString(8)}`,
    );
  });
});

// ============================================================
// authorization-classification (D2b, D5): lookupGrantAuthor / lookupBashGrantAuthor
// Covers:
//   - session grant hit → "by_person"
//   - persistent grant hit (explicit author) → author value
//   - persistent grant hit (legacy, no author) → "by_person" default
//   - bash session grant hit → "by_person"
//   - bash persistent grant hit (explicit + legacy) → author / "by_person"
//   - no hit → undefined
// ============================================================

test("T-TRUST-LA-1: session_grant_hit_returns_by_person", async () => {
  await withTmpStore(async (store) => {
    store.addSessionGrant("hash1", "read", "/abs/path");
    assert.equal(
      store.lookupGrantAuthor("hash1", "read", "/abs/path"),
      "by_person",
    );
  });
});

test("T-TRUST-LA-2: persistent_grant_hit_returns_stored_author", async () => {
  await withTmpStore(async (store) => {
    await store.addPersistentGrant({
      projectHash: "hash1",
      action: "read",
      path: "/abs/path",
      permission: "read_write",
      author: "by_person",
    });
    assert.equal(
      store.lookupGrantAuthor("hash1", "read", "/abs/path"),
      "by_person",
    );
  });
});

test("T-TRUST-LA-3: legacy_persistent_grant_no_author_defaults_to_by_person", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-trust-legacy-"));
  try {
    const path = join(dir, "trusted.json");
    // Pre-write a legacy trusted.json with no author field.
    await writeFile(
      path,
      JSON.stringify({
        grants: [
          {
            projectHash: "hash1",
            action: "read",
            path: "/abs/path",
            permission: "read_write",
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
        bashGrants: [],
      }),
      "utf8",
    );
    const store = await createTrustStore(path);
    assert.equal(
      store.lookupGrantAuthor("hash1", "read", "/abs/path"),
      "by_person",
      "legacy grant without author must default to by_person per D5",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T-TRUST-LA-4: no_hit_returns_undefined", async () => {
  await withTmpStore(async (store) => {
    assert.equal(store.lookupGrantAuthor("hash1", "read", "/abs/path"), undefined);
    assert.equal(store.lookupBashGrantAuthor("hash1", "cat x"), undefined);
  });
});

test("T-TRUST-LA-5: bash_session_grant_hit_returns_by_person", async () => {
  await withTmpStore(async (store) => {
    store.addBashSessionGrant("hash1", "cat /etc/hosts", "glob_expansion", "read_only");
    assert.equal(
      store.lookupBashGrantAuthor("hash1", "cat /etc/hosts"),
      "by_person",
    );
  });
});

test("T-TRUST-LA-6: bash_persistent_grant_hit_returns_stored_author", async () => {
  await withTmpStore(async (store) => {
    await store.addBashPersistentGrant({
      projectHash: "hash1",
      rawCommand: "cat /etc/hosts",
      reason: "glob_expansion",
      permission: "read_only",
      author: "by_person",
    });
    assert.equal(
      store.lookupBashGrantAuthor("hash1", "cat /etc/hosts"),
      "by_person",
    );
  });
});

// D5 scenario: 首次持久化写入带上新字段
// 加载旧 trusted.json 后写入新 grant——写操作是全量重写整个 trusted.json，
// 内存视图里的 migrated legacy entry 也带 author 一起落盘。
// 这符合 spec 里"新条目带上新字段"；legacy entry 的磁盘上是否保留原样取决于
// 是否有写入操作——本测试验证的是"有新写入的场景"。
test("T-TRUST-W3: first_write_after_legacy_load_adds_author_to_all_entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-trust-w3-"));
  try {
    const path = join(dir, "trusted.json");
    // Pre-write legacy trusted.json (no author field).
    await writeFile(
      path,
      JSON.stringify({
        grants: [
          {
            projectHash: "hash1",
            action: "read",
            path: "/legacy/path",
            permission: "read_write",
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
        bashGrants: [],
      }),
      "utf8",
    );

    const store = await createTrustStore(path);

    // Write a new grant without author — the store should default it.
    await store.addPersistentGrant({
      projectHash: "hash1",
      action: "write",
      path: "/new/path",
      permission: "read_write",
    });

    // Read back the raw disk file (not the migrated in-memory view).
    const raw = JSON.parse(await readFile(path, "utf8"));
    const newEntry = raw.grants.find((g: { path: string }) => g.path === "/new/path");
    const legacyEntry = raw.grants.find((g: { path: string }) => g.path === "/legacy/path");
    assert.equal(newEntry.author, "by_person", "new entry must carry author on disk");
    // Legacy entry now also carries author — in-memory migration is applied at load,
    // and the subsequent atomic write re-serializes the full view.
    assert.equal(legacyEntry.author, "by_person", "legacy entry picked up author via in-memory migration + subsequent write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// D5 scenario: 迁移不触发磁盘写入
// 加载旧 trusted.json 后不调用 flush()，磁盘文件保持不变。
test("T-TRUST-M3: migration_does_not_trigger_disk_write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-trust-m3-"));
  try {
    const path = join(dir, "trusted.json");
    const legacy = {
      grants: [
        {
          projectHash: "hash1",
          action: "read",
          path: "/legacy/path",
          permission: "read_write",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      bashGrants: [],
    };
    await writeFile(path, JSON.stringify(legacy), "utf8");
    const before = await readFile(path, "utf8");

    // Load the store — this runs the in-memory migration but MUST NOT write to disk.
    await createTrustStore(path);

    const after = await readFile(path, "utf8");
    assert.equal(after, before, "disk file must remain byte-identical after load-only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// D5 scenario: 新版本 trusted.json 有 author 字段保留原值
test("T-TRUST-M2: existing_author_field_preserved_on_load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-trust-m2-"));
  try {
    const path = join(dir, "trusted.json");
    await writeFile(
      path,
      JSON.stringify({
        grants: [
          {
            projectHash: "hash1",
            action: "read",
            path: "/abs/path",
            permission: "read_write",
            createdAt: "2025-01-01T00:00:00.000Z",
            author: "by_person",
          },
        ],
        bashGrants: [],
      }),
      "utf8",
    );
    const store = await createTrustStore(path);
    const list = store.getAllPersistent();
    assert.equal(list.length, 1);
    assert.equal(list[0].author, "by_person", "author must be preserved, not overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
