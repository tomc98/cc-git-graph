# GitHub and worktree reviews

Available in the local 0.2.0 experimental candidate. This version is not yet published to the public marketplace.

## Commands

```text
/gg
/gg https://github.com/owner/repository/pull/123
/gg https://github.com/owner/repository/pull/123/files
/gg https://github.com/owner/repository/commit/FULL_COMMIT_SHA
/gg https://github.com/owner/repository/compare/main...feature
/gg https://github.com/owner/repository/blob/COMMIT_SHA/src/example.ts#L10-L20
/gg https://github.com/owner/repository/tree/main/src
/gg worktree main
/gg uncommitted
/gg stack https://github.com/owner/repository/pull/123
/gg stack https://github.com/owner/repository/pull/121 https://github.com/owner/repository/pull/122
/gg close
```

`/gg` alone toggles the existing graph. `/git-graph` remains available. URL navigation opens a separate review view in the same pane. Graph, Commits and Files switch between the selected comparison's views. Selecting a file opens its patch; selecting a commit opens that commit's changes. Back returns through selected files and prior reviews. Review graphs reuse the colourful lanes and configurable sticky lane controls.

## Correct comparison scope

PR views resolve the current base and head IDs, find their merge base, and compare that merge base to the head. Files are read from those exact objects and paged in groups of 200. Remote review snapshots remain pinned until Refresh snapshot; opening GitHub may show a newer version of the PR.

`base...head` comparisons use the merge base. `base..head` compares the two tree tips directly. Commit views compare the commit against its first parent (or the empty tree for a root commit).

Local views have separate scopes:

- **Local branch:** merge base to local HEAD, including unpushed commits.
- **Uncommitted:** HEAD to tracked working files, plus separately listed untracked files. This is the net result of staged and unstaged work.
- **All local changes:** merge base to tracked working files, plus untracked files.

Local content is live, not an immutable snapshot. Refresh to re-read a changed worktree. Existing file-page fingerprints reject mixing pages when the changed-file list moves. This view does not execute repository code, checkout a branch or stage files.

A PR association is used when exactly one matching open PR is found; otherwise an explicit base or origin's recorded default branch is required. For forks, detached HEADs, ambiguous mappings or multiple worktrees, pass the intended local path and base through `graph_open`. Never assume a same-named branch proves it is the published PR.

## Ask Claude and model tools

Ask Claude previews the title, GitHub link, exact endpoints and selected file/preview lines before Send. PR overview requests include a bounded description and the currently loaded changed-file page, with partial content labelled. It does not silently attach the whole repository.

The bundled `review-with-git-graph` skill teaches these native tools:

- `graph_open`: display `target`, optionally narrowing `repository`, `view`, `file`, `lines`, local `mode` and `base`.
- `graph_selection`: inspect the current selection without changing it.
- `graph_read`: inspect a target or an existing `selectionId` without moving the UI. Page file lists with `offset` and `prefix`; read a file with `file` and page numbered preview lines with `offset`. Results identify partial previews and exact endpoints.

`lines` refers to numbered preview lines. In a file-content view these equal source-file lines; in a diff they include patch headers. Use the UI's line-range input and press Enter before Ask about lines.

Turn **Follow Claude off** to keep manual selection stable. Model navigation then produces a suggestion button rather than moving the panel. Model reads still work and never submit a second prompt.

## Back navigation

Back retraces the last eight review views, including tabs, selected files and commits. It restores the viewport, preview page, selected lines and graph lanes. Back to review closes Ask Claude and restores the underlying selection; Back to graph leaves the first review for the repository graph. During URL loading, Cancel loading keeps the previous selection and ignores late results.

## Repository resolution and caching

GitHub reads use `gh` and its existing authentication. Run `gh auth login` separately if needed. This release supports `github.com` HTTPS URLs, not GitHub Enterprise hosts.

Repository mappings, Git remotes and registered worktrees are checked for the requested objects. Missing objects are fetched at depth one into `cc-git-graph-cache/owner/repository.git` inside the Claude configuration directory. Existing user checkouts and branches are untouched. Fetching a selected commit includes the tree/blob data needed for its diff; this can still be large for large repositories.

The bare object cache is retained on disk for reuse. It has no automatic disk quota/eviction yet. Close review sessions before deleting that cache directory to reclaim space; subsequent reviews fetch the objects again. No credentials are copied into the cache.

Remote commit lists load 100 at a time, up to 5,000. Review navigation keeps eight prior views; model lookup retains six recent contexts. Expired IDs require resolving the target again. File previews are bounded and indicate incomplete content.

## Links and stacks

Open GitHub and Copy link preserve the PR/file or commit/file context. Commit file links use the resolved SHA. Uncommitted content has no exact GitHub equivalent; its link, if present, leads to the associated published PR. An unpushed commit link may not exist on GitHub yet.

Diff-file anchors resolve through at most 5,000 changed filenames. Review-comment links select the file and identify older-comment context. GitHub left/right diff-line anchors are not mapped to numbered patch preview lines; the UI explicitly says when it opened only the containing file.

One stack URL follows uniquely identifiable open parent PRs up to the selected tip (maximum 20). Multiple URLs specify base-to-tip order. Each edge must match the repository/base/head branch relationship, and the child must contain the current parent's head. Unrelated, ambiguous, cyclic or stale stacks are rejected. This does not integrate with Graphite metadata or discover arbitrary descendants of the selected PR.

## Dependencies and limits

The existing macOS/Python/Git and Claude function-hook requirements still apply. GitHub CLI authentication is required for remote metadata, even if Git objects exist locally. Offline local review works when the base is explicitly supplied or locally resolvable.

Large directory listings, binary/non-UTF-8 previews, removed fork objects and API rate limits can prevent a complete view; failures are surfaced instead of represented as an empty successful review. Claude still owns pane size and terminal focus.
