import { queuedHost, type ReadHost } from './host.ts';
import { canonicalPath } from './config/paths.ts';
import { resolveRepositoryContext, type RepositoryContext } from './config/repository-maps.ts';
import { discoverRepository, type Repository } from './git/repository.ts';
import { createGitReader, type GitReader } from './git/read.ts';
import { nextPage, readRefs, startSnapshot, type HistorySnapshot, type Ref } from './git/history.ts';
import { readStatus, type WorkingFile } from './git/status.ts';
import { layout, type GraphRow } from './graph/layout.ts';
import { endpoints, readCommit, readPatch, type CommitDetail, type Comparison, type DiffEndpoints, type ChangedFile, type PatchPreview } from './git/details.ts';
import { normalizePath } from './config/paths.ts';
import { readWorktrees, type Worktree } from './git/worktrees.ts';
import { actionOptions, actionState, executeAction, prepareAction, type ActionId, type ActionIntent, type ActionOptions, type ActionOutcome, type ActionValues, type WriteResult } from './git/operations.ts';
import { filePreview } from './git/file-preview.ts';
import { readStashes, type Stash } from './git/stashes.ts';
import { readRemotes, type Remote } from './git/remotes.ts';
import { complete } from './git/read.ts';
import { createHandoff, sendHandoff, type HandoffForm, type PromptReceipt } from './handoff.ts';
import { DetailCache } from './cache.ts';
import { Preferences, type Columns, type LaneLimit } from './config/preferences.ts';
import { readTag, type TagDetail } from './git/tags.ts';
import { readFilePage, type FileCursor, type FilePage } from './git/files.ts';

export interface PanelHost extends ReadHost {
  root: string;
  cwd(): Promise<string>;
  home(): Promise<string | undefined>;
  configDirectory(): Promise<string | undefined>;
  open(): Promise<void>;
  close(): Promise<void>;
  redraw(): void;
  after(ms: number, fn: () => void): { cancel(): void };
  write?(command: string, description: string): Promise<WriteResult>;
  taskOutput?(id: string): Promise<WriteResult>;
  submitPrompt?(text: string): Promise<PromptReceipt>;
  readPreferences?(): Promise<unknown>;
  writePreferences?(value: unknown): Promise<void>;
  scrollStart?(): Promise<void>;
}

export interface ActionForm {
  repository: Repository; id: ActionId; values: ActionValues; target?: string; paths: string[];
  optionPages?: Record<string, number>;
  optionsLoading?: boolean; options?: ActionOptions; intent?: ActionIntent; outcome?: ActionOutcome; error?: string;
  stage: 'editing' | 'preparing' | 'ready' | 'running' | 'result'; revision: number;
}

export interface RepositoryView {
  repository: Repository;
  snapshot?: HistorySnapshot;
  graph: GraphRow[];
  working: WorkingFile[];
  selected?: string;
  offset: number;
  query: string;
  filter: string;
  columns: Columns;
  loading: boolean;
  error?: string;
  newHistory: boolean;
  refreshError?: string;
  laneOffset: number;
  laneLimit?: LaneLimit;
  branchPage?: number;
}

export class PanelController {
  historyRevision = 0;
  opened = false;
  private closing = false;
  context?: RepositoryContext;
  error?: string;
  resolving = false;
  isWorking = false;
  mainView = true;
  handoff?: HandoffForm;
  action?: ActionForm;
  workingView = false;
  collection?: { kind: 'stashes' | 'remotes' | 'tags'; stashes: Stash[]; remotes: Remote[]; tags: Ref[]; tag?: TagDetail; tagOffset?: number; tagRequest?: Ref; loading: boolean; error?: string };
  comparisonFrom?: string;
  picker?: { input: string; worktrees: Worktree[]; loading: boolean; error?: string };
  pin?: { contextKey: string; repository: Repository };
  searchingOlder = false;
  searchCoverage?: string;
  detail?: { refPage?: number; parentPage?: number; commit?: CommitDetail; comparison: Comparison | { kind: 'untracked'; path: string }; endpoints?: DiffEndpoints; files: ChangedFile[]; page?: FilePage; cursors?: FileCursor[]; loading: boolean; offset: number; error?: string; patch?: PatchPreview; file?: ChangedFile; patchOffset: number; showMessage?: boolean; stash?: Stash };
  readonly views = new Map<string, RepositoryView>();
  readonly details = new DetailCache();
  readonly preferences: Preferences;
  preferenceError?: string;
  readonly host: PanelHost;
  readonly read: GitReader;
  private generation = 0;
  private timer?: { cancel(): void };
  private debounce?: { cancel(): void };
  private failures = 0;
  private polling = false;
  private detailGeneration = 0;
  private actionSequence = 0;
  private searchSequence = 0;
  private tagSequence = 0;
  private pathSequence = 0;
  private openSequence = 0;
  private deferredRefresh = false;
  private historyPrefetch?: { cancel(): void; view: RepositoryView; snapshot: HistorySnapshot; generation: number; start: number; end: number };

  get mutating(): boolean { return this.action?.stage === 'running' || Boolean(this.action?.outcome?.backgroundTaskId); }

  constructor(host: PanelHost) {
    this.host = { ...host, ...queuedHost(host) };
    this.read = createGitReader(this.host, host.root);
    this.preferences = new Preferences(host.readPreferences, host.writePreferences);
  }

