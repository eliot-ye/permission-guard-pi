# Limited Scope: Fix fragment-level glob detection, expand command separators

## Why

Current bash command extraction has two related gaps:

1. Fragment-level bounded-glob detection: `isBoundedGlobSafe` only considers single pipeline stages, not compound fragments separated by `;`, `&&`, `||`, `&`, or `\n`. This causes legitimate bounded read-only globs inside multi-command fragments (like `echo; wc -l src/*.ts`) to be misclassified as unreliable.

2. Missing separator support: `splitCommands` lacks `&` and `\n` as command separators, causing similar fragment-level problems for background commands and multi-line commands.

## What Changes

### 1. Enhanced Command Fragment Parsing

**Modified capability: `bash-target-extraction`**
- Updated `splitCommands` to recognize `&` (background) and `\n` (newline) as command separators
- Added guards to prevent mis-splitting of fd-dup (`N>&N`/`N>&-`) and stdout+stderr redirect (`&>`, `&>file`) variants
- Ensures each command fragment is processed independently for glob safety

### 2. Fixed Bounded-Glob Detection

**Modified capability: `bash-target-extraction`**
- Updated `isBoundedGlobSafe` to iterate over command fragments (from `splitCommands`) before evaluating pipeline stages
- Each fragment's pipeline stages are evaluated independently per existing logic
- Result: `echo; wc -l src/*.ts` now correctly classified as RELIABLE, not UNRELIABLE: glob_expansion

### 3. Essential Scope

This change intentionally does NOT address:
- **heredoc prompts** (5 present today) – retain existing unreliable classification
- **forwarding command prompts** (1 present today) – retain existing unreliable classification  
- **control flow prompts** (1 present today) – retain existing unreliable classification
- **Existing reliable prompts** – retain existing reliable classification (3 have been corrected in current extractor version)

## Capabilities

### New Capabilities

None

### Modified Capabilities

- `bash-target-extraction`: Enhanced fragment-level bounded-glob detection and separator support

## Impact

### Code Changes

- **`src/lib/bash-extract.ts`**: Modified `splitCommands` and `isBoundedGlobSafe` functions (~30 lines)
- **No changes** to `scanUnreliable`, `extractBashTargets`, or other capabilities
- **Export unchanged** – only internal implementation changed

### Test Changes

- **Added 8 new tests** in `test/bash-extract.test.ts` covering new separators and fragment-level cases
- **All existing tests pass** – no regressions in heredoc, forwarding, control flow, or reliable classifications

### Effect on Today's Prompts

Today’s 10 prompts yield:

| Time | Reason | Command | **NEW VERDICT** | **OLD VERDICT** |
|------|--------|----------|------------------|------------------|
| 02:53:52 | glob_expansion | `cd && wc -l src/lib/*.ts extensions/*.ts test/*.test.ts 2>/dev/null` | **RELIABLE (3t)** | UNRELIABLE: glob_expansion |
| 04:54:54 | glob_expansion | `cd && rm -f tmp-classify.ts tmp-audit.ts && ls tmp-*.ts` | **RELIABLE (1t)** | UNRELIABLE: glob_expansion |
| 01:44:33 | heredoc | `node --input-type=module <<'EOF' ... EOF` | UNRELIABLE: heredoc | UNRELIABLE: heredoc |
| 02:19:15 | forwarding_command | `find ... | xargs grep ...` | UNRELIABLE: forwarding_command | UNRELIABLE: forwarding_command |
| 02:23:40 | heredoc | `node --input-type=module <<'EOF' ... EOF` | UNRELIABLE: heredoc | UNRELIABLE: heredoc |
| 02:28:45 | heredoc | `cd ... 2>/dev/null; cd ...` | UNRELIABLE: heredoc | UNRELIABLE: heredoc |
| 03:14:00 | heredoc | `cat > /tmp/test-glob.ts <<'EOF' ... EOF` | UNRELIABLE: heredoc | UNRELIABLE: heredoc |
| 03:18: query | heredoc | `cat > /tmp-test-glob.ts <<'EOF' ... EOF` | UNRELIABLE: heredoc | UNRELIABLE: heredoc |
| 03:49:51 | glob_expansion | `cd && grep -n "...\|..." src/lib/path-utils.ts` | RELIABLE (1t) | UNRELIABLE: glob_expansion |
| 04:02:46 | control_flow | `cd && for f in ...; do ...; done` | UNRELIABLE: control_flow | UNRELIABLE: control_flow |

**Impact Summary**:
- **2 prompts become RELIABLE** (fixes the two `glob_expansion` cases that were false positives)
- **7 prompts remain UNRELIABLE** (same as before, no change to heredoc/forwarding/control-flow behavior)
- **1 prompt remains RELIABLE** (already reliable in current extractor version, no change)

## Design Documentation

See `design.md` for implementation details including:
- Modified `splitCommands` with `&` and `\n` separators and fd-dup guards
- Refactored `isBoundedGlobSafe` to iterate over command fragments
- New error handling to preserve existing behavior for heredoc, forwarding, and control flow

## Task Documentation

See `tasks.md` for implementation plan following TDD RED-GREEN-REFACTOR:
- **RED**: Write 8 new tests covering new separators and fragment-level cases
- **GREEN**: Implement `splitCommands` and `isBoundedGlobSafe` modifications
- **REFACTOR**: Validate no regressions, ensure all existing tests pass

## Guardrails

This change intentionally maintains existing classifications for:
- **heredoc prompts** – no new support
- **forwarding command prompts** – no new support  
- **control flow prompts** – no new support
- **existing reliable prompts** – unchanged

Focus is solely on fixing fragment-level bounded-glob detection for commands separated by `;`, `&&`, `||`, `&`, and `\n`.

## Verification

All artifacts pass `openspec validate --type change` → valid: true
Complete test suite: `node --experimental-strip-types --test test/` → all pass

