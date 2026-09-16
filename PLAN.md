# cc-git-graph — implementation plan

> Release note: this document describes the original milestones and full-product acceptance target. The experimental 0.1.0 candidate includes browsing, comparisons, explicit Git actions and Ask Claude; it is not the earlier read-only milestone or a completed 1.0. See [compatibility](docs/COMPATIBILITY.md) and [QA status](docs/QA.md) for current limits.

**Date:** 15 September 2026  
**Status:** implementation in progress; evidence tracked in [docs/QA.md](docs/QA.md) and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)  
**Specification:** [SPEC.md](SPEC.md)

## 1. Delivery approach

Build a real, interactive Claude mod first, then its Git browser, then operations. Validate the two riskiest host assumptions before investing in a full interface: the button/pane interaction and the write execution path. Pure graph logic and real Git fixtures follow once the host contract is known.

Use disposable repositories for development and native QA. Build/test scripts do not manage user profiles, shell configuration, the Claude executable or remote publication.

Completed task boxes describe implementation and its recorded checks. Phase exit evidence and the final acceptance matrix remain separate; checked source tasks do not imply a release is accepted.

### Milestones

| Milestone | Required phases | Meaning |
| --- | --- | --- |
| Host prototype | P0 | A real click opens/closes a real pane; host limitations recorded |
| Browsing release 0.1 | P0–P3 | Read-only history/details plus mapped repo buttons and current-repo fallback usable inside a conversation |
| Full local product | P0–P6 | Browser, comparisons, operations and explicit Claude handoff work |
| Validated release 1.0 | P7 plus all mandatory acceptance rows | Packaged, tested on a real terminal and accepted by the maintainer |

A passing unit suite does not imply a working terminal UI. A working prototype does not imply all Git actions work. A packaged plugin does not imply it is installed in either profile.

## 2. P0 — prove the Claude host integration

**Dependencies:** none. Work only in this project and disposable fixtures.

### Tasks

- [x] Record `claude --version`, installed Git version, macOS version, terminal, width/height and fullscreen setting in `docs/COMPATIBILITY.md`.
- [x] Scaffold only the plugin manifest, module declaration, a small registration module, generated types and minimal typecheck/test scripts.
- [x] Generate `/plugin-types` with the actual 2.1.272 runtime. Compare its header/contracts with the published tag; retain provenance and checksum.
- [x] Add a one-line native Git Graph button that composes with existing above-prompt content.
- [x] Implement `/git-graph` and a dummy pane with a selectable row, text input, selection control and Close button.
- [x] Verify real mouse clicks, keyboard activation and the same command while the model is streaming. Native PTY events and immediate commands ran during timestamped output; execution remained unavailable during a turn. See docs/COMPATIBILITY.md for timing and the synthetic-click limitation.
- [ ] Verify 80, 109, 110, 144 and 200-column layouts, resizing while open, a nonempty composer, focus return, surveys and built-in Diff coexistence.
- [ ] Verify `ui.close` and unload behavior; identify how to cancel timers and whether selected-pane visibility is observable.
- [x] Test a long list to determine host scroll offsets, row ownership, clipping, native selection and the feasible virtualization strategy. A 5,000-row native spacer probe reported 10,003 content rows and accepted a click on row 5,000; the product preserves the full loaded range. See docs/COMPATIBILITY.md.
- [x] Probe `Client` pointer/key events only in a small standalone graph region. Select native rows by default if Client adds complexity without a visible benefit. A four-row native probe received pointer down/up and Down-key events; retain native controls. See docs/COMPATIBILITY.md.
- [x] Measure read output limits and truncation behavior with disposable generated output, including truncation at a complete-record boundary. The native process result silently stops at 4 MiB even on a complete newline with exit zero; terminal markers are required.
- [ ] In a disposable Git repo, use a harmless local operation plus a marker hook to compare direct process execution and a person-triggered tool execution path. Verify host permission denial, hook execution, signing/editor needs and behavior during an active model turn.
- [x] Run plugin tests in the same user plugin tier used by real installation; do not rely only on a privileged built-in-tier test.

### Exit evidence

Save a concise QA record and screenshots of closed, docked, inline and input-focused states. Record exactly which APIs work on the tested build. A real button click must open the pane without sending a model prompt, and close must restore the draft and usable conversation layout.

