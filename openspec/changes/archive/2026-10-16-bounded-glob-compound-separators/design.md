## Implementation Decisions

### D1: Scope Enforcement

**Decision:** This change is strictly limited to fragment-level bounded-glob detection and command separator support.

**Rationale:**
- The three "other" prompt categories (heredoc, forwarding_command, control_flow) represent separate engineering efforts
- Including them would expand scope beyond the change's charter
- Each requires independent implementation work:
  - Heredoc: Need to parse heredoc content as commands recursively
  - Forwarding command: Need to analyze downstream command type after forwarder
  - Control flow: Need to analyze loop body and iteration patterns for static safety
- Keeping scope tight allows focused, testable implementation

### D2: Command Fragment Separators

**Decision:** Add `&` and `\n` to `splitCommands` as top-level command separators alongside existing `;`, `&&`, `||`.

**Rationale:**
- `&` (background operator) naturally separates commands like `sleep 5 & wc -l src/*.ts`
- `\n` (newline) separates commands in multi-line inputs like `echo hi\nwc -l src/*.ts`
- Both must be guards against false positives:
  - `&>` (stdout+stderr redirect) must NOT be treated as `&` separator
  - `N>&N` / `N>&-` (fd dup / close) must NOT be treated as `&` separator  
  - Quoted `\n` inside single/double quotes must NOT be treated as separator
  - `&>` variants like `cmd & > file` must NOT be mis-split

### D3: Fragment-Level Bounded-Glob Detection

**Decision:** Refactor `isBoundedGlobSafe` to iterate over command fragments (from `splitCommands`) and evaluate pipeline stages within each fragment independently.

**Rationale:**
- `isBoundedGlobSafe` currently operates on the whole command as if it were a single pipeline
- With `splitCommands` now producing multiple fragments (`cd && wc -l src/*.ts` → `["cd", "wc -l src/*.ts"]`), each fragment must be evaluated independently
- Fragment `cd` has no globs → passes trivially
- Fragment `wc -l src/*.ts` has bounded glob inside projectRoot with read-only command → passes

### D4: Existing Behavior Preservation

**Decision:** No changes to `scanUnreliable`, `scanControlFlow`, `scanShellForwarder`, `extractRedirects`, or other capabilities.

**Rationale:**
- heredoc classification remains unchanged (heredoc keyword still detected in `scanUnreliable`)
- forwarding_command classification remains unchanged
- control_flow classification remains unchanged
- Only `glob_expansion` behavior changes via fragment-level processing

### D5: Return Types Unchanged

**Decision:** `ExtractResult` type unchanged. `isBoundedGlobSafe` signature unchanged (`(cmd: string, projectRoot: string): boolean`).

**Rationale:** Maintains API compatibility with existing callers (`scanUnreliable`).

## Modified Code Structure

### `splitCommands` Enhancements

```typescript
function splitCommands(cmd: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: null | "'" | '"' = null;
  let escaped = false;
  let i = 0;
  
  while (i < cmd.length) {
    const ch = cmd[i];
    const next = i + 1 < cmd.length ? cmd[i + 1] : "";
    const prev = i > 0 ? cmd[i - 1] : "";
    
    // ... existing quote/escape handling ...
    
    // Existing separators
    if (cmd.startsWith("&&", i)) { ... }
    if (cmd.startsWith("||", i)) { ... }
    if (ch === ";") { ... }
    
    // NEW: & separator (background operator)
    if (ch === "&") {
      const isRedirGT = next === ">";     // &> 
      const isFdDup = /[0-9]/.test(prev); // N>&N / N>&-
      if (!isRedirGT && !isFdDup) {
        // Split here
      }
    }
    
    // NEW: \n separator
    if (ch === "\n") { ... }
  }
}
```

### `isBoundedGlobSafe` Refactoring

```typescript
export function isBoundedGlobSafe(cmd: string, projectRoot: string): boolean {
  const fragments = splitCommands(cmd);
  
  for (const fragment of fragments) {
    const stages = splitPipelines(fragment);
    const stageCmdNames = stages.map(getStageCommandName);
    
    for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
      // ... existing per-stage logic unchanged ...
    }
  }
  
  return true;
}
```

## Testing

### New Tests Added

1. **`BMG60: semicolon_separated_echo_then_bounded_glob_is_safe`** – `echo hi; wc -l src/*.ts` → RELIABLE
2. **`BMG61: ampersand_separated_echo_then_bounded_glob_is_safe`** – `sleep 5 & wc -l src/*.ts` → RELIABLE
3. **`BMG62: newline_separated_echo_then_bounded_glob_is_safe`** – `echo hi\nwc -l src/*.ts` → RELIABLE
4. **`BMG63: logical_and_separated_echo_then_bounded_glob_is_safe`** – `echo hi && wc -l src/*.ts` → RELIABLE
5. **`BMG64: logical_or_separated_echo_then_bounded_glob_is_safe`** – `false || wc -l src/*.ts` → RELIABLE
6. **`BMG65: semicolon_separated_write_glob_still_unreliable`** – `echo hi; rm -f /tmp/*.log` → UNRELIABLE: glob_expansion
7. **`BMG66: ampersand_redirect_not_split_as_background`** – `echo hi &> /tmp/log` → RELIABLE with write target `/tmp/log`
8. **`BMG67: fd_dup_not_split_as_background`** – `cmd 2>&1` → RELIABLE

### Regression Protection

All existing tests continue to pass:
- BT1-BT12 (basic extraction)
- BTP1-BTP22 (pipeline handling)
- BMG1-BMG59 (bounded glob, heredoc, forwarding, control flow, fd redirect)
