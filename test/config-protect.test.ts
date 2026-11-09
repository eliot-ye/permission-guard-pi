//
// TDD RED: config-protect predicates written before implementation.
// Run with: node --experimental-strip-types --test test/config-protect.test.ts
//
// isProtectedRuntimeState: L1 runtime-state protection (trusted.json / settings.json).
// isConfigWritePath: L2 config-write protection (permission.json global/project/local).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { isProtectedRuntimeState, isConfigWritePath } from "../src/lib/config-protect.ts";

// -------- isProtectedRuntimeState --------

test("isProtectedRuntimeState: exact trusted.json path matches", () => {
  const trusted = "/Users/t/.pi/agent/extensions/permission-guard-pi/trusted.json";
  assert.equal(isProtectedRuntimeState(trusted, trusted, "/x/settings.json"), true);
});

test("isProtectedRuntimeState: exact settings.json path matches", () => {
  const settings = "/Users/t/.pi/agent/extensions/permission-guard-pi/settings.json";
  assert.equal(isProtectedRuntimeState(settings, "/x/trusted.json", settings), true);
});

test("isProtectedRuntimeState: ordinary path does not match", () => {
  assert.equal(
    isProtectedRuntimeState("/Users/t/proj/foo.txt", "/t/trusted.json", "/t/settings.json"),
    false,
  );
});

test("isProtectedRuntimeState: a permission.json path is not runtime-state protected", () => {
  assert.equal(
    isProtectedRuntimeState("/Users/t/proj/.pi/permission.json", "/t/trusted.json", "/t/settings.json"),
    false,
  );
});

test("isProtectedRuntimeState: `..` variant resolves to protected path", () => {
  const trusted = "/Users/t/.pi/agent/extensions/permission-guard-pi/trusted.json";
  const dotdot = "/Users/t/.pi/agent/extensions/permission-guard-pi/../permission-guard-pi/trusted.json";
  assert.equal(isProtectedRuntimeState(dotdot, trusted, "/x/settings.json"), true);
});

test("isProtectedRuntimeState: `~` variant expands to protected path", () => {
  const trusted = "/Users/t/.pi/agent/extensions/permission-guard-pi/trusted.json";
  // toAbsolutePath resolves ~ against $HOME at call time inside the predicate.
  process.env.HOME = "/Users/t";
  assert.equal(
    isProtectedRuntimeState("~/.pi/agent/extensions/permission-guard-pi/trusted.json", trusted, "/x/settings.json"),
    true,
  );
});

// -------- isConfigWritePath --------

const CONFIG_PATHS = [
  "/Users/t/.pi/agent/permission.json", // global
  "/Users/t/proj/.pi/permission.json", // project
  "/Users/t/proj/.pi/local/permission.json", // project-local
];

test("isConfigWritePath: write to global permission.json matches", () => {
  assert.equal(isConfigWritePath("write", CONFIG_PATHS[0], CONFIG_PATHS), true);
});

test("isConfigWritePath: write to project permission.json matches", () => {
  assert.equal(isConfigWritePath("write", CONFIG_PATHS[1], CONFIG_PATHS), true);
});

test("isConfigWritePath: write to project-local permission.json matches", () => {
  assert.equal(isConfigWritePath("write", CONFIG_PATHS[2], CONFIG_PATHS), true);
});

test("isConfigWritePath: delete matches, read does not", () => {
  assert.equal(isConfigWritePath("delete", CONFIG_PATHS[1], CONFIG_PATHS), true);
  assert.equal(isConfigWritePath("read", CONFIG_PATHS[1], CONFIG_PATHS), false);
});

test("isConfigWritePath: ordinary write does not match", () => {
  assert.equal(isConfigWritePath("write", "/Users/t/proj/foo.txt", CONFIG_PATHS), false);
});

test("isConfigWritePath: write to trusted.json does not count as config-write", () => {
  assert.equal(
    isConfigWritePath("write", "/Users/t/.pi/agent/extensions/permission-guard-pi/trusted.json", CONFIG_PATHS),
    false,
  );
});

test("isConfigWritePath: `..` variant of a config path matches", () => {
  const dotdot = "/Users/t/proj/.pi/local/../permission.json";
  assert.equal(isConfigWritePath("write", dotdot, CONFIG_PATHS), true);
});
