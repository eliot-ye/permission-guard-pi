// Bash extraction: barrel re-export.
// Preserves the original public API of src/lib/bash-extract.ts (18 export symbols).
// Pure module — no IO / no side effects.

export { tokenizeBashCommand, looksLikePathToken } from "./parse.ts";
export type { ExtractAction, ExtractResult } from "./parse.ts";
export { extractBashTargets } from "./entry.ts";
export { isDevSocketOrFd, isReadOnlyWithArgs, isFindReadOnly, isBoundedGlobSafe, READ_ONLY_COMMANDS, FIND_WRITE_FLAGS } from "./readonly.ts";
export { isForwarderStageSafe } from "./shell-forwarder.ts";
export { isSubstitutionReadOnlyAt, SUBSTITUTION_READONLY_CMDS } from "./scan.ts";
export { isSilentCommand, isAnyUnreliableCommand, SILENT_COMMANDS, UNRELIABLE_COMMANDS } from "./silent.ts";