Write execution is either verified with evidence or explicitly blocked. A failure here can allow browsing work to continue, but cannot be hidden under a later “full product complete” label. If the main button/split interaction itself fails, revise the spec before building the graph around it.

## 3. P1 — repository reads and fixtures

**Dependencies:** P0 read API and lifecycle verified.

### Tasks

- [x] Implement the small host adapter and typed read results/errors.
- [x] Implement repository discovery, worktree/common-directory identity and bare/unborn/shallow detection.
- [x] Read the optional active-profile `cc-git-graph.json`; implement its versioned schema, home-prefix expansion, directory-boundary matching, most-specific-map precedence and default-selection rules.
- [x] Resolve maps before requiring Git discovery in the session directory; support orchestration directories outside Git and sibling target repositories.
- [x] Add fixtures for missing/empty/unmatched/invalid maps, nested and overlapping paths, symlinks, duplicate entries, missing targets and default selection. Verify the checked-in repository-map example against the same parser.
- [x] Add bounded commands and parsers for refs, history IDs, metadata and porcelain status.
- [x] Freeze history roots to object IDs and implement stable 200-row pagination with a 5,000-row cap.
- [ ] Build ephemeral fixtures for linear history, a branch/merge, octopus merge, disconnected roots, detached HEAD, tags, renames, dirty/index states, stash, conflicts and linked worktrees.
- [ ] Add parser fixtures for spaces, tabs, newlines, Unicode, ANSI/control text, binary content, absent objects and oversized records.
- [x] Validate Git capability handling against the installed version; cover SHA-256 repositories when supported and skip explicitly when unavailable.
- [x] Add read concurrency limits, timeouts, generation checks and cache budgets.

### Exit evidence

Integration reads match Git's own object IDs, parent lists, status and worktree identities. Paging remains correct while a separate fixture process advances a ref. Slow results from one checkout never populate another. Reads neither change refs/index/worktree contents nor perform an unsolicited fetch.

Map fixtures produce the specified ordered choices without requiring the session directory to be a repo. Missing/empty/unmatched maps fall back to current-repo discovery. A similarly prefixed sibling does not accidentally match, and the most-specific map wins without merging broader entries.

## 4. P2 — graph layout and browsing panel

**Dependencies:** P1 repository model; P0 renderer/scroll decision.

### Tasks

- [x] Write the pure, deterministic lane/edge algorithm with boundary markers.
- [x] Cover first-parent continuity, merges, multiple simultaneous lanes and disconnected histories.
- [x] Maintain lane continuation across page boundaries and anchor selection/scroll by object ID.
- [x] Build terminal glyphs, colours, ref labels and a clear selected row. Twelve-colour cells and badges verified in native pane captures at 80/109/110/144/200 terminal columns.
- [x] Add branch filtering, visible search coverage, Load older, HEAD and Refresh controls.
- [ ] Render a directly clickable/keyboard-accessible button for each mapped repository, with configured labels/order and one visible active selection; use a compact wrapped/scrollable row where needed.
- [x] Implement session-context selection, default repo, current-repo fallback, config reload on open/Refresh, cwd rematching and stale-read rejection on switching. Load/poll history only for the selected repo.
- [ ] Implement layout-specific column reduction and lane overflow handling.
- [ ] Add keyboard navigation without consuming composer keys.
- [x] Implement open/close refresh lifecycle, debounced events and bounded polling while open.
- [x] Show loading, stale and unavailable states without blocking chat.

### Exit evidence

Every displayed edge corresponds to real ancestry or a visibly marked continuation; screenshots include merges and a page boundary. Opening/closing ten times produces no duplicate panes, listeners, timers or growing process count. Wide/narrow scrolling stays responsive with 5,000 loaded rows.

With the repository-map example, a session in Control presents **Monorepo** and **Control** buttons, initially viewing Monorepo. Switching preserves the conversation's cwd/draft and restores each repo's own view state. An unmatched session displays only its current repo, not a selection leaked from another context.

## 5. P3 — commit details, working state and file diffs

**Dependencies:** P2 selection/navigation.

### Tasks