  get view(): RepositoryView | undefined {
    const repo = this.context?.choices.find(c => c.id === this.context?.selectedId)?.repository;
    return repo ? this.views.get(repo.identity) : undefined;
  }

  async open(): Promise<void> {
    if (this.opened || this.closing) return;
    this.opened = true;
    const request = ++this.openSequence;
    try { await this.host.open(); }
    catch (error) { if (request === this.openSequence) this.closed(); throw error; }
    if (request !== this.openSequence || !this.opened) return;
    this.host.redraw();
    void this.refresh().finally(() => this.schedule());
  }

  paneRendered(): void {
    if (this.opened || this.closing) return;
    // A hot reload can retain the host's pane while replacing this module's state.
    this.opened = true;
    void this.refresh().finally(() => this.schedule());
  }

  closed(): void {
    this.openSequence++;
    this.opened = false;
    this.generation++;
    this.detailGeneration++;
    this.resetOlderSearch();
    this.timer?.cancel(); this.timer = undefined;
    this.debounce?.cancel(); this.debounce = undefined;
    this.historyPrefetch?.cancel(); this.historyPrefetch = undefined;
    this.resolving = false;
    if (this.view) this.view.loading = false;
    this.host.redraw();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.closed();
    try { await this.host.close(); }
    finally { this.closing = false; }
  }

  private current(generation: number): boolean { return this.opened && generation === this.generation; }

  private ensureView(repo: Repository): RepositoryView {
    let view = this.views.get(repo.identity);
    if (!view) {
      view = { repository: repo, graph: [], working: [], offset: 0, query: '', ...this.preferences.get(repo.identity), loading: false, newHistory: false, laneOffset: 0 };
      this.views.set(repo.identity, view);
    }
    view.repository = repo;
    return view;
  }

  async refresh(preserveResult = false): Promise<void> {
    if (!this.opened) return;
    if (this.mutating) { this.deferredRefresh = true; return; }
    this.deferredRefresh = false;
    if (!preserveResult) this.action = undefined;
    if (this.handoff?.stage !== 'sending') this.handoff = undefined;
    const generation = ++this.generation;
    this.detail = undefined; this.detailGeneration++;
    this.picker = undefined; this.resetOlderSearch();
    this.workingView = false; this.collection = undefined;
    this.resolving = true; this.error = undefined; this.host.redraw();
    try {
      const [cwd, home, configDirectory] = await Promise.all([this.host.cwd(), this.host.home(), this.host.configDirectory(), this.preferences.load().catch(error => { this.preferenceError = `Saved display preferences unavailable. ${String(error)}`; })]);
      if (!home) throw new Error('Cannot find the home directory for repository configuration.');
      const configPath = (configDirectory || home + '/.claude') + '/cc-git-graph.json';
      let config: string | undefined;
      let configError: string | undefined;
      try { config = await this.host.exists(configPath) ? await this.host.read(configPath) : undefined; }
      catch (error) { configError = `Cannot read repository configuration; using the current repository. ${String(error)}`; }
      if (!this.current(generation)) return;
      const context = await resolveRepositoryContext({ config, cwd, home, previous: this.context }, {
        canonical: path => canonicalPath(this.host, path), discover: path => discoverRepository(this.host, path),
      });
      if (configError) context.diagnostics.push(configError);
      if (!this.current(generation)) return;
      if (this.pin?.contextKey !== context.key) this.pin = undefined;
      if (this.pin) {
        context.choices.push({ id: '__pinned__', label: 'Pinned repository', path: this.pin.repository.root, repository: this.pin.repository });
        context.selectedId = '__pinned__';
      }
      if (this.context?.key !== context.key || this.view?.repository.identity !== context.choices.find(c => c.id === context.selectedId)?.repository?.identity) this.comparisonFrom = undefined;
      this.context = context;
      const available = new Set(context.choices.flatMap(choice => choice.repository ? [choice.repository.identity] : []));
      for (const identity of this.views.keys()) {
        if (!available.has(identity)) this.views.delete(identity);
      }
      const repo = context.choices.find(c => c.id === context.selectedId)?.repository;
      this.resolving = false;
      if (repo) await this.load(this.ensureView(repo), generation);
    } catch (error) { if (this.current(generation)) this.error = String(error); }
    finally { if (this.current(generation)) { this.resolving = false; this.host.redraw(); } }
  }

  async switchRepository(id: string): Promise<void> {
    if (!this.opened || this.mutating || !this.context || id === this.context.selectedId) return;
    const repo = this.context.choices.find(c => c.id === id)?.repository;
    if (!repo) return;
    this.resetOlderSearch();
    this.action = undefined;
    this.handoff = undefined;
    this.workingView = false; this.collection = undefined;
    this.pin = undefined; this.picker = undefined; this.comparisonFrom = undefined;
    this.detail = undefined; this.detailGeneration++;
    if (this.view) this.view.loading = false;
    const generation = ++this.generation;
    this.context = { ...this.context, selectedId: id };
    this.resolving = false; this.error = undefined;
    const view = this.ensureView(repo);
    this.host.redraw();
    await this.load(view, generation);
  }

