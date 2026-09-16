# Installation, updates and removal

## Requirements

- macOS and Claude Code **2.1.272**, the native build tested for this candidate.
- Function hooks enabled with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
- Git on PATH, `/usr/bin/python3` and `/usr/bin/pbcopy`.

The plugin uses an early-access API. Installation succeeding does not prove UI compatibility with another build. See [COMPATIBILITY.md](COMPATIBILITY.md).

## Permanent installation from a checkout

Run these in your shell, replacing the path:

```sh
claude plugin marketplace add /absolute/path/to/cc-git-graph --scope user
claude plugin install cc-git-graph@cc-git-graph --scope user
```

Merge this entry into the existing `env` object in `~/.claude/settings.json`. Preserve other settings:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Restart Claude. Click **Git Graph** above the composer, or run `/git-graph`. The graph starts closed. User scope applies across projects using that profile, subject to managed policy or project overrides.

For a custom profile, prefix **both install commands and launches** with `CLAUDE_CONFIG_DIR=/absolute/path/to/profile`, and enable the flag in that profile's `settings.json`. Installation in one profile does not install into other profiles.

Keep a locally registered marketplace checkout available. Claude caches installed plugins, so editing the checkout does not automatically replace an installed version.

## GitHub installation

Install the public marketplace from [tomc98/cc-git-graph](https://github.com/tomc98/cc-git-graph):

```sh
claude plugin marketplace add tomc98/cc-git-graph --scope user
claude plugin install cc-git-graph@cc-git-graph --scope user
```

The same function-hooks setting and restart apply. Add the Git repository, not the raw marketplace JSON URL: its plugin source is relative to the repository root.

## Session-only development loading

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /absolute/path/to/cc-git-graph
```

This does not permanently install the plugin. Avoid loading the same plugin through both an installed marketplace and `--plugin-dir` in one session.

## Update

For a local source, update the checkout to the intended release first. Then:

```sh
claude plugin marketplace update cc-git-graph
claude plugin update cc-git-graph@cc-git-graph --scope user
```

Restart Claude. Published releases must increment the plugin version so cached installations receive changes.

## Existing local-development installations

The packaged `dist/` marketplace retains its old name, `cc-git-graph-local`, for existing installations. Rebuild with `npm ci` and `npm run package`, then update that marketplace and plugin by their existing names:

```sh
claude plugin marketplace update cc-git-graph-local
claude plugin update cc-git-graph@cc-git-graph-local --scope user
```

To migrate to the public marketplace name, first uninstall `cc-git-graph@cc-git-graph-local` at user scope, then follow the checkout or GitHub installation above. Do not enable both copies. Your repository-map file is separate from plugin installation.

## Configuration

Use [the repository-map example](../examples/cc-git-graph.example.json) at `~/.claude/cc-git-graph.json`, or `cc-git-graph.json` inside your custom profile. Replace the sample paths, and merge rules if you already have a map. Reopen the graph or press Refresh after editing.

Branch filters, column preferences and lane limits are stored per checkout. Open state, active repository, patches and history are not persisted in that preference store.

## Removal

```sh
claude plugin uninstall cc-git-graph@cc-git-graph --scope user
claude plugin marketplace remove cc-git-graph --scope user
```

Use the same profile as installation. Remove `cc-git-graph.json` separately only if you no longer want the map. The hooks flag can remain if other mods use it.

## Troubleshooting

- **Installed but no button:** restart Claude; check the active profile, enabled plugin list and function-hooks flag. Check your build against the support matrix.
- **Graph hidden behind Diff:** close built-in Diff.
- **Wrong repository:** inspect the map path and default ID; press Refresh. An unmatched rule falls back to the conversation's current repository.
- **Typing reaches chat:** move focus into the intended input before typing.
- **No Git/Python:** check `git --version` and `/usr/bin/python3 --version` before launching.

The marketplace layout follows [Claude's marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces).
