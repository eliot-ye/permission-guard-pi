//
// TDD RED: lang-detect + settings tests.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectLang } from "../src/lib/lang-detect.ts";
import { loadSettings } from "../src/lib/settings.ts";
import { promises as fs } from "node:fs";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============ lang-detect tests ============

test("detectLang: PI_LANG wins over all else", () => {
  const env = { PI_LANG: "zh", LANG: "en_US.UTF-8" };
  assert.equal(detectLang(env, { lang: "en" }), "zh");
});

test("detectLang: settings.lang wins over $LANG", () => {
  const env = { LANG: "en_US.UTF-8" };
  assert.equal(detectLang(env, { lang: "zh" }), "zh");
});

test("detectLang: $LANG prefix extraction", () => {
  const env = { LANG: "zh_CN.UTF-8" };
  assert.equal(detectLang(env, {}), "zh");
});

test("detectLang: $LANG en_US maps to en", () => {
  const env = { LANG: "en_US.UTF-8" };
  assert.equal(detectLang(env, {}), "en");
});

test("detectLang: all empty falls back to en", () => {
  assert.equal(detectLang({}, {}), "en");
});

test("detectLang: invalid PI_LANG skips to settings", () => {
  const env = { PI_LANG: "fr", LANG: "en_US.UTF-8" };
  assert.equal(detectLang(env, { lang: "zh" }), "zh");
});

test("detectLang: invalid settings.lang skips to $LANG", () => {
  const env = { LANG: "zh_CN.UTF-8" };
  assert.equal(detectLang(env, { lang: "fr" }), "zh");
});

test("detectLang: all invalid falls back to en", () => {
  const env = { PI_LANG: "fr", LANG: "fr_FR.UTF-8" };
  assert.equal(detectLang(env, { lang: "ja" }), "en");
});

test("detectLang: PI_LANG=zh overrides settings=en", () => {
  const env = { PI_LANG: "zh" };
  assert.equal(detectLang(env, { lang: "en" }), "zh");
});

// ============ settings.ts tests ============

test("loadSettings: reads valid JSON file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ lang: "zh" }));
    const s = await loadSettings(dir);
    assert.deepEqual(s, { lang: "zh" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSettings: reads JSONC with comments and trailing commas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try {
    const jsonc = `{
      // UI language
      "lang": "zh", // set to Chinese
      /* future field */
    }`;
    await writeFile(join(dir, "settings.json"), jsonc);
    const s = await loadSettings(dir);
    assert.equal(s.lang, "zh");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSettings: missing file returns empty settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try {
    const s = await loadSettings(dir);
    assert.deepEqual(s, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSettings: malformed JSON returns empty settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try {
    await writeFile(join(dir, "settings.json"), "not valid json {{{{");
    const s = await loadSettings(dir);
    assert.deepEqual(s, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSettings: preserves invalid lang value for downstream check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ lang: "fr" }));
    const s = await loadSettings(dir);
    // Downstream detectLang() skips unrecognized values.
    assert.equal(s.lang, "fr");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSettings: empty object is preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try {
    await writeFile(join(dir, "settings.json"), "{}");
    const s = await loadSettings(dir);
    assert.deepEqual(s, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============ integration: settings + detectLang ============

test("integration: settings.json lang is used when PI_LANG unset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ lang: "zh" }));
    const s = await loadSettings(dir);
    assert.equal(detectLang({}, s), "zh");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("integration: $PI_LANG overrides settings.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settings-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ lang: "zh" }));
    const s = await loadSettings(dir);
    const env = { PI_LANG: "en" };
    assert.equal(detectLang(env, s), "en");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
