//
// TDD RED: path-utils tests written before implementation.
// Run with: node --experimental-strip-types --test test/path-utils.test.ts
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expandHome,
  toAbsolutePath,
  toKeyPath,
  matchesGlob,
  isInside,
  tryRealpath,
  hashProject,
  prettyPath,
} from "../src/lib/path-utils.ts";

// -------- expandHome --------

test("expandHome: ~/foo expands against $HOME", () => {
  process.env.HOME = "/Users/test";
  assert.equal(expandHome("~/foo/bar"), "/Users/test/foo/bar");
});

test("expandHome: leading ~ is expanded but bare ~ stays intact", () => {
  process.env.HOME = "/Users/test";
  // ~ should expand when followed by path separator
  assert.equal(expandHome("~"), "/Users/test");
  // A path where ~ is not at start should be preserved
  assert.equal(expandHome("/foo/bar"), "/foo/bar");
});

test("expandHome: no-op on absolute paths without ~", () => {
  assert.equal(expandHome("/absolute/path"), "/absolute/path");
  assert.equal(expandHome("C:\\Users\\x"), "C:\\Users\\x");
});

// -------- toAbsolutePath --------

test("toAbsolutePath: backslash becomes forward slash", () => {
  assert.equal(toAbsolutePath("C:\\Users\\me\\file.txt", "/proj"), "C:/Users/me/file.txt");
});

test("toAbsolutePath: resolves relative paths against projectRoot", () => {
  assert.equal(toAbsolutePath("src/main.ts", "/proj"), "/proj/src/main.ts");
});

test("toAbsolutePath: resolves .. segments", () => {
  // From /proj/src, ../outside/x resolves to /proj/outside/x
  assert.equal(toAbsolutePath("../outside/x", "/proj/src"), "/proj/outside/x");
  // Two levels up exits /proj
  assert.equal(toAbsolutePath("../../outside/x", "/proj/src"), "/outside/x");
});

test("toAbsolutePath: does not lowercase drive-letter paths", () => {
  // Windows drive letters should keep their case
  assert.equal(toAbsolutePath("C:\\Temp", "/proj"), "C:/Temp");
});

// -------- toKeyPath --------

test("toKeyPath: normalizes drive-letter path case", () => {
  // For Windows-style paths, key form is lowercased for case-insensitive comparison
  assert.equal(toKeyPath("C:/Users/Me/X.txt"), "c:/users/me/x.txt");
});

test("toKeyPath: on POSIX, path is preserved verbatim", () => {
  assert.equal(toKeyPath("/Users/Me/X.txt"), "/Users/Me/X.txt");
});

test("toKeyPath: forward slashes always", () => {
  assert.equal(toKeyPath("a\\b\\c"), "a/b/c");
});

// -------- matchesGlob --------

test("matchesGlob: ** matches across directories", () => {
  assert.equal(matchesGlob("**/*.pem", "vendor/certs/root.pem"), true);
  assert.equal(matchesGlob("**/*.pem", "c.pem"), true);
  assert.equal(matchesGlob("**/*.pem", "a/b/c/key.txt"), false);
});

test("matchesGlob: * matches within one path segment", () => {
  assert.equal(matchesGlob("src/*.ts", "src/main.ts"), true);
  assert.equal(matchesGlob("src/*.ts", "src/a/b.ts"), false);
});

test("matchesGlob: ? matches exactly one char", () => {
  assert.equal(matchesGlob("file?.txt", "file1.txt"), true);
  assert.equal(matchesGlob("file?.txt", "file12.txt"), false);
});

test("matchesGlob: [abc] character class", () => {
  assert.equal(matchesGlob("file[123].txt", "file1.txt"), true);
  assert.equal(matchesGlob("file[123].txt", "file4.txt"), false);
});

test("matchesGlob: literal pattern must equal exactly", () => {
  assert.equal(matchesGlob("src/main.ts", "src/main.ts"), true);
  assert.equal(matchesGlob("src/main.ts", "src/other.ts"), false);
});

// -------- isInside --------

test("isInside: path under projectRoot is inside", () => {
  assert.equal(isInside("/proj/src/main.ts", "/proj"), true);
});

test("isInside: sibling or parent is outside", () => {
  assert.equal(isInside("/other/x", "/proj"), false);
  assert.equal(isInside("/proj.parent/x", "/proj"), false);
  assert.equal(isInside("/", "/proj"), false);
});

test("isInside: exact projectRoot is inside", () => {
  assert.equal(isInside("/proj", "/proj"), true);
});

// -------- tryRealpath --------

test("tryRealpath: returns original path when realpath fails", async () => {
  const missing = "/nonexistent/path/xyz/123";
  const result = await tryRealpath(missing);
  assert.equal(result, missing);
});

test("tryRealpath: returns realpath for existing path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-test-"));
  try {
    const p = join(dir, "file.txt");
    await writeFile(p, "x");
    const result = await tryRealpath(p);
    assert.notEqual(result, "");
    assert.equal(result, await realpath(p));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -------- hashProject --------

test("hashProject: stable for same path", () => {
  const a = hashProject("/proj");
  const b = hashProject("/proj");
  assert.equal(a, b);
});

test("hashProject: 12 hex chars", () => {
  const h = hashProject("/proj");
  assert.match(h, /^[0-9a-f]{12}$/);
});

test("hashProject: different paths produce different hashes", () => {
  const a = hashProject("/proj-a");
  const b = hashProject("/proj-b");
  assert.notEqual(a, b);
});

test("hashProject: case-insensitive on paths (Windows normalization)", () => {
  // Same path with different case should hash the same
  const a = hashProject("/Proj/SubDir");
  const b = hashProject("/proj/subdir");
  assert.equal(a, b);
});

test("hashProject: backslashes normalize to slashes", () => {
  const a = hashProject("/proj/src\\main");
  const b = hashProject("/proj/src/main");
  assert.equal(a, b);
});

// -------- prettyPath --------

test("prettyPath: replaces HOME with ~", () => {
  process.env.HOME = "/Users/test";
  assert.equal(prettyPath("/Users/test/.ssh"), "~/.ssh");
});

test("prettyPath: other paths shown as-is", () => {
  process.env.HOME = "/Users/test";
  assert.equal(prettyPath("/etc/passwd"), "/etc/passwd");
});
