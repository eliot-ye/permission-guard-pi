# Design: For-loop iteration-set glob bounded-safety

## Problem

`isBoundedGlobSafe` evaluates glob safety per stage. A for-loop iteration set
(`for d in openspec/specs/*/; do ...; done`) is a single fragment whose
"first command" is `for`. Since `for` is not in READ_ONLY_COMMANDS, the glob
in the iteration set is classified as unsafe, and `scanUnreliable` returns
`"glob_expansion"` before `scanControlFlow` (Change 2's for-loop exemption)
ever runs.

## Design decisions

### D1: Fix in `isBoundedGlobSafe`, not `scanUnreliable`

The glob safety check belongs in `isBoundedGlobSafe`. `scanUnreliable` calls
`isBoundedGlobSafe` when it encounters a glob metachar; the decision is
already delegated. Fixing `isBoundedGlobSafe` keeps the change localized and
avoids adding a parallel for-loop detection path in `scanUnreliable`.

### D2: Reuse `isForBodyReadOnly`

`isForBodyReadOnly` (added in Change 2) already checks whether a for-loop body
consists only of read-only commands (READ_ONLY_COMMANDS ∪ SILENT_COMMANDS ∪
HARMLESS_BUILTINS). It is currently a standalone function in bash-extract.ts.
No extraction or refactor needed — just call it from `isBoundedGlobSafe`.

### D3: Only apply when `stageCmd` is `for`

The existing `isBoundedGlobSafe` checks `READ_ONLY_COMMANDS.has(stageCmd)`.
When `stageCmd === "for"`, add a special path: parse the for-loop and check
the body. When `stageCmd` is anything else, behavior is unchanged.

### D4: Iteration-set glob prefix still needs `isBoundedPrefix`

The glob's prefix (e.g. `openspec/specs/`) must still resolve inside
projectRoot. This is the same check as for command-argument globs, already
implemented in `isBoundedPrefix`. No change needed here.

### D5: Reuse `isLiteralForLoop` to extract the body

`isLiteralForLoop` (Change 2) already parses `for VAR in WORDS; do BODY; done`
and returns `{ exempt, varName, doneEnd }`. We need the BODY string to pass to
`isForBodyReadOnly`. However, `isLiteralForLoop` returns `exempt: false` if
the iteration set contains a glob (which is exactly our case — the iteration
set has a glob that `isLiteralIterationWord` rejects).

So we cannot directly reuse `isLiteralForLoop`. Instead, we need a lighter
parser that extracts the body from `for ... in <anything>; do BODY; done`
without checking the iteration set for literals. Call this
`parseForBodyFragment(cmd, stageCmdStart)`.

### D6: Parse strategy

`isBoundedGlobSafe` currently iterates over characters within a stage, tracking
`tokenHasGlob` and `tokenGlobPrefix`. When it hits a glob and the stage's first
command is `for`, it needs to:

1. Find the `; do` after the `for VAR in` prefix
2. Find the matching `; done` at the end of the fragment
3. Extract the body text between `do` and `done`
4. Call `isForBodyReadOnly(body)`

This requires parsing from the `for` keyword position to the end of the
fragment. Since `isBoundedGlobSafe` already has `fragment` (the full
command fragment), and it has `stageIdx`/`stages` (the pipeline split), it
can locate the stage's start position within the fragment.

Simpler approach: pass the stage text to a helper that checks if it starts
with `for` and parses the body. The helper needs the stage string and a
callback/predicate for body-read-only.

### D7: Implementation sketch

```typescript
// In isBoundedGlobSafe, when stageCmd is "for" and we hit a glob:
if (stageCmd === "for") {
  const bodyResult = parseForBody(stage);
  if (bodyResult && !isForBodyReadOnly(bodyResult.body)) return false;
  // body is read-only; fall through to prefix check
}
```

`parseForBody(stage)` returns `{ body }` or `null` if the stage is not a
recognizable for-loop structure. It does NOT check iteration-set literals —
it only extracts the body text between `do` and `done`.

### D8: Error handling

If `parseForBody` fails to parse (malformed for-loop), return `false` (unsafe).
Conservative: if we can't tell, don't allow.

### D9: No new reason value

Same as Changes 1 and 2 — the fix only reduces `glob_expansion` false
positives. No new reason string.

## Code structure

```typescript
// In isBoundedGlobSafe:
// When we hit a glob and stageCmd is "for":
if (stageCmd === "for") {
  const bodyInfo = parseForBody(stage);
  if (!bodyInfo) return false;
  if (!isForBodyReadOnly(bodyInfo.body)) return false;
}

// Helper (new):
function parseForBody(stage: string): { body: string } | null {
  // stage starts with "for "
  // Find "; do" after "for VAR in"
  // Find matching "; done" at end
  // Return { body } or null
}
```

## Test plan

- BMG88: `for d in openspec/specs/*/; do ls "$d"; done` → reliable (glob in
  project, body read-only)
- BMG89: `for d in /etc/*/; do ls "$d"; done` → unreliable (glob outside
  project, `isBoundedPrefix` fails)
- BMG90: `for d in openspec/specs/*/; do rm "$d"; done` → unreliable (body
  is write, `isForBodyReadOnly` fails)
- BMG91: `for d in openspec/specs/*/; do cat "$d"; done` → reliable (body is
  read-only, `cat` is in READ_ONLY_COMMANDS)
- BMG92: `for d in openspec/specs/*/; do echo "$d"; done` → reliable (body is
  harmless, `echo` is in HARMLESS_BUILTINS)
