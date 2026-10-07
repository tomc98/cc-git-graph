# Validation status

The 0.1.0 candidate is experimental. Automated checks and selected native walkthroughs do not constitute completion of the full product acceptance matrix.

## Release-preparation checks — 16 September 2026

- 104 integration tests passed, including package exclusion, version drift, tampering and private-path rejection.
- 7 native Claude plugin tests passed on 2.1.272.
- Both upstream-contract and local host-generated typechecks passed.
- A clean public-source copy passed `npm ci` and the complete `npm run check` under Node 24.21.0 with global/system Git configuration excluded and no local generated declarations. All 104 integration tests passed again.
- Public and local marketplace manifests, and the packaged runtime, passed strict Claude validation.
- The public marketplace installed, listed and removed successfully in a disposable profile; selected installed runtime files and the licence matched the source.
- The GitHub Actions workflow passed actionlint. It has not run on GitHub yet.

These checks prepare a local candidate; they do not claim publication or complete UI acceptance.

### Progressive history continuation

The former passive continuation label now offers a native **Load more history** button. Each click appends one bounded page, retaining the current scroll offset and selection. Loading, shallow-clone boundaries, unavailable parents and the 5,000-commit limit have distinct non-clickable states.

After this change, both typechecks, 8 native plugin tests, 10 focused controller/Git integration tests and strict packaged-plugin validation passed. The new tests exercise actual native button dispatch, parent reconnection after paging, duplicate suppression, failed-read retry and retained position. A physical-terminal click walkthrough for this addition remains unrecorded.

## Automated coverage

- Strict TypeScript checks against a checksum-pinned upstream contract, plus local host-generated types when available.
- Real Git fixtures for repository maps, worktrees, snapshot paging, ancestry, refs, status, diffs, literal unusual paths, shallow/partial clones and bounded reads.
- Operation fixtures for branches, merge/rebase, cherry-pick/revert, tags, stash, discard, local bare remotes, conflicts, stale state, hooks, signing failures and index locks.
- Controller fixtures for cancellation, repository switching, duplicate prevention, reload/open/close ownership, background reconciliation, preference storage and explicit handoff.
- Graph and colour continuity, narrow/wide row budgets, Unicode clipping and runtime import boundaries.
- Native host tests for launcher composition, retained panes, rendered colours/buttons and handoff UI.
- Release metadata, source hygiene, package contents and hashes.

Run `npm run check` for the CI-equivalent checks and `npm run test:mod` for native host tests. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Native evidence already recorded

Dedicated disposable PTY sessions on Claude 2.1.272 exercised graph open/close, commit selection, mapped repository switching, colours at five widths, draft preservation, paged files/diffs, selected keyboard flows and selected confirmed Git operations. A prior disposable-profile installation was validated and removed. Built-in Diff interaction was tested and remains a documented limitation.

The detailed development transcript, raw captures and fixture paths remain in ignored local work files. They are not distributed as public documentation or represented as screenshots supplied by a user.

## Remaining acceptance work

- Physical-terminal walkthrough and supplied screenshots.
- Complete keyboard navigation and layout coverage across all subviews.
- Built-in Diff coexistence; non-fullscreen mouse support.
- Agent-transcript destination verification and queued handoff during streaming.
- Native background reconciliation and broader signing/editor/credential cases.
- Large-history frame-time and attributable memory measurements.

See [COMPATIBILITY.md](COMPATIBILITY.md) for the support matrix and [PLAN.md](../PLAN.md) for the full-product target.

### Automatic history loading — 0.1.1

History now prefetches one 200-commit page when an unfinished connection or the loaded tail is near the viewport. Subsequent renders continue loading while needed, without resetting the scroll position or selection. Off-screen restoration-only rows do not trigger prefetch; a pending position restoration uses its intended destination. Queued reads are cancelled or rejected after close, context changes, scrolling away, search or opening another graph view. Failed reads pause automatic loading and expose Retry. Shallow-clone history is not fetched from the network, and the existing 5,000-commit cap remains.

Validation: all 105 integration tests, 8 native plugin tests and both typechecks passed. The real-Git controller fixture covers successful automatic loading, deduplication, retry, close cancellation, leaving history, search and the cap. Native render tests verify automatic-loading labels and error-only retry controls. The packaged plugin passes strict host validation. A live terminal scroll walkthrough of this addition remains unrecorded.

### Fixed lane controls — 0.1.2

