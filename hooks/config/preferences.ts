export type Columns = 'auto' | 'compact' | 'author' | 'full';
export type LaneLimit = number | 'all';
export const validLaneLimit = (value: unknown): value is LaneLimit => value === 'all' || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
export interface DisplayPreferences { filter: string; columns: Columns; laneLimit?: LaneLimit; }
export const preferenceKey = 'cc-git-graph.preferences.v1';
const validColumns = new Set(['auto', 'compact', 'author', 'full']);
const budget = 32768;

export class Preferences {
  private entries = new Map<string, DisplayPreferences>();
  private loaded?: Promise<void>;
  private writing = Promise.resolve();
  private read?: () => Promise<unknown>;
  private write?: (value: unknown) => Promise<void>;

  constructor(read?: () => Promise<unknown>, write?: (value: unknown) => Promise<void>) { this.read = read; this.write = write; }

  load(): Promise<void> {
    return this.loaded ??= (async () => {
      const value = await this.read?.() as { version?: unknown; repositories?: unknown } | undefined;
      if (!value || value.version !== 1 || !Array.isArray(value.repositories)) return;
      for (const entry of value.repositories.slice(-128)) {
        if (!entry || typeof entry.identity !== 'string' || entry.identity.length > 8192 || typeof entry.filter !== 'string' || entry.filter.length > 1024 || !validColumns.has(entry.columns)) continue;
        this.entries.set(entry.identity, { filter: entry.filter, columns: entry.columns, ...(validLaneLimit(entry.laneLimit) ? { laneLimit: entry.laneLimit } : {}) });
      }
      this.bound();
    })().catch(error => { this.loaded = undefined; throw error; });
  }

  get(identity: string): DisplayPreferences {
    return this.entries.get(identity) ?? { filter: '', columns: 'auto' };
  }

  private payload() {
    return { version: 1, repositories: [...this.entries].map(([identity, value]) => ({ identity, ...value })) };
  }

  private bound(): void {
    while (this.entries.size > 128 || JSON.stringify(this.payload()).length * 2 > budget) {
      const key = this.entries.keys().next().value;
      if (key === undefined) break;
      this.entries.delete(key);
    }
  }

  async set(identity: string, value: DisplayPreferences): Promise<void> {
    if (!validColumns.has(value.columns) || value.filter.length > 1024 || identity.length > 8192) throw new Error('Display preference exceeds its supported limits.');
    if (value.laneLimit !== undefined && !validLaneLimit(value.laneLimit)) throw new Error('Lane count must be a positive whole number or all.');
    this.entries.delete(identity); this.entries.set(identity, { ...value }); this.bound();
    const payload = this.payload();
    this.writing = this.writing.catch(() => {}).then(async () => { await this.write?.(payload); });
    await this.writing;
  }
}
