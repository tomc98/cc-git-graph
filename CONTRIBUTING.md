# Contributing

The first release candidate targets macOS and Claude Code's experimental function-hook API. Keep changes focused and include a reproducible example for behaviour changes.

## Setup and automated checks

Use the source checkout for these commands. Installed plugins and extracted runtime archives intentionally omit development scripts and dependencies.

Install Node 24+, Git and `/usr/bin/python3` on macOS, then run:

```sh
npm ci
npm run check
```

`check` downloads checksum-pinned upstream API declarations, typechecks, runs isolated Git integration fixtures, builds the plugin and audits release contents. The type download requires network access; it is a development dependency, never a runtime download. TypeScript is the only npm development dependency.

After the initial download, the individual offline checks are:

```sh
npm run typecheck:ci
npm run test:integration
npm run package
npm run audit:release
```

Fixtures use temporary repositories and local bare remotes. They do not need real repositories, GitHub credentials or an API key. Do not replace fixture paths with personal repositories.

## Native Claude checks

With the tested CLI installed:

```sh
npm run test:mod
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate --strict .claude-plugin/plugin.json
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate --strict dist/cc-git-graph
claude plugin validate --strict .claude-plugin/marketplace.json
claude plugin validate --strict dist/.claude-plugin/marketplace.json
```

For local typechecking against your actual host, launch Claude in this checkout with function hooks enabled, run `/plugin-types`, exit, then run `npm run typecheck`. Generated declarations stay under ignored `.claude/` and must not be committed.

For UI work, launch with `--plugin-dir` in a disposable repository and check both docked and inline layouts, a nonempty composer draft, keyboard focus, and close/reopen. Record your Claude version and terminal dimensions. Read [compatibility](docs/COMPATIBILITY.md) before interpreting a successful automated test as UI acceptance.

## Project layout

- `hooks/`: host adapter, controller, graph layout, Git operations and native UI.
- `scripts/*.py`: bounded reads using Git and the Python standard library.
- `integration/`: Node tests using real disposable Git repositories and controlled hosts.
- `tests/`: tests run by Claude's native plugin test runner.
- `examples/`: generic repository-map example.
- `docs/`: public installation, compatibility, validation and release guidance.

Do not add Node/DOM dependencies to the hook runtime. Preserve bounded reads, stale-result ownership checks, explicit Git previews and normal host permission handling.

## Pull requests

Explain the user-visible change and relevant checks. Add tests for new behaviour or a regression; avoid unrelated refactors. Keep paths, screenshots and logs free of credentials and private project content. Contributions to original project code use the [MIT licence](LICENSE); do not copy code or assets with incompatible redistribution terms.

GitHub CI runs the portable development checks on macOS. Native host tests remain a maintainer check because the tested Claude build must be available locally; CI does not claim to certify the terminal UI.
