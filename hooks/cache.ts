export class DetailCache {
  readonly limit: number;
  private entries = new Map<string, { value: unknown; bytes: number }>();
  bytes = 0;

  constructor(limit = 32 * 1024 * 1024) { this.limit = limit; }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value as T;
  }

  set(key: string, value: unknown): void {
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    // Account for UTF-16 text, serialized structure and a per-entry allowance.
    const bytes = (key.length + JSON.stringify(value).length) * 2 + 256;
    if (bytes > this.limit) return;
    while (this.bytes + bytes > this.limit) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]); this.bytes -= oldest[1].bytes;
    }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
  }

  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await load();
    this.set(key, value);
    return value;
  }
}