Lane controls now occupy a one-row bar at the bottom of the history viewport. The history keeps its native scrolling and reserves a blank final row so the oldest commit remains accessible above the bar. Scroll-anchor calculations exclude that extra row.

Verification: 9 native plugin tests, both typechecks, 3 focused controller/history-window integration tests, release audit and strict packaged-plugin validation passed. A dedicated native PTY session used a disposable 113-commit, 12-lane repository. At 80, 110 and 200 terminal columns, wheel scrolling reached the oldest commit, lane buttons remained fixed and clickable, changing lanes retained the oldest commit in view, and closing preserved the unsent composer draft. Captures and results are retained in ignored local `work/footer-proof/`. The first resize attempt overlapped a deliberate manifest hot reload; the recorded passing run used the settled plugin.

### Lane footer readability and first paint — 0.1.3

Both typechecks, 9 native tests and 3 focused controller/history-window integration tests passed. Native tests cover a single redraw after layout changes, no repeating redraw at stable geometry, cancellation on close and lane button clamping.

A dedicated Claude Code 2.1.272 PTY with colour enabled verified the footer inherits the dock's neutral background (ANSI colour 235), clears the underlying history, stays clickable at the oldest commit, and remains visible after resizing to 80, 110 and 200 columns. Initial opening and reopening displayed the footer within the first capture (~0.74 seconds, including input helper delays), without scroll input. The original delayed appearance was not reproduced; the added post-layout redraw addresses a possible geometry timing race and still needs user-session confirmation. Captures are under ignored `work/footer-proof/neutral-*.ansi`.

Moving the footer one row lower was tested and clipped it out of view. The blank row below is reserved by the host; the footer remains at the lowest exposed body row.

### Configurable lane counts — 0.1.4

Native Claude Code 2.1.272 testing on the disposable 12-lane fixture confirmed: clicking the range opens the footer editor; All shows 12 lanes; typing a count and Enter or Apply changes the count; zero is rejected; Cancel retains the previous value; Auto restores the default; and the oldest commit remains visible after changes. At 110 terminal columns, All shows the seven lanes that fit with a readable message area, explains the limit and supports paging. Widening back to 200 columns restores all 12 lanes. A fresh Claude process restored the saved custom count of 10. The fresh-process launch button needed a second click after startup settled; no prompt was submitted. Captures are under ignored `work/footer-proof/lanes-*.txt`.

Automated coverage includes valid/invalid lane input, counts above eight, width limits, old-preference migration, per-repository persistence and unchanged controller selection/history position. The host owns the outer split width; the plugin expands its graph gutter within that width, rather than resizing the conversation split.

### GitHub and worktree reviews — 0.2.0 local candidate

The complete check passed 118 integration tests, typechecking, packaging and the release audit. Eleven native plugin tests passed, including model selection reads and native review/Ask controls. The bundled review skill and strict plugin manifest validation passed.

A real Claude Code 2.1.272 terminal at 180×48 registered `/gg` and opened a public commit URL in the side pane. Physical terminal mouse events selected Files, opened its actual patch and opened the Ask Claude preview containing the file and exact comparison IDs. No model prompt was submitted in this walkthrough. A separate live read of public `cli/cli` PR #14462 fetched objects into a disposable bare cache, returned its two changed files and loaded a complete file diff. A live public commit read also reused the matching local checkout.

The first native launch exposed a skill/command name collision; renaming the bundled skill to `review-with-git-graph` fixed command registration, verified in a fresh terminal. Remaining limits are documented in REVIEWS.md: GitHub diff-line anchors, Enterprise hosts, arbitrary stack descendants/Graphite metadata and automatic disk-cache eviction. End-to-end autonomous model decision-making and every private/fork PR variant have not been manually exercised.

## Review Back navigation — 17 September 2026

The 0.2.1 local candidate passed TypeScript checks, 14 focused review integration tests, 11 native plugin tests, release audit and strict packaged-plugin validation. Regression coverage includes tab/file history, selected lines and preview pages, lane state, root return and cancelled asynchronous reads.

A real Claude Code 2.1.272 terminal walkthrough opened a public root commit, switched to its 94-file list, scrolled to offset 19, opened a file diff, and clicked Back. The file list returned to exactly offset 19 with the same top file. Native host logging confirmed the restored offset. Restoration uses a rendered keyed anchor because Claude skips a plugin's own scroll hook on re-entry.
