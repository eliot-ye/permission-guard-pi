//
// Language detection for permission-guard-pi.
//
// Priority chain (design.md D6):
//   1. $PI_LANG (highest) — env var, not defined by pi itself; user-set
//   2. settings.json.lang — explicit user config
//   3. $LANG (first 2 chars) — POSIX system locale
//   4. "en" — ultimate fallback
//
// Invalid values (non-"en" / non-"zh") at any level are skipped and
// the next level is tried.
//
// This function is pure (no IO, no side effects) — caller provides
// the env snapshot and settings object.

import type { Lang } from "./reason-codes.ts";

import type { Settings } from "./settings.ts";

export function detectLang(
  env: Record<string, string | undefined>,
  settings: Settings,
): Lang {
  // 1. $PI_LANG
  const piLang = env.PI_LANG;
  if (piLang === "en" || piLang === "zh") return piLang;

  // 2. settings.lang
  const settingsLang = settings.lang;
  if (settingsLang === "en" || settingsLang === "zh") return settingsLang;

  // 3. $LANG first 2 chars
  const lang = env.LANG;
  if (lang) {
    const prefix = lang.slice(0, 2).toLowerCase();
    if (prefix === "en") return "en";
    if (prefix === "zh") return "zh";
  }

  // 4. Fallback
  return "en";
}