  private async load(view: RepositoryView, generation: number): Promise<void> {
    const previous = view.snapshot;
    const anchor = this.visibleCommits[view.offset]?.oid;
    view.loading = true; view.error = undefined; this.host.redraw();
    try {
      const [snapshot, working] = await Promise.all([
        (async () => {
          let snapshot = await startSnapshot(this.read, view.repository, view.filter || undefined);
          if (view.filter && !snapshot.refs.some(ref => ref.name === view.filter)) {
            view.filter = '';
            this.preferenceError = 'The saved branch filter no longer exists; showing all branches.';
            snapshot = await startSnapshot(this.read, view.repository);
          }
          const sameRoots = previous && JSON.stringify(snapshot.roots) === JSON.stringify(previous.roots);
          if (sameRoots) return { ...previous, refs: snapshot.refs, head: snapshot.head, branch: snapshot.branch };
          const targetCount = Math.max(200, previous?.commits.length ?? 0);
          while (this.current(generation) && snapshot.hasMore && snapshot.commits.length < targetCount) snapshot = await nextPage(this.read, view.repository, snapshot);
          return snapshot;
        })(),
        readStatus(this.read, view.repository),
      ]);
      if (!this.current(generation)) return;
      view.snapshot = snapshot; view.working = working; view.refreshError = undefined;
      if (snapshot.commits !== previous?.commits) view.graph = layout(snapshot.commits);
      if (!view.selected) view.selected = snapshot.head ?? snapshot.commits[0]?.oid;
      const commits = this.visibleCommits;
      const anchored = anchor ? commits.findIndex(commit => commit.oid === anchor) : -1;
      view.offset = anchored >= 0 ? anchored : Math.min(view.offset, Math.max(0, commits.length - 1));
      this.historyRevision++;
      view.newHistory = false;
    } catch (error) { if (this.current(generation)) view.error = String(error); }
    finally { if (this.current(generation)) { view.loading = false; this.host.redraw(); } }
  }

  async more(): Promise<void> {
    const view = this.view, generation = this.generation;
    if (!this.opened || !view?.snapshot || view.loading || !view.snapshot.hasMore) return;
    view.loading = true; view.error = undefined; this.host.redraw();
    try {
      const next = await nextPage(this.read, view.repository, view.snapshot);
      if (!this.current(generation)) return;
      view.snapshot = next; view.graph = layout(next.commits);
    } catch (error) { if (this.current(generation)) view.error = String(error); }
    finally { if (this.current(generation)) { view.loading = false; this.host.redraw(); } }
  }

  prefetchHistory(start: number, end: number): void {
    const view = this.view, snapshot = view?.snapshot, generation = this.generation;
    if (!view || !snapshot || !this.shouldPrefetchHistory(view, generation, start, end)) {
      this.historyPrefetch?.cancel(); this.historyPrefetch = undefined;
      return;
    }
    if (this.historyPrefetch?.view === view && this.historyPrefetch.snapshot === snapshot && this.historyPrefetch.generation === generation) {
      this.historyPrefetch.start = start; this.historyPrefetch.end = end;
      return;
    }
    this.historyPrefetch?.cancel();
    const pending = { view, snapshot, generation, start, end, cancel: () => {} };
    this.historyPrefetch = pending;
    const timer = this.host.after(50, () => {
      if (this.historyPrefetch !== pending) return;
      this.historyPrefetch = undefined;
      if (view.snapshot === snapshot && this.shouldPrefetchHistory(view, generation, pending.start, pending.end)) void this.more();
    });
    pending.cancel = () => timer.cancel();
  }

  private shouldPrefetchHistory(view: RepositoryView, generation: number, start: number, end: number): boolean {
    if (!this.current(generation) || this.view !== view || this.resolving || view.loading || view.error || view.query
      || !view.snapshot?.hasMore || view.snapshot.commits.length >= 5000 || start >= end
      || this.detail || this.action || this.picker || this.handoff || this.collection || this.workingView) return false;
    return end >= view.snapshot.commits.length || view.graph.slice(start, end).some((row, index) =>
      row.boundary.length > 0 && !view.snapshot!.commits[start + index]?.shallowBoundary);
  }

  async filter(value: string): Promise<void> {
    const view = this.view;
    if (!view || this.mutating) return;
    this.resetOlderSearch();
    view.filter = value; view.offset = 0; view.laneOffset = 0; view.snapshot = undefined;
    void this.savePreferences(view);
    await this.load(view, ++this.generation);
  }

  async columns(value: Columns): Promise<void> {
    if (!this.view) return;
    this.view.columns = value; this.host.redraw();
    await this.savePreferences(this.view);
  }

  async lanes(value: LaneLimit | undefined): Promise<void> {
    if (!this.view) return;
    this.view.laneLimit = value; this.host.redraw();
    await this.savePreferences(this.view);
  }

  private async savePreferences(view: RepositoryView): Promise<void> {
    try { await this.preferences.set(view.repository.identity, { filter: view.filter, columns: view.columns, ...(view.laneLimit === undefined ? {} : { laneLimit: view.laneLimit }) }); this.preferenceError = undefined; }
    catch (error) { this.preferenceError = `Display preference could not be saved. ${String(error)}`; }
    this.host.redraw();
  }

  search(value: string): void {
    if (this.view) {
      if (this.view.query !== value) this.resetOlderSearch();
      this.view.query = value; this.view.offset = 0; this.historyRevision++; this.host.redraw();
    }
  }

