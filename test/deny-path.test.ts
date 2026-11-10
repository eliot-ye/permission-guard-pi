//
// TDD RED: deny-path tests. Covers isDenyHit pure function + mergePolicies
// deny-segment parsing + resolveDenyPath.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { isDenyHit } from "../src/lib/path-utils.ts";
import { mergePolicies, type RawConfig } from "../src/lib/config.ts";

// -------- isDenyHit: pure function --------

test("isDenyHit: positive hit with no negation -> true", () => {
  assert.equal(isDenyHit("/x/certs/root.pem", ["**/*.pem"]), true);
});

test("isDenyHit: positive not hit -> false", () => {
  assert.equal(isDenyHit("/x/app.ts", ["**/*.pem"]), false);
});

test("isDenyHit: positive hit + negation exempts -> false", () => {
  assert.equal(isDenyHit("/x/certs/public.pem", ["**/*.pem", "!**/public.pem"]), false);
});

test("isDenyHit: positive hit + negation not hit -> true", () => {
  assert.equal(isDenyHit("/x/certs/root.pem", ["**/*.pem", "!**/public.pem"]), true);
});

test("isDenyHit: pure negation list (no positive) -> false", () => {
  assert.equal(isDenyHit("/x/certs/public.pem", ["!**/public.pem"]), false);
  assert.equal(isDenyHit("/x/anything", ["!**/public.pem"]), false);
});

test("isDenyHit: empty pattern list -> false", () => {
  assert.equal(isDenyHit("/x/anything", []), false);
});

test("isDenyHit: * matches within one segment (no /)", () => {
  // `*` is single-segment (no /): matches a bare basename pattern against a
  // single-segment path, but not a deep path (deep needs **).
  assert.equal(isDenyHit(".env", ["*.env"]), true);
  assert.equal(isDenyHit("deep/.env", ["*.env"]), false);
});

test("isDenyHit: ** matches across segments", () => {
  assert.equal(isDenyHit("/a/b/c/.env", ["**/.env"]), true);
  assert.equal(isDenyHit("/.env", ["**/.env"]), true);
});

test("isDenyHit: order-independent negation (negation first == negation last)", () => {
  const negFirst = ["!**/public.pem", "**/*.pem"];
  const negLast = ["**/*.pem", "!**/public.pem"];
  assert.equal(isDenyHit("/x/certs/public.pem", negFirst), false);
  assert.equal(isDenyHit("/x/certs/public.pem", negLast), false);
  assert.equal(isDenyHit("/x/certs/root.pem", negFirst), true);
  assert.equal(isDenyHit("/x/certs/root.pem", negLast), true);
});

// -------- mergePolicies: deny segment parsing + resolveDenyPath --------

test("resolveDenyPath: global deny hit -> true", () => {
  const global: RawConfig = { deny: ["**/*.pem"] };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  assert.equal(policy.resolveDenyPath("/proj/certs/root.pem"), true);
});

test("resolveDenyPath: three-tier deny segments merge additively", () => {
  const global: RawConfig = { deny: ["**/*.pem"] };
  const project: RawConfig = { deny: ["**/*.key"] };
  const local: RawConfig = { deny: ["!**/public.pem"] };
  const { policy } = mergePolicies(global, project, local, "/proj");
  // pem hit (global), key hit (project), public.pem exempt (local negation only exempts pem, not key).
  assert.equal(policy.resolveDenyPath("/proj/a.pem"), true);
  assert.equal(policy.resolveDenyPath("/proj/a.key"), true);
  assert.equal(policy.resolveDenyPath("/proj/public.pem"), false);
  assert.equal(policy.resolveDenyPath("/proj/public.key"), true);
});

test("resolveDenyPath: negation exempt -> false", () => {
  const global: RawConfig = { deny: ["**/*.pem", "!**/public.pem"] };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  assert.equal(policy.resolveDenyPath("/proj/certs/public.pem"), false);
  assert.equal(policy.resolveDenyPath("/proj/certs/root.pem"), true);
});

test("resolveDenyPath: missing deny field -> always false (backward compat)", () => {
  const global: RawConfig = { paths: { "/x": "read_write" } };
  const { policy } = mergePolicies(global, {}, {}, "/proj");
  assert.equal(policy.resolveDenyPath("/x/anything"), false);
  assert.equal(policy.resolveDenyPath("/x/.env"), false);
});

test("resolveDenyPath: relative pattern scoped to projectRoot", () => {
  // A relative (non-absolute) pattern is scoped inside projectRoot.
  const project: RawConfig = { deny: ["secrets/**"] };
  const { policy } = mergePolicies({}, project, {}, "/proj");
  assert.equal(policy.resolveDenyPath("/proj/secrets/a.txt"), true);
  assert.equal(policy.resolveDenyPath("/other/secrets/a.txt"), false);
});
