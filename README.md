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
- Unconfigured outside project → silent reads, prompted writes; sensitive paths always prompt (and can never be persisted).

Prompts come in two tiers: **three-tier** offers "Always allow" (persists to `trusted.json`, project-scoped by hash), **two-tier** does not. Sensitive paths outside the project, and any bash construct the extractor can't statically reason about, use two-tier. Revoke a grant by editing `trusted.json`.

Bash commands are statically parsed to extract read/write targets; anything complex (subshells, heredocs, `bash -c`, interpreters, remote tools, unquoted globs outside the project) falls through to a two-tier prompt. Silent allow is a small whitelist of dev-tool commands (`git status`/`log`/`diff`, `npm test`, `cargo check`, `tsc --noEmit`, …).

> Full parser semantics, silent-command whitelist, and known blind spots: [`docs/security/permission-model.md`](./docs/security/permission-model.md).

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
