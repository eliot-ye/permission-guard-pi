# CI / Release workflows

Publishing is done via **npm Trusted Publishing** (OIDC), not `npm token`.
See [`npm-publish.yml`](./npm-publish.yml).

## One-time npm setup

Do this once, in a browser:

1. Enable 2FA on your npm account (`npm` → Settings → Authentication).
2. Go to https://www.npmjs.com/package/permission-guard-pi → **Settings → Trusted Publishing** (or **Publishing** tab, depending on the UI version) → **Add trusted publisher**.
   - GitHub owner: `eliot-ye`
   - Repository: `permission-guard-pi`
   - Workflow file: `npm-publish.yml`

That's it. After this, the npm registry knows that a run of `.github/workflows/npm-publish.yml` on this repo may publish the package.

No `NPM_TOKEN` secret is stored in repo settings. No OTP is entered during CI — the workflow exchanges a short-lived OIDC token with npm for a publish grant.

## How to publish a version

```bash
npm version patch      # or minor / major — bumps package.json + package-lock.json, creates a commit AND a tag
git push --follow-tags # pushes both
```

Then on GitHub:

1. **Releases** → **Draft a new release** → select the tag you just pushed (e.g. `v0.1.2`).
2. Fill in the changelog for the release notes.
3. Click **Publish release**.

Publishing the release is what triggers the workflow — you don't click a separate "Run workflow" button.

## What the workflow does

1. `actions/checkout` at the release tag
2. `actions/setup-node` with Node 24 + npm registry (no package-manager cache)
3. `npm ci`
4. `npm run typecheck`
5. `npm test`
6. `npm publish --provenance`

Steps 1–5 mirror the local release gate exactly, so a green CI run means the local gates would have passed.

## Not covered

- **Changelog generation.** Manual. If you want it automated, add `release-please` or `semantic-release`.
- **Automatic publish on tag push.** Deliberately release-driven — the GitHub Release page doubles as the changelog, and publishing the release is the intentional "ship it" click.
- **Cross-platform builds.** This package is pure TypeScript loaded by pi at runtime via jiti — no build step needed.
