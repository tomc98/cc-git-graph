# Preparing a release

Current candidate: **0.1.4 experimental**. Public repository creation and publication are separate maintainer actions; the scripts here only prepare local files.

## Before publication

1. Confirm the release destination is [tomc98/cc-git-graph](https://github.com/tomc98/cc-git-graph), and keep repository/homepage metadata and installation commands in sync.
2. Review the README images under `docs/images/`. The current framed illustrations use fictional demo content adapted from supplied screenshots; keep that disclosure when updating them. Never add unredacted originals to the public source tree.
3. Run `npm ci` and `npm run check` on a clean copy. Run the native checks in CONTRIBUTING.md on the tested Claude build.
4. Review the public source and archive, particularly licences, compatibility limits and the changelog. Generated Claude declarations, `.claude/`, caches, fixtures and old development logs must remain ignored.
5. Record a physical-terminal smoke test: start closed, open, switch mapped repositories, inspect a commit/diff, close with a draft preserved. Record any exceptions without claiming full 1.0 acceptance.

## Versioning and packaging

Keep `package.json`, the root package entry in `package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `packaging/marketplace.json` on the same version. `audit:release` rejects drift. Bump the version for each distributed change so Claude invalidates its installed cache.

```sh
npm run check
npm run test:mod
npm run release:archive
```

The archive command audits the existing build, then produces `dist/cc-git-graph-0.1.4.tar.gz` and its `.sha256` file. The archive contains the self-contained plugin directory with its MIT licence and public user documentation. It contains no Claude executable, host declarations, tests, logs or node_modules. Build with `npm run package` first if source files changed.

There are two marketplace layouts:

- **Public source checkout:** `.claude-plugin/marketplace.json`, name `cc-git-graph`, source `./`. GitHub installs work from the source repository without committing `dist/`.
- **Local development package:** `dist/.claude-plugin/marketplace.json`, name `cc-git-graph-local`, source `./cc-git-graph`. This preserves existing local installations.

The runtime archive can also be extracted and loaded with `claude --plugin-dir /path/to/extracted/cc-git-graph`. It is a plugin archive, not a standalone marketplace.

## CI and publication

The GitHub Actions workflow runs on pull requests, pushes and manual dispatch, with read-only repository permissions. It typechecks, tests, packages, audits and uploads a candidate archive as a workflow artifact. It neither publishes a GitHub release nor uploads to npm. Native CLI checks remain local maintainer checks.

After approval to publish: create the public repository, push reviewed files, check the real CI result, then tag the approved version and attach the archive/checksum to its GitHub release. Mark the initial release experimental/pre-release. Do not describe a locally passing check as a completed GitHub CI run.

`private: true` intentionally remains in package.json: installation uses Claude's marketplace and does not need an npm publication.
