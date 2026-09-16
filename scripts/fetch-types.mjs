import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const url = 'https://raw.githubusercontent.com/anthropics/claude-code/v2.1.272/mods/types/claude-code.d.ts';
const expected = '69d14af889cae22568b6051382e72971578156b36479d4ce4ad13f473797d4ac';
const directory = new URL('../.cache/claude-types/', import.meta.url);
const destination = new URL('claude-code.d.ts', directory);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let cached;
try { cached = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (cached && hash(cached) === expected) {
  process.stdout.write('Using verified Claude API declarations from cache.\n');
} else {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Type download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== expected) throw new Error('Claude API declaration checksum changed. Review the upstream contract before updating the pin.');
  await mkdir(directory, { recursive: true });
  await writeFile(destination, bytes);
  process.stdout.write('Downloaded and verified Claude API declarations for static checks.\n');
}
