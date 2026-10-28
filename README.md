# permission-guard-pi

A permission gate for [pi-coding-agent](https://github.com/earendil-works/pi) that gates `read` / `write` / `edit` / `bash` calls behind a small, declarative config. Project-inner files are silent by default; sensitive paths (SSH keys, `.env`, private keys, credential stores) and cross-project writes prompt; hard blocks are declarative.

- JSONC config, three scopes (`global` / `project` / `local`)
- Session + persistent grants, project-scoped (`~/.pi/agent/extensions/permission-guard-pi/trusted.json`)
- Default sensitive-path fallback when nothing is declared
- JSONL audit log with provenance (`authorization` + `grant_source`)
- Zero runtime deps — one peer: `@earendil-works/pi-coding-agent`

## Install

```bash
pi install npm:permission-guard-pi
```

Local checkout: `pi install ./path/to/permission-guard-pi`.

## Quick start

Declare once:

```jsonc
// <projectRoot>/.pi/permission.json   (JSONC: comments + trailing commas OK)
{
  "paths": {
    "src/secrets.txt": "unread",      // hard deny, no prompt
    "**/*.pem":        "read_write",
    "vendor/**":       "read_only"
  }
}
```

Restart pi — you're done. Config locations and precedence:

| Scope    | Path                                        | Priority |
|----------|---------------------------------------------|----------|
| local    | `<projectRoot>/.pi/local/permission.json`   | highest  |
| project  | `<projectRoot>/.pi/permission.json`         | medium   |
| global   | `~/.pi/agent/permission.json`               | lowest   |

See `examples/global/permission.json`, `examples/project/.pi/permission.json`, `examples/project/.pi/local/permission.json` for annotated starting points.

## How decisions work

Each tool call resolves to `auto-allow`, `prompt`, or `deny`. Two axes drive the decision:

- **Region** — `project_inner` (inside `<projectRoot>`) vs `project_outer`.
- **Sensitive** — matches the built-in list in `src/lib/sensitive.ts` (SSH keys, `.env`, private keys, credential stores, `/etc/shadow`, cron files, …).

Rules in plain English:

- Explicit `read_write` → silent inside project, prompt outside.
- Explicit `read_only` → silent reads, prompted writes/deletes.
- Explicit `unread` → hard deny, never prompts.
- Unconfigured inside project → silent for non-sensitive paths, prompt for sensitive.
- Unconfigured outside project → silent reads, prompted writes; sensitive paths always prompt. **Hard** sensitive (non-revocable private keys, `~/.ssh/config`) can never be persisted; **soft** sensitive (revocable credential config, SSH public-key files) is persistable.

Prompts come in two tiers: **three-tier** offers "Always allow" (persists to `trusted.json`, project-scoped by hash), **two-tier** does not. Tier is decided by sensitivity level and region: **soft** sensitive paths (revocable credential config, SSH public-key files) and **hard** sensitive paths *inside* the project use three-tier (persistable); **hard** sensitive paths *outside* the project use two-tier (non-revocable, not persistable). **Unreliable bash commands** (heredocs, subshells, `bash -c`, unquoted globs outside the project, …) now use three-tier so "Always allow this command" can persist the raw command across sessions; revoke by editing `trusted.json.bashGrants`. Path grants are revoked by editing `trusted.json`.

Bash commands are statically parsed to extract read/write targets; anything complex falls through to a three-tier prompt with an "Always allow this command" option that persists the exact raw command. Silent allow is a small whitelist of dev-tool commands (`git status`/`log`/`diff`, `npm test`, `cargo check`, `tsc --noEmit`, …). Bash grants match on the **whitespace-normalized** command (`git  status` — double space — hits the same grant as `git status`); equivalence stops at lexical whitespace, so `bash -c "git status"` and `cd /tmp && git status` are **not** treated as the same grant.

When you declare a broad glob in `permission.json` (e.g. `{"~/.ssh/**": "read_write"}`) that unintentionally covers built-in sensitive paths, the extension emits a startup warning listing the covered paths and suggests narrowing the pattern. Exact paths and `unread` declarations never warn.

> Full parser semantics, silent-command whitelist, and known blind spots: [`docs/security/permission-model.md`](./docs/security/permission-model.md).

## Language / i18n

UI strings (dialog titles, choices, subtitles, notify messages) are localized. **Audit log `reason` and LLM prompts (`BASH_GUARDRAILS`) remain in English** — they are stable cross-version contracts, not UI.

### Selecting a language

Resolution order (first match wins):

1. `$PI_LANG` env var (`en` | `zh`)
2. `~/.pi/agent/extensions/permission-guard-pi/settings.json` → `{ "lang": "en" | "zh" }`
3. `$LANG` first two chars (`zh_CN.UTF-8` → `zh`; `en_US.UTF-8` → `en`)
4. Fallback: `"en"`

Create `~/.pi/agent/extensions/permission-guard-pi/settings.json` to set a per-user default (JSONC, so comments and trailing commas are fine):

```jsonc
// ~/.pi/agent/extensions/permission-guard-pi/settings.json
{
  "lang": "zh"
}
```

Or override per-session with the env var: `PI_LANG=zh pi`.

Language is resolved **once per pi session** (at `registerPermissionGate` startup) — changing `settings.json` requires a pi restart to take effect.

### Enable / disable the permission guard

The whole gate can be turned off (e.g., for a trusted session or debugging). Control it via settings.json or the `/permission` slash command:

```jsonc
// ~/.pi/agent/extensions/permission-guard-pi/settings.json
{
  "enabled": false
}
```

- `enabled` absent → **true** (fail-safe: gate stays active)
- `enabled: false` → gate disabled; `tool_call` returns `undefined` (pi handles tool calls natively, no intercept, **no audit log**)
- `/permission` — show current state + usage
- `/permission on` / `/permission off` — toggle and persist to `settings.json`

Changing `enabled` takes effect on the next tool call (unlike `lang`, which is read once at session start). Disabling the gate is an explicit user choice — the tool-call audit trail is suspended while disabled.

### Stability guarantees

- **ReasonCode** (`src/lib/reason-codes.ts`) is a stable contract: 13 decision + 7 sensitive + 15 bash codes, snake_case, no domain prefix. Codes don't get renamed once shipped; only new codes can be added.
- **Audit log `reason` field** stays in English regardless of UI language. This lets you `grep` and script against audit logs across versions.
- **`BASH_GUARDRAILS`** (the LLM-side prompt block) stays in English.

## Uninstall

```bash
pi remove permission-guard-pi
```

Configs and `trusted.json` stay on disk. Full clean:

```bash
rm -rf ~/.pi/agent/extensions/permission-guard-pi/
rm ~/.pi/agent/permission.json   # if you created one
```

## Development

Requires Node.js ≥ 22.18.

```bash
git clone <this repo>
cd permission-guard-pi
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test "test/*.test.ts" "extensions/*.test.ts"
```

Layout:

- `extensions/index.ts` — pi integration layer (session init, prompt flow, audit wiring)
- `src/lib/*.ts` — pure functions (config, decision, bash extraction, sensitive matching, trust, audit)
- `test/` — Node.js built-in test runner
- `openspec/specs/` — per-subsystem specs
- `docs/security/permission-model.md` — security boundary contract

## Contributing

- TDD: add the failing test first, then the implementation.
- Keep `src/lib/decision.ts` free of IO/UI — it's the only piece that should be trivially testable in isolation.
- Update `openspec/specs/` whenever you add or change behavior.

MIT. See [LICENSE](./LICENSE).
