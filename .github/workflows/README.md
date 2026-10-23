# CI / Release workflows

Publishing is done via **npm Trusted Publishing** (OIDC), not `npm token`.
See [`publish.yml`](./publish.yml).

## One-time npm setup

Do this once, in a browser:

1. Enable 2FA on your npm account (`npm` → Settings → Authentication).
2. Go to https://www.npmjs.com/package/permission-guard-pi → **Settings → Trusted Publishing** (or **Publishing** tab, depending on the UI version) → **Add trusted publisher**.
   - GitHub owner: `eliot-ye`
   - Repository: `permission-guard-pi`
   - Workflow file: `publish.yml`

That's it. After this, the npm registry knows that a run of `.github/workflows/publish.yml` on this repo may publish the package.

No `NPM_TOKEN` secret is stored in repo settings. No OTP is entered during CI — the workflow exchanges a short-lived OIDC token with npm for a publish grant.

## How to publish a version

Local half (bump + tag + push):

```bash
npm version patch   # bumps package.json + package-lock.json, creates a commit AND a tag
git push --follow-tags
```

Or with `--no-git-tag-version` if you want to control tagging manually.

Remote half (run the workflow):

1. GitHub → Actions → `publish` → **Run workflow**.
2. Enter the tag you pushed (e.g. `v0.1.2`) and click Run.
3. Watch the run: it checks out that tag, installs deps, runs typecheck + tests, verifies the tag matches `package.json`'s version, then `npm publish --provenance`.

The workflow's "assert tag matches package.json version" step is the safety check — it fails fast if you try to publish a tag whose `package.json` version doesn't line up.

## What the workflow does

1. `actions/checkout` at the requested tag
2. `actions/setup-node` with Node 22 + npm registry
3. `npm ci`
4. `npm run typecheck`
5. `npm test`
6. Bash assertion: `${{ inputs.tag }} == v$(cat package.json | jq -r .version)`
7. `npm publish --provenance`

Steps 1–6 mirror the local release gate exactly, so a green CI run means the local gates would have passed.

## Not covered

- **Changelog generation.** There's no automated `CHANGELOG.md`. Add one if you want.
- **Automatic bump on push.** Deliberately manual — releases are gated by an intentional "Run workflow" click so you can review what's about to ship.
- **Auto-release on tag push.** Same reasoning. If you want it, remove `workflow_dispatch` and add `on: push: tags: ['v*']`, then drop the version-match assertion.