- [x] Add commit metadata, parent navigation and lazy message loading.
- [x] Add changed-file lists, explicit merge-parent choice and root-commit handling.
- [x] Add staged/unstaged/untracked/conflict views with accurately named endpoints.
- [ ] Render unified diffs and binary/symlink/submodule states.
- [x] Enforce preview limits and prove that truncated output cannot look complete.
- [x] Add detail-to-graph Back navigation preserving selection and scroll.
- [x] Add explicit copy actions using a platform clipboard adapter.
- [x] Reconcile working-state changes made in a separate terminal without forcing the panel open.

### Exit evidence — browsing release 0.1

A user can open the graph, toggle mapped repositories, locate a commit, inspect a file diff and close it while keeping a draft in the composer. Current-repo fallback works without configuration. All browsing acceptance criteria pass. No Git mutation actions are exposed yet. The README calls this a browsing release and lists the remaining full-product work.

## 6. P4 — comparisons and additional repository selection

**Dependencies:** P3.

### Tasks

- [x] Implement Compare from/to with visibly labelled endpoints, swap and clear controls.
- [x] Add commit-to-working-tree comparison while showing untracked files separately.
- [x] Add the repository/linked-worktree picker and explicit-path addition alongside the already-working mapped repo buttons.
- [x] Support a session-context-only temporary pin; Follow conversation reapplies the map for the current cwd or current-repo fallback.
- [ ] Reset pending comparisons/actions on target changes; keep separate preferences per checkout.
- [x] Add bounded older-history search with visible coverage and result navigation.
- [x] Add stashes as a separate inspectable list with their own parent/diff semantics.

### Exit evidence

Comparing A to B matches Git's tree comparison in both directions. Selecting another linked worktree changes only the graph target; both the session cwd and the other checkout's files remain unchanged. An agent transcript switch never silently routes a Git action into an inferred directory.

## 7. P5 — implement deliberate Git operations

**Dependencies:** P0 write path verified; P4 checkout and selection model stable.

### Tasks

- [x] Implement action intent, target/effect preview, execution and reconciliation state.
- [x] Build argv from validated refs/IDs/paths; quote correctly where the verified tool path requires shell text.
- [x] Add local branch create/switch/rename/delete, including linked-worktree occupancy checks.
- [x] Add merge, noninteractive rebase, cherry-pick, revert and explicit reset modes.
- [ ] Add lightweight/annotated tag creation, inspection and deletion.
- [x] Add stash create/apply/pop/drop/branch, defending against stash-index movement.
- [x] Add selected tracked-change discard and selected untracked-file cleanup with affected-path preview.
- [x] Add fetch, explicit pull strategy, push and selected-tag push, plus remote configuration forms.
- [x] Revalidate expected HEAD/ref and prerequisites at submission; reject a stale form.
- [x] Preserve ordinary Git hooks, signing and host permissions; expose hook/auth/signing failures clearly.
- [x] Represent conflicts and provide explicit supported continue/abort paths.
- [x] Reconcile timeouts/uncertain outcomes without automatic retries.
- [x] Disable repeated submissions while an operation is running; closing a pane does not imply cancellation or rollback.
- [x] Prevent target switching during a mutation; on ordinary repo switches clear pending forms/comparison anchors so they cannot execute against the newly displayed repo.
- [x] Defer automatic target replacement after cwd/config changes until any running mutation is reconciled against its original checkout.

### Verification boundary

Use disposable repositories and a local bare repository as the remote for automated operation tests. Simulate push rejection and remote movement there. Use fixture marker hooks to prove hooks run. No test writes to the user's real project remotes or modifies an active work checkout.

### Exit evidence

Each action has an observed successful case and relevant failure/stale-state case. Destructive and remote changes require a deliberate action in the target/effect form. Merely clicking commits, opening menus, refreshing or asking for an explanation runs no mutation. Tests prove that a timeout is not retried as though nothing happened.

## 8. P6 — explicit Claude handoff and usability

**Dependencies:** P3 bounded context; P4 checkout identity.

### Tasks

- [x] Add Ask Claude with editable prompt, context preview and explicit Send.
- [x] Limit context size; report omitted/truncated content in the preview.
- [x] Verify destination semantics; support only the main conversation unless agent targeting is actually demonstrated.
- [ ] Show queued versus submitted outcomes accurately when a model turn is active.
- [ ] Complete keyboard-only navigation and colour-independent status cues.
- [ ] Refine compact/wide layouts, long names, row focus and concurrent Diff pane behavior.
- [x] Confirm no panel content enters the model's context through rendering, selection or a hidden hook.

