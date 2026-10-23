# @permission-guard/pi

Layered, configurable file-access control for pi-coding-agent.

Instead of a one-size-fits-all "block everything sensitive" rule, this
extension lets you declare per-path permissions in JSONC config files and
enforce them across all pi tools (read / write / edit / bash) — with
persistent, project-scoped memory and an audit trail.

## Features

- **Three-tier permissions**: `read_write` / `read_only` / `unread`
- **Three config scopes**: global (~), project (repo), local (machine-specific)
- **Dual region**: automatic project-inner / project-outer classification
- **Two-tier memory**: session-level (per pi session) + persistent (survives restarts)
- **Default sensitive-path fallback**: SSH keys, `.env`, cloud creds, private keys
- **Cross-source conflict detection**: unread vs read_write prompts for confirmation
- **Bash target extraction**: parses `rm`, `mv`, `cp`, `cat`, redirections, `curl -o`, etc.
- **LLM prompt guardrails**: seeds bash-safety hints into the system prompt so the model reaches for `read`/`grep`/`find` first
- **JSONL audit log**: every permission decision is traceable
- **Zero runtime dependencies**: only `@earendil-works/pi-coding-agent` peerDep

## Install

```bash
pi install npm:@permission-guard/pi
```

Or from a local checkout:

```bash
pi install ./path/to/permission-guard-pi
```

## Upgrading from `@permission-system:pi-extension`

This package was renamed from `@permission-system:pi-extension`. Runtime
data now lives under a new path:

| Before | After |
|--------|-------|
| `~/.pi/agent/extensions/@permission-system:pi-extension/` | `~/.pi/agent/extensions/@permission-guard/pi/` |

Historical `trusted.json` and `logs/permission-review.jsonl` at the old
path are NOT migrated — remove them if you want a clean break, or copy
them over manually:

```bash
mv ~/.pi/agent/extensions/@permission-system:pi-extension ~/.pi/agent/extensions/@permission-guard/pi
```

Re-install after the rename:

```bash
pi remove @permission-system:pi-extension
pi install npm:@permission-guard/pi
```

## Configuration

Three JSONC config files are checked, in this order of precedence:

| Scope     | Location                                  | Priority |
|-----------|-------------------------------------------|----------|
| local     | `<projectRoot>/.pi/local/permission.json` | Highest  |
| project   | `<projectRoot>/.pi/permission.json`       | Medium   |
| global    | `~/.pi/agent/permission.json`             | Lowest   |

Missing files are treated as empty. Malformed files are ignored with a
warning at session start.

### Format

```jsonc
{
  "paths": {
    "<path-pattern>": "read_write" | "read_only" | "unread"
  }
}
```

### Path patterns

- **Absolute paths** (`/...`, `~/...`, `C:\...`): match exactly, or match
  a glob pattern if it contains `*`, `?`, or `[...]`.
- **Relative paths**: match only inside `<projectRoot>`. Supports `**` for
  any depth, `*` for a single segment, `?` for one char, and `[abc]` classes.

Example:

```jsonc
{
  "paths": {
    "~/.ssh": "read_write",                       // exact match
    "**/*.pem": "read_write",                     // project-scoped glob
    "/var/log/**/*.log": "read_only",             // absolute glob
    "src/secrets.txt": "unread"                   // hard deny
  }
}
```

## Permission semantics

| Permission | Read | Write | Delete | Notes |
|------------|------|-------|--------|-------|
| `read_write` (inner)   | auto-allow | auto-allow | auto-allow | Inside project, no prompt |
| `read_write` (outer)   | prompt | prompt   | prompt   | Three-tier prompt, can be persisted |
| `read_only`            | auto-allow | prompt | prompt   | Write/delete require approval |
| `unread`               | **deny** | **deny** | **deny** | Hard block, no prompt, not overrideable |
| *(unconfigured, inner, non-sensitive)* | auto-allow | auto-allow | auto-allow | Default, keeps pi's normal behavior |
| *(unconfigured, inner, sensitive)* | prompt | prompt | prompt | **Three-tier** (can persist) |
| *(unconfigured, outer, non-sensitive)* | auto-allow | prompt | prompt | Three-tier (can persist) |
| *(unconfigured, outer, sensitive)* | prompt | prompt | prompt | **Two-tier** (no "always allow") |
| *(default `/tmp/**`)* | auto-allow | auto-allow | auto-allow | Built-in scratch-dir default; sensitive files still prompt |

