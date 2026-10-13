# Releasing

[Back to the README](../README.md)

### Publishing

The initial release can be published after `npm login`. Subsequent releases can use GitHub Actions trusted publishing with provenance (npm 11.5.1 or newer).

- `npm pack` (or `npm run pack`) builds and produces
  `matthew-cochran-junior-<version>.tgz`. `prepack` runs the build, so the tarball
  always contains fresh compiled output and never raw TypeScript.
- `npm run release` runs `npm publish --access public`; the release
  workflow invokes it, never `npm install`.

#### One-time setup

1. `npm login` locally as a maintainer of the `@matthew-cochran` scope and confirm
   with `npm whoami`.
2. On npmjs.com, open the package settings and add a **Trusted Publisher**:
   provider GitHub Actions, repository `matt-cochran/junior`, workflow
   `publish.yml`, environment blank. CI then authenticates with OIDC
   (`id-token: write`) and attaches provenance; no long-lived `NPM_TOKEN` secret
   is stored.
3. Bump `package.json` `version`, commit, then push a matching `vX.Y.Z` tag (or
   run the **Publish** workflow manually with `tag=vX.Y.Z`).

The workflow runs the packaged tests, fails if the tag does not match
`package.json`, skips a version that is already on the registry, and only then
publishes. It never publishes on an ordinary push or pull request.