### Exit evidence

A single Send produces exactly one intentional prompt in the named conversation. Cancel, open, select and close produce none. Keyboard-only users can open the graph, find a commit, inspect a diff and return to their draft.

## 9. P7 — harden, package and validate

**Dependencies:** P0–P6; all features planned for 1.0 present.

### Tasks

- [x] Run the targeted typecheck, mod contract tests, pure-layout/parser tests and real-Git fixture tests.
- [ ] Record performance results, fixture size and warm/cold conditions; investigate missed targets instead of rebranding targets as measurements.
- [ ] Run the terminal matrix and failure/recovery scenarios below.
- [ ] Verify plugin reload/unload and repeated open/close cleanup.
- [x] Audit runtime imports for unsupported Node/DOM APIs and review copied-code/dependency provenance. See docs/RUNTIME-AUDIT.md; static import checks also run before packaging.
- [x] Validate a clean path-based load from the documented project directory. Fresh packaged-path session opened mapped history, commit details and a native diff; see docs/INSTALL.md.
- [x] Document personal-profile installation/removal using commands verified on the current build. Commands tested in a disposable profile; actual personal installation is not performed.
- [ ] Verify `cc` starts normally with the main profile and does not gain this plugin through project-local autoload configuration.
- [ ] Perform a supervised walkthrough with the maintainer on a real terminal, initially browsing a checkout without mutating it.
- [ ] Record remaining limitations, supported versions and the user's acceptance separately from automated test status.

Release publication is a separate maintainer step after reviewing the candidate and its recorded limitations.

## 10. Acceptance matrix

Every mandatory row must pass with recorded evidence before calling 1.0 complete. Record outstanding failures explicitly and keep the release incomplete while any remain. Rows marked “0.1” are also required for the browsing release.

| ID | Required | Observable acceptance | Principal evidence |
| --- | --- | --- | --- |
| A01 | 0.1 | New session shows only the launcher; no periodic Git calls while closed | Process-call instrumentation + real terminal |
| A02 | 0.1 | Click toggles the pane, closes it cleanly and preserves draft/focus | Real mouse/keyboard walkthrough |
| A03 | 0.1 | Docked/inline behavior works at boundary widths without assuming 50/50 | 80/109/110/144/200-column captures |
| A04 | 0.1 | Graph edges, merges, disconnected roots and boundaries reflect actual parents | Pure-layout tests + fixture comparison |
| A05 | 0.1 | Paging under moving refs causes no duplicates, gaps or wrong selection | Real-Git concurrency fixture |
| A06 | 0.1 | Branch filters, loaded-search coverage and HEAD navigation are accurate | Mod tests + terminal walkthrough |
| A07 | 0.1 | Root/merge/staged/unstaged comparisons name the right endpoints | Git diff fixture oracle |
| A08 | 0.1 | Binary, unusual-path, shallow, unborn and missing-object cases are readable | Parser + integration fixtures |
| A09 | 0.1 | Huge/truncated results are explicitly incomplete, never a plausible full diff | Output-cap and parser tests |
| A10 | 0.1 | Close/reopen/resize/reload creates no duplicate work or stale update | Lifecycle tests + repeated live interactions |
| A11 | 0.1 | Streaming conversation, surveys and another pane remain usable | Real host walkthrough |
| A12 | 1.0 | Comparisons A→B and B→A match the selected tree endpoints | Integration tests |
| A13 | 1.0 | Repository selection is explicit and never changes the session cwd | Linked-worktree test + UI header |
| A14 | 1.0 | Each planned mutation changes only the displayed target after deliberate submission | Operation fixture suite |
| A15 | 1.0 | Hooks/signing/permissions are preserved, stale forms rejected | Marker hook and failure fixtures |
| A16 | 1.0 | Remote operations show exact destination and never auto-force or auto-retry | Local bare-remote tests |
| A17 | 1.0 | Conflicts, failed hooks, index locks and unknown outcomes are distinguished | Failure/recovery tests |
| A18 | 1.0 | Ask Claude sends exactly once to the named conversation after preview | Prompt-event assertions + real host |
| A19 | 1.0 | Keyboard-only workflow works; arbitrary display text cannot inject commands/control sequences | UI walkthrough + adversarial fixtures |
| A20 | 1.0 | Performance targets are measured; closed state remains idle | Benchmarks + process instrumentation |
| A21 | 1.0 | Personal install/unload is verified and does not rewrite launchers or main profile | Clean-load/unload inspection |
| A22 | 1.0 | The maintainer accepts the actual rendered workflow; no unimplemented mandatory feature is hidden | Recorded user acceptance and limitations |
| A23 | 0.1 | The example map presents Monorepo and Control as two direct buttons; default and label order match configuration | Config fixture + real terminal from orchestration directory |
| A24 | 0.1 | Missing/empty/unmatched maps use only the current repo; nested paths, similar prefixes and overlapping rules resolve as specified | Resolver fixtures + context-switch tests |
| A25 | 0.1 | Switching/config reload/cwd changes preserve correct per-repo data and never leak old results or global last-selection state | Delayed-read and config-change tests |
| A26 | 0.1 | Invalid/unavailable targets produce usable fallback; unselected mapped repos do not get background history scans | Failure fixtures + process instrumentation |