## Prompt tiers

When a prompt appears, it can be either **three-tier** or **two-tier**:

- **Three-tier**: Allow this call only / Allow for this session / **Always allow** / Deny
- **Two-tier**: Allow this call only / Allow for this session / Deny

Three-tier appears when:
- A config entry is declared (`read_write` on outer, or `read_only`/`unread` conflict)
- The action is on a non-sensitive unconfigured outer path (writing to `/Users/x/Downloads/`, etc.)

Default `/tmp/**` behavior:
- Ordinary, non-sensitive `/tmp/**` and `/private/tmp/**` reads/writes/deletes are auto-allowed without prompting.
- Sensitive files inside `/tmp` still prompt; explicit `read_only`/`unread` config still overrides the default.

Two-tier appears when:
- The path matches a built-in sensitive rule (SSH keys, `.env`, `.pem`, etc.) — we can't safely persist these
- A bash command can't be reliably parsed (command substitution `$(...)`, backtick, process substitution `<(...)`, heredocs, forwarders like `xargs` in non-first pipeline stages, unquoted globs, unresolved variables, etc.) — we can't predict what will run

"Always allow" persists to `~/.pi/agent/extensions/@permission-guard/pi/trusted.json`
under a key of `<projectHash>|<action>|<path>`. It's project-scoped, so
grants in one project never leak into another.

To revoke a grant, edit `trusted.json` and remove the entry.

## Sensitive path fallback

When a path is not declared in any config AND matches the built-in sensitive
list, the extension prompts. The prompt tier depends on region:

- **Inside project** (tier=three): "Always allow" is offered because the
  path is within your project scope. Declare an explicit config entry to
  override the fallback entirely.
- **Outside project** (tier=two): no "Always allow" — system-sensitive
  paths should not be silently persisted.

Sensitive paths:

- SSH keys (`id_rsa`, `id_ed25519`, etc.)
- Private keys (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.kdbx`)
- Env files (`.env`, `.env.*` but not `.env.example`)
- Credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`)
- Secret configs (`secrets.yaml`, `credentials`, `.npmrc`, `.netrc`)

To allow a specific sensitive path without per-call prompts, add an explicit
declaration to your config:

```jsonc
{
  "paths": {
    "~/.ssh": "read_write"  // Now no prompt for SSH key access.
  }
}
```

## Bash target extraction

For bash commands, the extension parses the command line to identify which
files will be read or written. The parser is quote-aware: characters inside
single quotes are literal, and inside double quotes `\$`, `\`` , `\"`, and `\\`
are literal but bare `$(...)` still executes (matching bash semantics).

**Pipeline handling**: pipelines (`|`) are split into independent stages and
extracted per-stage. `find /etc | sort | head` produces read target `/etc`.
Forwarders (`xargs`, `parallel`, `pforeach`) in non-first pipeline stages
remain unreliable because they consume stdin as arguments to downstream tools.

**Writes**: `rm`, `mv` (dest), `cp` (dest), `tee`, `install`, `chmod`, `chown`, `dd of=`, `curl -o`, `wget -O`, redirections (`>`, `>>`, `2>`)
**Reads**: `cat`, `head`, `tail`, `wc`, `grep`, `mv` (src), `cp` (src)
**Variables**: `$HOME` and `$PWD` are expanded (quote-aware). Other variables trigger a fallback prompt.

