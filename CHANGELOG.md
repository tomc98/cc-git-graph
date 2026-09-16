# Changelog

## 0.1.4 — 2026-09-16 · Experimental pre-release

- Click the sticky lane range to choose Auto, All, or any positive whole-number maximum; apply with Enter or Apply, or discard with Cancel.
- Remember lane limits per repository, preserve history position, and grow the graph gutter beyond eight lanes as space allows.
- Keep the range control available when all lanes fit. Show a fit limit in narrow panes, retain paging arrows, and restore the requested count when the pane widens.

## 0.1.3 — Unreleased experimental candidate

- Lane controls inherit the pane background and normal text colour, removing the bright fill while clearing the history row underneath.
- Repaint once after pane geometry changes so the footer can settle without a scroll event. Cancel the pending repaint on close.

## 0.1.2 — Unreleased experimental candidate

- Keep lane controls fixed at the bottom of the graph viewport in docked and inline layouts.
- Reserve space after the final history row so the controls do not cover the oldest commit.

## 0.1.1 — Unreleased experimental candidate

- Automatically load history near the viewport, including visible unfinished connections.
- Preserve position and selection while appending each page; cancel queued reads when leaving history and pause automatic retries after errors.
- Keep shallow boundaries and the 5,000-commit cap explicit.

## 0.1.0 — Unreleased experimental candidate

- Native Git Graph launcher and panel inside a Claude Code conversation.
- Twelve-colour lanes, commit hashes and filled reference badges.
- Clickable history continuations load another page in place, with separate loading, shallow-boundary and history-limit labels.
- Session-path mappings to multiple repositories, with current-repository fallback.
- History, branch filtering, search, commit details, comparisons, working changes, tags and stashes.
- Explicit Git operation previews and confirmation; selected-context Ask Claude handoff.
- MIT licence, public installation and contributor documentation, reproducible checks and release packaging.

Initial target: macOS with native Claude Code 2.1.272 and function hooks enabled. See [known limitations](docs/COMPATIBILITY.md). No public release has been published yet.
