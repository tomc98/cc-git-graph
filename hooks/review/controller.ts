import { Preferences, type LaneLimit } from '../config/preferences.ts';
import type { LaneEditor } from '../ui/lane-footer.tsx';
import { layout } from '../graph/layout.ts';
import type { Commit } from '../git/history.ts';
import type { PanelHost } from '../controller.ts';
import { createHandoff, sendHandoff, type HandoffForm } from '../handoff.ts';
import { filePreview } from '../git/file-preview.ts';
import type { ChangedFile, PatchPreview } from '../git/details.ts';
import type { FilePage } from '../git/files.ts';
import { safePath } from './target.ts';
import { ReviewService, type ReviewContext, type OpenOptions } from './service.ts';

export type ReviewTab = 'graph' | 'commits' | 'files';
export interface ReviewView {
  context: ReviewContext; tab: ReviewTab; files?: FilePage; file?: ChangedFile; preview?: PatchPreview;
  offset: number; graphOffset: number; viewportOffset?: number; laneOffset?: number; laneLimit?: LaneLimit; lineInput?: string; lines?: { start: number; end: number }; link?: string;
}
export interface ReviewHost extends PanelHost {
  scrollTo?(offset: number): Promise<void>;
  returnToGraph?(): Promise<void>;
}
export interface NavigationOptions extends OpenOptions { view?: ReviewTab; lines?: { start: number; end: number }; }
export class ReviewController {
  active = false;
  loading = false;
  error?: string;
  current?: ReviewView;
  history: ReviewView[] = [];
  handoff?: HandoffForm;
  followClaude = true;
  mainView = true;
  pending?: { target: string; options: NavigationOptions };
  input = '';
  lineInput = '';
  private generation = 0;
  private fileSequence = 0;
  private scrollRestore?: { offset: number; timer?: { cancel(): void } };
  get restoreOffset(): number { return this.scrollRestore?.offset ?? 0; }
  private cancelScroll(): void {
    this.scrollRestore?.timer?.cancel(); this.scrollRestore = undefined;
  }
  private restoreScroll(offset = 0): void {
    this.cancelScroll(); this.scrollRestore = { offset }; this.host.redraw();
  }
  rendered(offset: number): void {
    const restore = this.scrollRestore;
    if (!restore) { this.scrolled(offset); return; }
    if (restore.timer) return;
    restore.timer = this.host.after(16, () => {
      if (this.scrollRestore !== restore || !this.active) return;
      const move = this.host.scrollTo ? this.host.scrollTo(restore.offset) : this.host.scrollStart?.();
      void Promise.resolve(move).then(() => {
        if (this.scrollRestore === restore) this.scrollRestore = undefined;
      }).catch(error => {
        if (this.scrollRestore === restore) { this.scrollRestore = undefined; this.error = 'Could not restore review position: ' + String(error); this.host.redraw(); }
      });
    });
  }
  scrolled(offset: number, byPerson = false): void {
    if (byPerson) this.cancelScroll();
    if (this.active && this.current && !this.handoff && (!this.scrollRestore || byPerson)) this.current.viewportOffset = offset;
  }
  private saveCurrent(): void {
    if (!this.current) return;
    this.history.push({ ...this.current, lines: this.current.lines ? { ...this.current.lines } : undefined, laneOffset: this.laneOffset, laneLimit: this.laneLimit, lineInput: this.lineInput });
    if (this.history.length > 8) this.history.shift();
  }
  private show(view: ReviewView, remember = true): void {
    if (remember) this.saveCurrent();
    this.current = view;
    this.lineInput = view.lineInput ?? '';
    this.laneOffset = view.laneOffset ?? 0;
    this.laneLimit = view.laneLimit ?? this.preferences.get(view.context.repository.identity).laneLimit;
    this.laneEditor = undefined;
    this.restoreScroll(view.viewportOffset ?? 0);
  }
  get backLabel(): string {
    if (this.loading) return 'Cancel loading';
    return this.history.length ? 'Back' : 'Back to graph';
  }
  readonly preferences: Preferences;
  laneLimit?: LaneLimit;
  laneOffset = 0;
  laneEditor?: LaneEditor;
  private graphCommits?: Commit[];
  private graphRows: ReturnType<typeof layout> = [];
  get graph() {
    const commits = this.current?.context.snapshot.commits;
    if (commits !== this.graphCommits) { this.graphCommits = commits; this.graphRows = layout(commits ?? []); }
    return this.graphRows;
  }
  async lanes(limit: LaneLimit | undefined) {
    if (!this.current) return;
    this.laneLimit = limit; this.laneOffset = 0; this.laneEditor = undefined; this.host.redraw();
    const key = this.current.context.repository.identity;
    await this.preferences.set(key, { ...this.preferences.get(key), laneLimit: limit });
  }
  readonly service: ReviewService;
  readonly host: ReviewHost;
  constructor(host: ReviewHost) { this.host = host; this.service = new ReviewService(host); this.preferences = new Preferences(host.readPreferences, host.writePreferences); }
  async open(target: string, options: NavigationOptions = {}, model = false): Promise<unknown> {
    if (options.lines && (!Number.isInteger(options.lines.start) || !Number.isInteger(options.lines.end) || options.lines.start < 1 || options.lines.end < options.lines.start)) throw new Error('Invalid selected line range.');
    if (model && !this.followClaude) {
      this.pending = { target, options }; this.host.redraw();
      return { displayed: false, reason: 'Follow Claude is off. Navigation queued for the user; use graph_read to inspect without moving their view.' };
    }
    const request = ++this.generation;
    this.fileSequence++; this.cancelScroll();
    this.active = true; this.loading = true; this.error = undefined; this.handoff = undefined; this.pending = undefined; this.host.redraw();
    try {
      await this.host.open();
      const context = await this.service.resolve(target, options);
      if (request !== this.generation || !this.active) return { displayed: false, reason: 'Navigation superseded or panel closed.' };
      const next: ReviewView = { context, tab: options.view ?? context.initialView ?? (context.kind === 'pr' || context.kind === 'compare' || context.kind === 'stack' || context.local ? 'files' : 'graph'), offset: 0, graphOffset: 0, lines: options.lines ?? context.lines };
      next.files = await this.service.files(context);
      next.link = await this.service.link(context);
      if (options.lines) context.lines = options.lines;
      if (request !== this.generation || !this.active) return { displayed: false, reason: 'Navigation superseded or panel closed.' };
      await this.preferences.load();
      if (request !== this.generation || !this.active) return { displayed: false };
      this.show(next);
      if (context.path && context.kind !== 'tree') await this.selectFile({ status: context.kind === 'blob' ? 'blob' : 'M', path: context.path }, context.kind === 'blob', context.kind !== 'blob');
      if (request !== this.generation || !this.active) return { displayed: false, reason: 'Navigation superseded.' };
      return { displayed: true, ...this.selection() };
    } catch (error) {
      if (request === this.generation) { this.error = String(error); this.host.redraw(); }
      throw error;
    } finally { if (request === this.generation) { this.loading = false; this.host.redraw(); } }
  }
  async run(work: () => Promise<unknown>): Promise<void> {
    const request = this.generation, view = this.current;
    try { await work(); } catch (error) { if (this.active && request === this.generation && this.current === view) { this.error = String(error); this.host.redraw(); } }
  }
  closed(): void { this.generation++; this.fileSequence++; this.cancelScroll(); this.active = false; this.loading = false; this.handoff = undefined; this.host.redraw(); }
  async close() { this.closed(); await this.host.close(); }
  back(): void {
    if (this.handoff?.stage === 'sending') return;
    const wasLoading = this.loading;
    this.generation++; this.fileSequence++; this.cancelScroll(); this.loading = false; this.error = undefined; this.laneEditor = undefined;
    if (this.handoff) {
      this.handoff = undefined; this.restoreScroll(this.current?.viewportOffset ?? 0);
    } else if (wasLoading && this.current) {
      this.restoreScroll(this.current.viewportOffset ?? 0);
    } else {
      const previous = this.history.pop();
      if (previous) this.show(previous, false);
      else {
        this.current = undefined; this.active = false; this.host.redraw();
        const leave = this.host.returnToGraph ? this.host.returnToGraph() : this.host.close();
        const request = this.generation;
        void leave.catch(error => { if (request === this.generation) { this.error = String(error); this.active = true; this.host.redraw(); } });
      }
    }
  }
  async tab(tab: ReviewTab) {
    const view = this.current;
    if (!view || this.loading || (view.tab === tab && !view.file)) return;
    const request = ++this.generation;
    const link = await this.service.link(view.context);
    if (request !== this.generation || this.current !== view || !this.active) return;
    this.show({ ...view, tab, file: undefined, preview: undefined, lines: undefined, offset: 0, viewportOffset: 0, link, lineInput: '', laneOffset: this.laneOffset, laneLimit: this.laneLimit });
  }
  async selectFile(file: ChangedFile, blob = false, remember = true) {
    const view = this.current, request = this.generation, fileRequest = ++this.fileSequence;
    if (!view) return;
    this.error = undefined;
    const preview = file.status === '?' ? await filePreview(this.host, this.host.root, view.context.repository, safePath(file.path))
      : blob || file.status === 'blob' || ['blob', 'tree', 'repository'].includes(view.context.kind) ? await this.service.blob(view.context, file.path) : await this.service.patch(view.context, file);
    const link = await this.service.link(view.context, file.path);
    if (request !== this.generation || fileRequest !== this.fileSequence || this.current !== view || !this.active) return;
    const lines = view.lines;
    this.show({ ...view, tab: 'files', file, preview, offset: blob && lines ? Math.max(0, lines.start - 4) : 0, viewportOffset: 0, link, lineInput: '', laneOffset: this.laneOffset, laneLimit: this.laneLimit }, remember);
  }
  async selectCommit(sha: string) {
    const view = this.current, request = this.generation;
    if (!view || this.loading) return;
    const context = await this.service.commitContext(view.context, sha);
    const files = await this.service.files(context), link = await this.service.link(context);
    if (request !== this.generation || this.current !== view || !this.active) return;
    this.show({ context, tab: 'files', files, link, offset: 0, graphOffset: 0 });
  }
  async nextFiles() {
    const view = this.current, request = this.generation;
    if (!view?.files?.hasMore) return;
    const page = await this.service.files(view.context, { offset: view.files.nextOffset, prefix: view.files.prefix });
    if (request !== this.generation || this.current !== view || !this.active) return;
    this.show({ ...view, files: page, viewportOffset: 0 });
  }
  async moreCommits() {
    const view = this.current, request = this.generation;
    if (!view || this.loading) return;
    this.loading = true; this.host.redraw();
    try { await this.service.moreCommits(view.context); }
    finally { if (request === this.generation) { this.loading = false; this.host.redraw(); } }
  }
  async local(mode: 'branch' | 'worktree' | 'uncommitted') {
    const view = this.current;
    if (!view) return;
    let path = view.context.repository.root;
    if (view.context.repository.bare) {
      const candidates = view.context.github ? await this.service.matching(view.context.github) : [];
      if (!candidates.length) throw new Error('No matching local worktree is configured. Select it with graph_open(repository: path).');
      if (candidates.length !== 1) throw new Error('Several worktrees match. Open /gg worktree in the intended session, or pass its repository path to graph_open.');
      path = candidates[0]!.root;
    }
    await this.open('worktree', { repository: path, mode, base: view.context.pr?.base.sha ?? view.context.base });
  }
  selection() {
    const view = this.current;
    if (!view) return { active: this.active, followClaude: this.followClaude };
    return { active: this.active, followClaude: this.followClaude, selectionId: view.context.id, target: view.context.target,
      repository: view.context.repository.root, kind: view.context.kind, title: view.context.title, base: view.context.base, head: view.context.head,
      comparison: view.context.diff.label, githubUrl: view.link, file: view.file?.path, lines: view.lines, view: view.tab, notices: view.context.notices };
  }
  setLines(value: string) {
    const match = /^(\d+)(?:[-:]([0-9]+))?$/.exec(value.trim());
    if (!match || !this.current?.preview) throw new Error('Select preview line numbers, such as 10-25.');
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    const total = this.current.preview.text.split('\n').length;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > total) throw new Error('Line selection is outside the loaded preview.');
    this.current = { ...this.current, lines: { start, end } }; this.error = undefined; this.host.redraw();
  }
  ask() {
    const view = this.current;
    if (!view || !this.mainView || this.loading) return;
    let patch = view.preview;
    if (patch && view.lines) patch = { ...patch, text: patch.text.split('\n').slice(view.lines.start - 1, view.lines.end).join('\n') };
    this.handoff = createHandoff({ repository: view.context.repository.root, comparison: view.context.diff.label, path: view.file?.path, patch,
      review: { title: view.context.title, url: view.link, base: view.context.base, head: view.context.head, lines: view.lines,
        description: view.context.pr?.body?.slice(0, 4000), files: view.files?.files.map(f => `${f.status} ${f.path}`), filesPartial: Boolean(view.files?.hasMore || view.files?.offset), local: Boolean(view.context.local) } });
    this.handoff.question = view.lines ? 'Explain these selected lines.' : view.file ? 'Explain these file changes.' : view.context.pr || view.context.kind === 'stack' ? 'Review these changes.' : 'Explain these changes.';
    this.restoreScroll();
  }
  async send() {
    if (!this.handoff || !this.mainView || !this.host.submitPrompt) return;
    const pending = sendHandoff(this.handoff, this.host.submitPrompt); this.host.redraw(); await pending; this.host.redraw();
  }
  async link(copy: boolean) {
    const url = this.current?.link;
    if (!url) throw new Error('This local selection has no GitHub URL.');
    const result = await this.host.run(copy ? ['/usr/bin/pbcopy'] : ['/usr/bin/open', url], copy ? { stdin: url, timeoutMs: 5000 } : { timeoutMs: 5000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Could not open or copy the GitHub link.');
  }
  async read(input: { target?: string; selectionId?: string; repository?: string; mode?: OpenOptions['mode']; base?: string; file?: string; offset?: number; prefix?: string; lines?: { start: number; end: number } }) {
    const context = input.target ? await this.service.resolve(input.target, input) : input.selectionId ? (this.current?.context.id === input.selectionId ? this.current.context : this.service.contexts.get(input.selectionId)) : this.current?.context;
    if (!context) throw new Error('Selection expired or absent. Pass target to resolve a new snapshot.');
    const offset = input.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('Invalid page offset.');
    const common = { selectionId: context.id, title: context.title, repository: context.repository.root, base: context.base, head: context.head, comparison: context.diff.label, local: Boolean(context.local), mutable: !context.diff.immutable, notices: context.notices, githubUrl: await this.service.link(context, input.file), pullRequest: context.pr ? { number: context.pr.number, title: context.pr.title, description: context.pr.body?.slice(0, 4000), state: context.pr.state, baseBranch: context.pr.base.ref, headBranch: context.pr.head.ref } : undefined, untrustedRepositoryData: true };
    const file = input.file ?? (context.kind === 'tree' ? undefined : context.path);
    if (file) {
      safePath(file);
      const untracked = context.local?.working.some(f => f.path === file && f.kind === 'untracked');
      const patch = untracked ? await filePreview(this.host, this.host.root, context.repository, file) : ['blob', 'tree', 'repository'].includes(context.kind) ? await this.service.blob(context, file) : await this.service.patch(context, { path: file, status: 'M' });
      const lines = patch.text.split('\n'), range = input.lines ?? context.lines;
      if (range && (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start)) throw new Error('Invalid line range.');
      const start = range ? range.start - 1 : offset, end = Math.min(range?.end ?? start + 200, start + 200, lines.length);
      const text = lines.slice(start, end).join('\n');
      return { ...common, file, text: text.slice(0, 12000), fromLine: start + 1, throughLine: end, nextOffset: end < lines.length ? end : undefined, complete: patch.complete && start === 0 && end === lines.length && text.length <= 12000, binary: patch.binary };
    }
    const page = await this.service.files(context, { offset, prefix: input.prefix });
    return { ...common, files: page.files, nextOffset: page.hasMore ? page.nextOffset : undefined, prefix: page.prefix, untracked: context.local?.working.filter(f => f.kind === 'untracked').map(f => f.path), commits: context.snapshot.commits.slice(0, 30).map(c => ({ oid: c.oid, subject: c.subject })), commitsPartial: context.commitsMore || context.snapshot.commits.length > 30 };
  }
}