**Silent commands** (0 target, no prompt): development-tool commands whose
filesystem side effects are constrained to the project worktree. The
whitelist is a **command + allowed subcommand** pair — the command name
must match AND the invocation form must be read-only:

| Command | Allowed subcommands | Example (silent) | Example (prompts) |
|---|---|---|---|
| `git` | `status`, `log`, `diff`, `branch`, `tag`, `remote`, `config`, `rev-parse`, `rev-list`, `shortlog`, `blame`, `show`, `ls-files` | `git status`, `git log --oneline -n 10`, `git rev-list HEAD` | `git log /etc/passwd` |
| `npm` | `test`, `lint`, `audit` | `npm test` | `npm run build` |
| `yarn` | `test`, `lint`, `audit` | `yarn lint` | `yarn add <pkg>` |
| `pnpm` | `test`, `lint`, `audit` | `pnpm audit` | `pnpm dlx <pkg>` |
| `tsc` | *(none — flag-only)* | `tsc --noEmit` | `tsc <file>` |
| `cargo` | `check`, `metadata` | `cargo check` | `cargo run` |
| `go` | `version`, `env` | `go version` | `go run ./cmd/main.go` |
| `openspec` | *(any)* | `openspec status --change foo` | — |
| `make`, `npx`, `rg`, `jq` | *(none — moved out of the silent whitelist; always prompt)* | — | `make -f /tmp/x.mk`, `rg pattern /etc/shadow` |

**How a silent match is enforced**: if the leading command of a simple
single-command invocation is in the whitelist but the invocation form
doesn't match an allowed subcommand (e.g. `git log /etc/passwd` — `log`
is allowed but a path follows; `npm run build` — `run` isn't in npm's
allow-set), the command is classified as `unreliable_command` and
prompts rather than silently falling through as 0-target. For `git`,
revision references (`HEAD`, `main`, `HEAD~1`) are allowed after
subcommands like `log`/`diff`/`show`. Pipeline/compound/redirect
invocations (`git log | grep`, `git status && echo`, `git status 2>/dev/null`)
are evaluated per-stage by the extractor rather than by this rule.

**Commands moved out of the silent whitelist** (see below): `make`,
`npx`, `rg`, `jq` (and `cargo`'s non-check subcommands) all appear in
**Unreliable commands** now. They were historically silent, but they can
read/write outside the worktree — `make -f /tmp/x.mk` runs an arbitrary
makefile, `rg pattern /etc/shadow` reads outside the worktree, and
`npx <pkg>` runs an arbitrary package. They always prompt.

**Unreliable commands** (unconditionally prompts; tier=two with no
"Always allow"): commands that can execute arbitrary code, read/write
arbitrary files, or exfiltrate over the network. Command-name exact
match on any command fragment's first token (after `env` / `command`
wrapper prefixes) triggers this — `/usr/bin/sed` matches by basename,
`env FOO=1 sed -i …` catches the inner `sed`:

- **Script interpreters**: `sed`, `awk`, `perl`, `python`, `python2`,
  `python3`, `node`, `nodejs`, `ruby`, `php`, `lua`, `deno`, `bun`
- **System script executors**: `osascript`, `powershell`, `pwsh`
- **Network / remote tools**: `scp`, `sftp`, `rsync`, `ssh`, `telnet`,
  `nc`, `netcat`, `ncat`, `socat`
- **Container / cloud orchestration**: `kubectl`, `docker`, `podman`,
  `nerdctl`, `crictl`
- **Shell meta-commands**: `eval`, `exec`, `trap`
- **Formerly-silent with path/script arguments**: `rg`, `jq`, `make`,
  `cargo`, `npx` (moved out of the silent whitelist)

