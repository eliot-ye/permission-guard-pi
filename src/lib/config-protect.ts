//
// Config self-protection predicates (policy-core, pure functions).
//
// Two protection layers, both path-based and evaluated in decideTarget():
//   - L1 isProtectedRuntimeState: the gate's own runtime-state files
//     (trusted.json / settings.json) are write-protected with deny_hard.
//   - L2 isConfigWritePath: the permission config files (permission.json
//     global / project / local) are write-protected with a tier=two prompt.
//
// Both normalize inputs with toAbsolutePath (expand ~, resolve ..) and
// toKeyPath (case-fold Windows drive paths) so that path-variant aliases
// cannot bypass the check.
//

import { toAbsolutePath, toKeyPath } from "./path-utils.ts";

/** Normalize a path for equality: expand ~, resolve . / .., fold case. */
function norm(p: string): string {
  return toKeyPath(toAbsolutePath(p, ""));
}

/**
 * L1: is `absPath` one of the gate's runtime-state files?
 * `trustedPath` and `settingsPath` are the absolute trusted.json / settings.json paths.
 */
export function isProtectedRuntimeState(
  absPath: string,
  trustedPath: string,
  settingsPath: string,
): boolean {
  const a = norm(absPath);
  return a === norm(trustedPath) || a === norm(settingsPath);
}

/**
 * L2: does `action` write/delete a permission.json config file?
 * `paths` is the array of { global, project, local } permission.json paths.
 */
export function isConfigWritePath(
  action: string,
  absPath: string,
  paths: readonly string[],
): boolean {
  if (action !== "write" && action !== "delete") return false;
  const a = norm(absPath);
  return paths.some((p) => a === norm(p));
}
