//
// User preferences (settings.json) for permission-guard-pi.
//
// Loaded from `~/.pi/agent/extensions/permission-guard-pi/settings.json`
// at session start. JSONC syntax for consistency with permission.json.
// Missing file or malformed JSON → empty settings (no error).
//
// Design (see design.md D5):
//   - Independent of the 3-tier permission.json hierarchy (separate
//     user-preference scope).
//   - Not part of RawConfig (no coupling with policy contract).
//   - Session-start read once, cached in SessionState.

import { promises as fs } from "node:fs";

import type { Lang } from "./reason-codes.ts";

export interface Settings {
  /** UI language. Absent or invalid → falls back to env chain. */
  lang?: string;
}

// -------- JSONC comment stripper (duplicated from config.ts, kept local
// to keep this module self-contained) --------

function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,\s*([\]\}])/g, "$1");
}

// -------- loadSettings() --------

/**
 * Load settings.json from the extension's runtime directory.
 * Missing file or malformed JSON → returns `{}` (no error thrown).
 * Malformed values (e.g., `lang: "fr"`) are preserved as-is; downstream
 * `detectLang()` skips unrecognized values and falls through.
 */
export async function loadSettings(agentExtDir: string): Promise<Settings> {
  const filePath = `${agentExtDir}/settings.json`;
  try {
    const text = await fs.readFile(filePath, "utf8");
    const stripped = stripJsonComments(text);
    const parsed = JSON.parse(stripped);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Settings;
  } catch {
    // ENOENT, JSON parse error, permission error, etc. — all degrade
    // to empty settings. Session continues with env-chain fallback.
    return {};
  }
}