**Unreliable constructs** (always two-tier prompt with no "Always allow"):
- Command substitution `$(...)` and backtick `` `...` `` (outside single quotes)
- Process substitution `<(...)` / `>(...)`
- Heredocs `<<EOF`
- Forwarders (`xargs`, `parallel`, `pforeach`) in non-first pipeline stages
- Unquoted glob metacharacters (`*`, `?`, `[`) outside quotes
- Unresolved user variables (other than `$HOME`/`$PWD`)
- Control-flow keywords (`while`, `for`, `until`, `case`, `if`, `then`, `else`, `elif`, `fi`, `do`, `done`, `esac`, `in`) as standalone tokens outside quotes — loop variables and branch conditions make execution non-statically-determinable
- Shell forwarders (`bash -c`, `sh -c`, `dash -c`, `zsh -c`) **or** `bash` / `sh` / `dash` / `zsh` **with a script-path argument** (`bash /tmp/x.sh`, `bash -x /tmp/x.sh`) — the command to run is either a string or a file whose contents are invisible to static analysis (also catches `env KEY=VAL bash -c "..."` and option clusters like `-xc`)
- `source <path>` and `.` (dot-source) with a path argument — same as `bash <path>`
- Input redirection `<` (e.g. `bash < /tmp/x.sh`, `diff < /etc/passwd < /etc/hosts`) — extracted as a read target. Note: `bash < /tmp/x.sh` still triggers `shell_forwarder` because `bash` executes stdin contents.

Note: pipelines like `cat /etc/passwd | base64` are **not** unreliable —
they split into two stages, each parsed independently. The `cat` stage
contributes read target `/etc/passwd`; the `base64` stage contributes none
(base64 is not in the command table).

## Prompt guardrails

Complex bash commands that the extractor cannot parse always hit the
two-tier prompt with no "Always allow" option. That's the right safety
posture, but it's painful to hit repeatedly. Rather than rely on the LLM
to discover that after the fact, the extension seeds a short guardrail
list into the system prompt at `before_agent_start`.

The guardrails are organized in three layers — silent-first, so the LLM
reaches for a no-prompt path before falling back to bash constructs
that will prompt:

- **Layer 1 (decision layer)**: one sentence explaining that prompts
  interrupt the user, so the LLM should **Minimize prompts** — each one
  interrupts the user. This is the motivation — without it, the LLM
  only avoids pitfalls reactively.
- **Layer 2 (silent tool catalog)**: prefer `read`/`grep`/`find` and
  read-only forms of git/test/dev-tool commands. In-project read-only
  globs (`ls openspc/*`, `find . -name '*.ts'`, `cat src/a.ts`,
  `wc -l src/*.ts`, `git log src/`) are auto-allowed.
- **Layer 3 (popup pitfalls)**: constructs that always prompt, each
  with a `→` alternative — forwarders, command/heredoc substitution,
  control-flow keywords, unquoted globs outside project or in write/
  delete commands, shell forwarders, interpreters & remote tools,
  non-read-only dev-tool forms, and **Sensitive system paths** outside
  the project (`/etc`, `/usr`, `/System`, `~/.ssh`, `~/.aws`) which
  usually prompt or hard-deny.

**How it works**

- Injected via `systemPromptOptions.promptGuidelines` (a mutable array on
  the `before_agent_start` event), not via `systemPrompt`. This appends a
  delta instead of replacing the whole prompt, so pi's default tools list,
  skills, cwd, and any other extension's guidance all stay intact.
- Three-layer organization (silent-first): Layer 1 explains *why* to
  minimize prompts, Layer 2 lists the no-prompt options, Layer 3
  catches what's left. Positive guidance comes first so it wins the
  LLM's attention budget before the pitfall list.
- Idempotent: each bullet is deduped by exact-match string, so repeat
  dispatches in the same turn don't pile up.
- Non-destructive: pre-existing entries in `promptGuidelines` are
  preserved, so other extensions' rules survive alongside these.
- Fail-safe: the injection is wrapped in try/catch. A malformed event or
  a missing `systemPromptOptions` is silently ignored — guardrails never
  break the agent loop.

**Scope and limits**

- These are *soft* guardrails. They steer the model, they don't enforce
  anything. The bash extractor's hard rules still decide what runs.
