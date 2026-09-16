# Runtime boundary

`hooks/register.tsx` and its local modules execute in Claude's function-hook runtime. Their only external imports are type-only declarations from `claude-code`. The host adapter supplies process execution, filesystem reads, environment reads, pane controls, timers, storage and explicit tool/prompt calls. The runtime imports no Node package, browser DOM library or third-party renderer.

`npm run audit:runtime` parses the hook source with TypeScript. It rejects external value imports, local imports escaping the hooks directory, CommonJS imports and direct dynamic module/code loading. This is a static import check, not a general sandbox.

The packaged Python helpers use the standard library. Git and Python are external executables; clipboard uses macOS `pbcopy`. Git authentication, hooks and signing can invoke user-configured programs during deliberately confirmed operations.

`npm run package` uses an explicit runtime file inventory and records each included file's size and SHA-256. Development declarations, node_modules, fixtures, logs and local profiles are excluded. `npm run audit:release` verifies the resulting package against the source and checks public source content.

See [source provenance](PROVENANCE.md) for licences and [QA](QA.md) for the limits of behavioural validation.