## 11. Test design

### Three independent kinds of verification

1. **Pure functions:** topology invariants, parsing and argument construction. Cover real edge cases rather than snapshots that simply reproduce implementation output.
2. **Host contract tests:** use `claude plugin test` with mocked process, clock and storage events to exercise buttons, pane lifecycle, bounded refresh, actions and prompt submission at the user-plugin tier.
3. **Real integration:** create disposable Git histories and local remotes, load the actual mod in Claude, and perform real clicks/keys. Fixture subprocesses live outside the hooks runtime where Node is available.

Compare graph ancestry against Git's actual object graph, and mutation outcomes against independently read refs/index/files. For display text sanitization, assert both safe rendering and preservation of the original filename used for reads. For preview limits, include a commit with an unusually large subject/message and a diff that exceeds host output capacity.

### Terminal walkthrough matrix

Baseline: the user's macOS terminal, fullscreen, both a short and a long conversation. Also exercise non-fullscreen and tmux inline behavior. Cover a new session, a resumed session, a nonempty prompt, an active response, agent transcript viewing, another open pane, a survey, terminal resizing and plugin unload. Desktop/mobile are recorded as unverified rather than inferred from shared type definitions.

### Representative scale fixtures

Small: 50 commits with two branches and merges. Medium: 10,000 commits with tens of refs and renamed files. Stress: 100,000 lightweight synthetic commits, hundreds of refs, wide ancestry, oversized metadata and a large changed-file list. Only a bounded snapshot is loaded; fixture creation time is not counted as UI performance. Benchmark outside active work repositories.

## 12. Decisions and open questions

### Decisions already made

- Terminal first; button above prompt; pane hidden on every new session.
- Original implementation with no copied Git Graph code/assets.
- Host-managed split; compact inline fallback; no forced ratio.
- No browser/daemon dependency and no automatic model calls.
- Explicit selected checkout; no guessed mapping from agent ID to worktree.
- Optional per-profile path maps supply ordered repository buttons in 0.1; unmapped contexts use the current repo. Control maps to Monorepo and Control in the example.
- Read-only first milestone, with full Git actions still required for 1.0.
- Shared Claude executable remains as configured by the user; plugin development does not manage CLI versions.

### Engineering questions resolved by P0

- Exact generated API for 2.1.272 and normal-plugin-tier capabilities.
- Renderer choice and scroll/virtualization mechanics.
- Selected-pane visibility and attainable polling behavior.
- Native Git write transport, hook preservation and active-turn behavior.
- Runtime output truncation and disposal semantics.

No preference question blocks starting P0. Later changes that materially alter the promised interaction or remove a mandatory capability should be reflected in SPEC.md and discussed with the maintainer before declaring the project complete.

## 13. First implementation instruction

Start with P0 only. Read SPEC.md, generate the live type contract, then build the smallest real launcher-and-pane prototype. Demonstrate an actual click, split layout, preserved draft and clean close before implementing history or Git mutations. Keep an evidence record so the rest of the project builds on observed runtime behavior.