  get visibleCommits() {
    const view = this.view;
    if (!view?.snapshot) return [];
    const query = view.query.toLocaleLowerCase();
    return view.snapshot.commits.filter(commit => !query || [commit.oid, commit.subject, commit.author,
      ...view.snapshot!.refs.filter(ref => ref.commit === commit.oid).map(ref => ref.name)].some(text => text.toLocaleLowerCase().includes(query)));
  }

  scroll(by: number): void {
    if (this.detail) {
      if (this.detail.showMessage) this.detail.patchOffset = Math.max(0, Math.min((this.detail.commit?.message.split('\n').length ?? 1) - 1, this.detail.patchOffset + by));
      else if (this.detail.patch) this.detail.patchOffset = Math.max(0, Math.min(this.detail.patch.text.split('\n').length - 1, this.detail.patchOffset + by));
      else this.detail.offset = Math.max(0, Math.min(this.detail.files.length - 1, this.detail.offset + by));
      this.host.redraw(); return;
    }
    if (!this.view) return;
    this.view.offset = Math.max(0, Math.min(this.visibleCommits.length - 1, this.view.offset + by)); this.host.redraw();
  }

  historyScrolled(offset: number, contentRows: number, footerRows = 0): void {
    if (!this.view) return;
    const total = this.visibleCommits.length;
    const headerRows = Math.max(0, contentRows - total * 2 - footerRows);
    this.view.offset = Math.min(Math.max(0, total - 1), Math.max(0, Math.floor((offset - headerRows) / 2)));
  }

  async openPicker(): Promise<void> {
    if (this.mutating) return;
    const generation = this.generation, view = this.view;
    const picker = { input: '', worktrees: [] as Worktree[], loading: true, error: undefined as string | undefined };
    this.picker = picker; this.detail = undefined; this.host.redraw();
    try {
      const worktrees = view ? await readWorktrees(this.read, view.repository) : [];
      if (!this.current(generation) || this.picker !== picker) return;
      picker.worktrees = worktrees;
    } catch (error) { if (this.current(generation)) picker.error = String(error); }
    finally { picker.loading = false; if (this.current(generation)) this.host.redraw(); }
  }

  async choosePath(path: string): Promise<void> {
    if (!this.opened || this.mutating || !this.context) return;
    const generation = this.generation, picker = this.picker, request = ++this.pathSequence;
    const current = () => this.current(generation) && this.picker === picker && request === this.pathSequence;
    if (picker) { picker.loading = true; picker.error = undefined; this.host.redraw(); }
    try {
      const home = await this.host.home();
      if (!current()) return;
      const repo = await discoverRepository(this.host, normalizePath(path, home || '', false));
      if (!current()) return;
      this.pin = { contextKey: this.context.key, repository: repo };
      this.resetOlderSearch();
      this.context.choices = [...this.context.choices.filter(c => c.id !== '__pinned__'), { id: '__pinned__', label: 'Pinned repository', path: repo.root, repository: repo }];
      this.context.selectedId = '__pinned__';
      this.action = undefined;
      this.detail = undefined; this.picker = undefined; this.comparisonFrom = undefined; this.detailGeneration++;
      await this.load(this.ensureView(repo), ++this.generation);
    } catch (error) { if (current()) { if (picker) picker.error = String(error); else this.error = String(error); } }
    finally { if (picker && request === this.pathSequence) picker.loading = false; if (this.opened && request === this.pathSequence) this.host.redraw(); }
  }

  async followConversation(): Promise<void> {
    if (this.mutating) return;
    this.action = undefined;
    this.pin = undefined; this.context = undefined; this.picker = undefined; this.comparisonFrom = undefined;
    await this.refresh();
  }

  compareFrom(oid: string): void {
    this.comparisonFrom = oid; this.detail = undefined; this.detailGeneration++; this.host.redraw();
  }

  private resetOlderSearch(): void {
    this.searchSequence++; this.searchingOlder = false; this.searchCoverage = undefined;
  }

  stopOlderSearch(): void {
    const wasSearching = this.searchingOlder;
    this.resetOlderSearch();
    if (wasSearching) this.searchCoverage = 'Stopped. An in-flight page may finish; no further pages will be requested.';
    this.host.redraw();
  }

  async searchOlder(): Promise<void> {
    const view = this.view, generation = this.generation;
    if (!this.opened || !view?.query || this.searchingOlder || view.loading) return;
    const sequence = ++this.searchSequence;
    const active = () => this.current(generation) && sequence === this.searchSequence;
    this.searchingOlder = true; this.searchCoverage = undefined; this.host.redraw();
    const initial = view.snapshot?.commits.length ?? 0;
    try {
      for (let page = 0; page < 5 && active() && this.searchingOlder && view.snapshot?.hasMore; page++) {
        const before = view.snapshot.commits.length;
        await this.more();
        if (view.snapshot.commits.length === before || view.error) break;
      }
      if (active()) this.searchCoverage = `Searched ${(view.snapshot?.commits.length ?? 0) - initial} older commits; ${view.snapshot?.commits.length ?? 0} loaded, maximum 5,000.`;
    } finally { if (active()) { this.searchingOlder = false; this.host.redraw(); } }
  }