- The bullets are hard-coded in `extensions/index.ts`. Edit the
  `BASH_GUARDRAILS` array there to customize.
- Layer 3's "Sensitive system paths" bullet is a reminder, not an
  enforcement — the actual sensitive-path list lives in
  `src/lib/sensitive.ts` and is unchanged by the guardrail text.
- The rules are always injected, for every session. If you want them off
  for a specific project, remove the `installPromptGuardrails(pi)` call
  from `registerPermissionGate`.

## Cross-source conflicts

If two config sources declare different permissions for the same path:

- **`read_only` vs `read_write`** (no unread): the local source wins
  silently. No prompt.
- **`unread` involved**: the extension prompts for confirmation on each
  access, marking the prompt as a "cross-source conflict".

## Audit log

Every permission decision is written to:

```
~/.pi/agent/extensions/@permission-guard/pi/logs/permission-review.jsonl
```

Each line is a JSON object:

```json
{
  "ts": "2026-10-12T10:00:00.000Z",
  "event": "allow_persistent",
  "tool": "write",
  "project": "a1b2c3d4e5f6",
  "projectRoot": "/Users/x/project",
  "path": "/opt/shared/secrets/x",
  "command": null,
  "region": "project_outer",
  "declaration": "read_write",
  "permission": "read_write",
  "toolCallId": "tc-123",
  "note": "saved to ~/.pi/agent/extensions/@permission-guard/pi/trusted.json"
}
```

`event` is one of: `allow_once`, `allow_session`, `allow_persistent`,
`deny`, `hard_deny`, `conflict_prompt`, `auto_allow`.

### Authorization provenance

Every audit record also carries two optional fields that tell you *who* made
the decision and *what rule / memory entry* fired. Consumers can filter on
either axis without parsing the free-form `note` field.

- `authorization`: `"by_person" | "presumed" | undefined`
- `grant_source`:
  `"config_declaration" | "allow_rule" | "grant_memory" | "bash_grant_memory" | "default" | undefined`

**event → authorization mapping** (deterministic, guaranteed by the implementation):

| event | authorization |
|---|---|
| `allow_once` | `by_person` |
| `allow_session` | `by_person` |
| `allow_persistent` | `by_person` |
| `deny` | `by_person` |
| `conflict_prompt` | `by_person` |
| `hard_deny` | `presumed` |
| `auto_allow` | from the decision (see below) |

`authorization` answers "was a human in the loop for this decision?".
`grant_source` answers "which rule / memory entry actually fired?" —
the fine-grained origin:

- `config_declaration` — a config rule (read_write / read_only) matched.
- `allow_rule` — a tool+pattern allow rule matched (non-sensitive target).
- `grant_memory` — a path-based grant-memory entry hit.
- `bash_grant_memory` — a bash-command grant-memory entry hit.
- `default` — region/sensitive/default fallback (no config, no rule).

**Backward compatibility.** Records written before this field existed
have neither `authorization` nor `grant_source`. Consumers MUST treat
their absence as `undefined` and fall back to `event` semantics for
compatibility — do not try to backfill fields into existing log lines.

## Uninstall

```bash
pi remove @permission-guard/pi
```

Your configs and `trusted.json` remain on disk. Delete them manually if
you want a full clean:

```bash
rm -rf ~/.pi/agent/extensions/@permission-guard/pi/
rm ~/.pi/agent/permission.json  # if you created one
```

## Development

```bash
git clone <this repo>
cd permission-guard-pi
npm install
npm test
```

Tests use the Node.js built-in test runner:

```
node --experimental-strip-types --test test/**/*.test.ts
```

## Contributing

Contributions are welcome. Please:

- Add tests before implementation (TDD)
- Keep the decision engine (`src/lib/decision.ts`) free of IO/UI dependencies
- Update the specs in `openspec/specs/` when adding behavior

## License

MIT. See [LICENSE](./LICENSE).