  async inspect(comparison: Comparison): Promise<void> {
    const view = this.view, generation = this.generation, detailGeneration = ++this.detailGeneration;
    if (!view || !this.opened || this.mutating) return;
    if (comparison.kind === 'commit') view.selected = comparison.oid;
    const detail: NonNullable<PanelController['detail']> = { comparison, files: [], loading: true, offset: 0, patchOffset: 0 };
    this.detail = detail; this.host.redraw(); void this.host.scrollStart?.();
    try {
      const commit = comparison.kind === 'commit' ? await this.details.read(JSON.stringify([view.repository.identity, 'commit', comparison.oid, view.repository.shallow]), () => readCommit(this.read, view.repository, comparison.oid)) : undefined;
      if (!this.current(generation) || detailGeneration !== this.detailGeneration) return;
      detail.commit = commit;
      const diff = await endpoints(this.read, view.repository, comparison, commit);
      if (!this.current(generation) || detailGeneration !== this.detailGeneration) return;
      detail.endpoints = diff;
      const page = await this.filePage(view.repository, diff, { offset: 0 });
      if (!this.current(generation) || detailGeneration !== this.detailGeneration) return;
      detail.commit = commit; detail.endpoints = diff; detail.files = page.files; detail.page = page; detail.cursors = [{ offset: 0 }];
    } catch (error) { if (this.current(generation) && detailGeneration === this.detailGeneration) detail.error = String(error); }
    finally { if (this.current(generation) && detailGeneration === this.detailGeneration) { detail.loading = false; this.host.redraw(); } }
  }

  private filePage(repo: Repository, diff: DiffEndpoints, cursor: FileCursor): Promise<FilePage> {
    return diff.immutable ? this.details.read(JSON.stringify([repo.identity, 'file-page', diff.args, cursor]), () => readFilePage(this.host, this.host.root, repo, diff, cursor)) : readFilePage(this.host, this.host.root, repo, diff, cursor);
  }

  async filePageDirection(direction: 'next' | 'previous'): Promise<void> {
    const view = this.view, detail = this.detail, generation = this.generation, detailGeneration = this.detailGeneration;
    if (!view || !detail?.page || !detail.endpoints || detail.loading || !this.opened) return;
    const cursors = detail.cursors ?? [{ offset: 0 }];
    if (direction === 'next' && !detail.page.hasMore || direction === 'previous' && cursors.length < 2) return;
    const nextCursors = direction === 'next' ? [...cursors, { offset: detail.page.nextOffset, prefix: detail.page.prefix }] : cursors.slice(0, -1);
    detail.loading = true; detail.error = undefined; this.host.redraw();
    try {
      const page = await this.filePage(view.repository, detail.endpoints, nextCursors.at(-1)!);
      if (!this.current(generation) || this.detail !== detail || detailGeneration !== this.detailGeneration) return;
      detail.page = page; detail.files = page.files; detail.cursors = nextCursors; detail.offset = 0;
      void this.host.scrollStart?.();
    } catch (error) { if (this.current(generation) && this.detail === detail && detailGeneration === this.detailGeneration) detail.error = String(error); }
    finally { if (this.current(generation) && this.detail === detail && detailGeneration === this.detailGeneration) { detail.loading = false; this.host.redraw(); } }
  }

  async inspectUntracked(path: string): Promise<void> {
    const view = this.view, generation = this.generation, detailGeneration = ++this.detailGeneration;
    if (!view || !this.opened || this.mutating) return;
    const detail: NonNullable<PanelController['detail']> = { comparison: { kind: 'untracked', path }, endpoints: { label: 'Untracked file · not part of a commit', args: [], immutable: false }, file: { status: '?', path }, files: [], loading: true, offset: 0, patchOffset: 0 };
    this.detail = detail; this.host.redraw(); void this.host.scrollStart?.();
    try {
      const patch = await filePreview(this.host, this.host.root, view.repository, path);
      if (this.current(generation) && detailGeneration === this.detailGeneration) detail.patch = patch;
    } catch (error) { if (this.current(generation) && detailGeneration === this.detailGeneration) detail.error = String(error); }
    finally { if (this.current(generation) && detailGeneration === this.detailGeneration) { detail.loading = false; this.host.redraw(); } }
  }

  async openCollection(kind: 'stashes' | 'remotes' | 'tags'): Promise<void> {
    const view = this.view, generation = this.generation;
    if (!view || !this.opened || this.mutating) return;
    const collection: NonNullable<PanelController['collection']> = { kind, stashes: [], remotes: [], tags: [], loading: true };
    this.collection = collection; this.workingView = false; this.detail = undefined; this.host.redraw(); void this.host.scrollStart?.();
    try {
      if (kind === 'stashes') collection.stashes = await readStashes(this.read, view.repository);
      else if (kind === 'remotes') collection.remotes = await readRemotes(this.read, view.repository);
      else collection.tags = (await readRefs(this.read, view.repository)).refs.filter(ref => ref.kind === 'tag');
    } catch (error) { if (this.current(generation)) collection.error = String(error); }
    finally { collection.loading = false; if (this.current(generation)) this.host.redraw(); }
  }

  backCollection(): void {
    const collection = this.collection;
    if (!collection) return;
    if (collection.tag || collection.tagRequest) {
      this.tagSequence++;
      collection.tag = undefined; collection.tagRequest = undefined;
      collection.tagOffset = 0; collection.error = undefined; collection.loading = false;
    } else this.collection = undefined;
    this.host.redraw(); void this.host.scrollStart?.();
  }

  async retryCollection(): Promise<void> {
    const collection = this.collection;
    if (!this.opened || !collection || collection.loading || this.mutating) return;
    if (collection.tagRequest) return this.inspectTag(collection.tagRequest);
    return this.openCollection(collection.kind);
  }

  async inspectTag(ref: Ref): Promise<void> {
    const view = this.view, collection = this.collection, generation = this.generation;
    if (!view || !collection || this.mutating || !this.opened) return;
    const request = ++this.tagSequence;
    collection.tagRequest = ref;
    collection.loading = true; collection.error = undefined; this.host.redraw();
    try {
      const tag = await this.details.read(JSON.stringify([view.repository.identity, 'tag', ref.name, ref.oid]), () => readTag(this.read, view.repository, ref));
      if (this.current(generation) && this.collection === collection && collection.tagRequest === ref && request === this.tagSequence) { collection.tag = tag; collection.tagOffset = 0; void this.host.scrollStart?.(); }
    } catch (error) { if (this.current(generation) && this.collection === collection && collection.tagRequest === ref && request === this.tagSequence) collection.error = String(error); }
    finally { if (this.current(generation) && this.collection === collection && collection.tagRequest === ref && request === this.tagSequence) { collection.loading = false; this.host.redraw(); } }
  }

  async inspectStash(stash: Stash): Promise<void> {
    const generation = this.generation;
    await this.inspect({ kind: 'commit', oid: stash.oid, parent: 0 });
    if (this.current(generation) && this.detail?.commit?.oid === stash.oid) { this.detail.stash = stash; this.host.redraw(); }
  }

  async inspectStashPart(part: 'index' | 'untracked'): Promise<void> {
    const view = this.view, detail = this.detail, generation = this.generation;
    if (!this.opened || this.mutating || !view || !detail?.stash || !detail.commit || detail.loading) return;
    const parents = detail.commit.parents;
    if (part === 'index' && parents[0] && parents[1]) await this.inspect({ kind: 'trees', from: parents[0], to: parents[1] });
    else if (part === 'untracked' && parents[2]) {
      const detailGeneration = ++this.detailGeneration;
      const current = () => this.current(generation) && this.detail === detail && detailGeneration === this.detailGeneration;
      detail.loading = true; detail.error = undefined; this.host.redraw();
      try {
        const empty = complete(await this.read(view.repository.root, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '' }), 'Read empty tree').trim();
        if (!current()) return;
        await this.inspect({ kind: 'trees', from: empty, to: parents[2] });
      } catch (error) {
        if (current()) detail.error = `Saved untracked comparison unavailable. Try Saved untracked again. ${String(error)}`;
      } finally {
        if (current()) { detail.loading = false; this.host.redraw(); }
      }
    }
  }

  async inspectWorkingFile(file: WorkingFile): Promise<void> {
    if (file.kind === 'untracked') return this.inspectUntracked(file.path);
    const generation = this.generation;
    const pending = this.inspect({ kind: file.kind === 'conflict' || file.index === '.' ? 'unstaged' : 'staged' });
    const detail = this.detail;
    await pending;
    if (!this.current(generation) || this.detail !== detail) return;
    const changed = detail?.files.find(changed => changed.path === file.path) ?? { status: file.kind === 'conflict' ? 'U' : file.index === '.' ? file.worktree : file.index, path: file.path, oldPath: file.oldPath };
    if (changed) await this.inspectFile(changed);
  }

  private async refreshMutableDetail(): Promise<void> {
    const view = this.view, detail = this.detail, generation = this.generation, detailGeneration = this.detailGeneration;
    if (!view || !detail?.endpoints || detail.endpoints.immutable || detail.loading) return;
    const current = () => this.current(generation) && this.detail === detail && this.detailGeneration === detailGeneration;
    try {
      if (detail.comparison.kind === 'untracked') {
        const patch = await filePreview(this.host, this.host.root, view.repository, detail.comparison.path);
        if (!current()) return;
        detail.patch = patch;
      } else {
        let page: FilePage;
        try { page = await this.filePage(view.repository, detail.endpoints, detail.cursors?.at(-1) ?? { offset: 0 }); }
        catch (error) {
          if (!String(error).includes('moved between pages')) throw error;
          page = await this.filePage(view.repository, detail.endpoints, { offset: 0 });
          if (current()) detail.cursors = [{ offset: 0 }];
        }
        if (!current()) return;
        const selected = detail.file;
        const patch = selected ? await readPatch(this.read, view.repository, detail.endpoints, selected) : undefined;
        if (!current()) return;
        detail.files = page.files; detail.page = page;
        detail.offset = Math.min(detail.offset, Math.max(0, page.files.length - 1));
        detail.patch = patch;
        if (detail.file && !patch?.text) {
          detail.file = undefined;
          detail.error = 'This file no longer has changes in the selected comparison.';
          return;
        }
        detail.file = selected;
      }
      detail.error = undefined;
      if (detail.patch) detail.patchOffset = Math.min(detail.patchOffset, Math.max(0, detail.patch.text.split('\n').length - 1));
    } catch (error) {
      if (current()) { detail.patch = undefined; detail.error = `Preview unavailable after refresh. ${String(error)}`; }
    }
  }

  async retryDetail(): Promise<void> {
    const detail = this.detail;
    if (!this.opened || !detail || detail.loading || this.mutating) return;
    if (detail.comparison.kind === 'untracked') return this.inspectUntracked(detail.comparison.path);
    if (detail.file && detail.endpoints) return this.inspectFile(detail.file);
    if (detail.stash) return this.inspectStash(detail.stash);
    return this.inspect(detail.comparison);
  }

  async inspectFile(file: ChangedFile): Promise<void> {
    const view = this.view, detail = this.detail, generation = this.generation, detailGeneration = ++this.detailGeneration;
    if (!this.opened || !view || !detail?.endpoints) return;
    detail.file = file; detail.patch = undefined; detail.patchOffset = 0; detail.loading = true; detail.error = undefined; this.host.redraw(); void this.host.scrollStart?.();
    try {
      const endpoints = detail.endpoints;
      const patch = endpoints.immutable ? await this.details.read(JSON.stringify([view.repository.identity, 'patch', endpoints.args, file]), () => readPatch(this.read, view.repository, endpoints, file)) : await readPatch(this.read, view.repository, endpoints, file);
      if (!this.current(generation) || detailGeneration !== this.detailGeneration) return;
      detail.patch = patch;
    } catch (error) { if (this.current(generation) && detailGeneration === this.detailGeneration) detail.error = String(error); }
    finally { if (this.current(generation) && detailGeneration === this.detailGeneration) { detail.loading = false; this.host.redraw(); } }
  }

  back(): void {
    this.detailGeneration++;
    if (this.detail?.showMessage) this.detail.showMessage = false;
    else if (this.detail?.comparison.kind === 'untracked') this.detail = undefined;
    else if (this.detail?.file) { this.detail.file = undefined; this.detail.patch = undefined; this.detail.loading = false; }
    else this.detail = undefined;
    if (!this.detail) this.historyRevision++;
    this.host.redraw(); if (this.detail) void this.host.scrollStart?.();
  }

  async copy(value: string): Promise<void> {
    const generation = this.generation, detailGeneration = this.detailGeneration, detail = this.detail;
    if (!this.opened) return;
    try {
      const result = await this.host.run(['/usr/bin/pbcopy'], { stdin: value, timeoutMs: 5000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Clipboard unavailable');
    } catch (error) {
      if (!this.current(generation) || detailGeneration !== this.detailGeneration || this.detail !== detail) return;
      if (detail) detail.error = String(error); else this.error = String(error);
      this.host.redraw();
    }
  }

  head(): void {
    const view = this.view;
    if (!view?.snapshot?.head) return;
    this.resetOlderSearch();
    view.query = '';
    const index = view.snapshot.commits.findIndex(c => c.oid === view.snapshot!.head);
    if (index < 0) view.error = 'HEAD is outside the loaded history or current branch filter. Clear the filter or load older history.';
    else { view.selected = view.snapshot.head; view.offset = index; this.historyRevision++; }
    this.host.redraw();
  }

  toolCompleted(): void {
    if (!this.opened) return;
    this.debounce?.cancel();
    this.debounce = this.host.after(500, () => { this.debounce = undefined; void this.poll(); });
  }

  private schedule(): void {
    this.timer?.cancel();
    if (this.opened) this.timer = this.host.after(Math.min(30000, 3000 * 2 ** this.failures), () => { this.timer = undefined; void this.poll().finally(() => this.schedule()); });
  }

  async poll(): Promise<void> {
    if (this.mutating) { this.deferredRefresh = true; return; }
    if (!this.opened || this.polling || this.resolving || this.view?.loading) return;
    this.polling = true;
    const generation = this.generation, view = this.view;
    try {
      const cwd = await this.host.cwd();
      if (!this.current(generation)) return;
      const canonical = await canonicalPath(this.host, cwd);
      if (!this.current(generation)) return;
      if (canonical !== this.context?.cwd) { await this.refresh(); return; }
      if (!view?.snapshot) return;
      const [refs, working] = await Promise.all([readRefs(this.read, view.repository), readStatus(this.read, view.repository)]);
      if (!this.current(generation)) return;
      view.newHistory = JSON.stringify(refs) !== JSON.stringify({ refs: view.snapshot.refs, head: view.snapshot.head, branch: view.snapshot.branch });
      view.working = working; view.refreshError = undefined; this.failures = 0;
      await this.refreshMutableDetail();
      if (this.current(generation)) this.host.redraw();
    } catch (error) { if (this.current(generation)) { this.failures = Math.min(4, this.failures + 1); if (view) view.refreshError = `Refresh failed; displayed data may be stale. ${String(error)}`; this.host.redraw(); } }
    finally { this.polling = false; }
  }

  async openActions(id: ActionId = 'branch-create', paths: string[] = [], presets: ActionValues = {}): Promise<void> {
    const view = this.view, generation = this.generation;
    if (!this.opened || !view || this.mutating) return;
    const target = this.detail?.commit?.oid ?? view.selected ?? view.snapshot?.head;
    const form: ActionForm = { repository: view.repository, id, values: { name: '', message: '', mode: 'soft', parent: '1', includeUntracked: 'no', strategy: 'ff-only', discardScope: 'worktree', remoteBranch: view.snapshot?.branch || 'main', branch: view.snapshot?.branch || '', ...presets }, target, paths, stage: 'editing', revision: 0, optionsLoading: true };
    this.action = form; this.picker = undefined; this.host.redraw();
    await this.loadActionOptions(form, generation);
  }

  async retryActionOptions(): Promise<void> {
    const form = this.action;
    if (!this.opened || !form || form.optionsLoading || this.mutating || form.stage !== 'editing') return;
    form.optionsLoading = true; form.error = undefined; this.host.redraw();
    await this.loadActionOptions(form, this.generation);
  }

  private async loadActionOptions(form: ActionForm, generation: number): Promise<void> {
    try {
      const options = await actionOptions(this.read, form.repository);
      if (!this.current(generation) || this.action !== form) return;
      form.options = options;
      form.values.branch ||= options.branches[0] || '';
      form.values.tag ||= options.tags[0] || ''; form.values.remote ||= options.remotes[0]?.name || ''; form.values.stash ||= options.stashes[0]?.oid || '';
    } catch (error) { if (this.current(generation) && this.action === form) form.error = String(error); }
    finally { form.optionsLoading = false; if (this.current(generation) && this.action === form) this.host.redraw(); }
  }

  editAction(key: string, value: string): void {
    const form = this.action;
    if (!form || this.mutating) return;
    if (key === 'action') form.id = value as ActionId; else form.values[key] = value;
    form.revision++; form.intent = undefined; form.outcome = undefined; form.error = undefined; form.stage = 'editing'; this.host.redraw();
  }

  async previewAction(): Promise<void> {
    const form = this.action, generation = this.generation;
    if (!form || !form.options || form.optionsLoading || this.mutating || form.stage === 'preparing' || !this.opened) return;
    const revision = form.revision;
    form.stage = 'preparing'; form.error = undefined; form.intent = undefined; this.host.redraw();
    try {
      const intent = await prepareAction(this.host, this.read, this.host.root, form.repository, form.id, { ...form.values }, form.target, form.paths, 'p' + (++this.actionSequence));
      if (!this.current(generation) || this.action !== form || revision !== form.revision) return;
      form.intent = intent; form.stage = 'ready';
    } catch (error) { if (this.current(generation) && this.action === form && revision === form.revision) { form.error = String(error); form.stage = 'editing'; } }
    finally { if (this.current(generation)) this.host.redraw(); }
  }

  async submitAction(): Promise<void> {
    const form = this.action;
    if (!this.opened || !form?.intent || form.stage !== 'ready' || this.mutating) return;
    if (this.isWorking) { form.error = 'Git actions are available when the current Claude turn finishes. Browsing remains available.'; this.host.redraw(); return; }
    if (!this.host.write) { form.error = 'The verified Git write transport is unavailable.'; this.host.redraw(); return; }
    if (this.view?.repository.identity !== form.repository.identity) { form.intent = undefined; form.stage = 'editing'; form.error = 'The displayed checkout changed. Preview again.'; this.host.redraw(); return; }
    form.stage = 'running'; form.error = undefined; this.host.redraw();
    const outcome = await executeAction(this.host, this.host.root, form.intent, this.host.write);
    form.outcome = outcome; form.stage = 'result'; this.host.redraw();
    if (this.opened && !outcome.backgroundTaskId) await this.refresh(true);
  }

  async reconcileAction(): Promise<void> {
    const form = this.action;
    if (!form?.intent || form.stage !== 'result') return;
    const taskId = form.outcome?.backgroundTaskId;
    if (taskId) {
      if (!this.host.taskOutput) { form.error = 'The existing background task must finish before repository switching can resume.'; this.host.redraw(); return; }
      try {
        const response = await this.host.taskOutput(taskId);
        const result = response.result as { retrieval_status?: string; task?: { status?: string; output?: string; exitCode?: number } } | undefined;
        if (!result?.task || !['completed', 'failed', 'killed'].includes(result.task.status ?? '')) {
          form.error = `Existing task ${taskId} is still running or its completion is not yet confirmed.`; this.host.redraw(); return;
        }
        // This callback returns an existing task result; it never reruns the Git command.
        const output = (result.task.output ?? response.text ?? '').replace(/\n\[exited with code -?\d+\]\s*$/, '').trimEnd();
        form.outcome = await executeAction(this.host, this.host.root, form.intent, async () => ({ text: output, isError: result.task!.exitCode !== 0 }));
      } catch (error) { form.error = String(error); this.host.redraw(); return; }
    } else {
      try { if (form.outcome) form.outcome.state = await actionState(this.host, this.host.root, form.repository, form.intent.scope, form.intent.paths); }
      catch (error) { form.error = String(error); this.host.redraw(); return; }
    }
    form.error = undefined; this.host.redraw();
    if (this.opened && !this.mutating && this.deferredRefresh) await this.refresh(true);
  }

  dismissAction(): void {
    if (this.mutating) return;
    this.action = undefined; this.host.redraw();
  }

  openHandoff(): void {
    const view = this.view, detail = this.detail;
    if (!this.opened || !view || !detail || detail.loading || !this.mainView || this.handoff?.stage === 'sending') return;
    this.handoff = createHandoff({ repository: view.repository.root, commit: detail.commit, comparison: detail.endpoints?.label, path: detail.file?.path, patch: detail.patch });
    this.host.redraw(); void this.host.scrollStart?.();
  }

  async submitHandoff(): Promise<void> {
    const form = this.handoff;
    if (!this.opened || !form || form.stage !== 'editing' || !this.mainView) return;
    if (!this.host.submitPrompt) { form.message = 'Prompt submission is unavailable in this host.'; this.host.redraw(); return; }
    const pending = sendHandoff(form, this.host.submitPrompt);
    this.host.redraw();
    await pending;
    this.host.redraw();
  }
}
