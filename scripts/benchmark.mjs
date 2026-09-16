import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { host } from '../integration/host.mjs';
import { discoverRepository } from '../hooks/git/repository.ts';
import { createGitReader } from '../hooks/git/read.ts';
import { startSnapshot, nextPage } from '../hooks/git/history.ts';
import { layout, graphGlyphs } from '../hooks/graph/layout.ts';
import { historyRowParts } from '../hooks/ui/history-row.ts';

const exec = promisify(execFile), root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const work = join(root, 'work/performance');
await mkdir(work, { recursive: true });
const git = async (path, ...args) => (await exec('git', ['-C', path, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
const exists = async path => { try { await access(path); return true; } catch { return false; } };

async function fixture(count) {
  const path = join(work, String(count)), marker = join(work, count + '.json');
  if (await exists(path)) {
    const metadata = JSON.parse(await readFile(marker, 'utf8'));
    if (metadata.version !== 1 || metadata.count !== count || Number(await git(path, 'rev-list', '--all', '--count')) !== count) throw new Error('Existing benchmark fixture is not the expected generated history.');
    return path;
  }
  await mkdir(path); await git(path, 'init', '-b', 'main');
  const sides = count >= 100000 ? 100 : count >= 10000 ? 10 : 1, base = count - sides - 1;
  const child = spawn('git', ['-C', path, 'fast-import', '--quiet'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  const finished = once(child, 'close');
  const send = async text => { if (!child.stdin.write(text)) await once(child.stdin, 'drain'); };
  const commit = async (index, branch, parents) => {
    const message = `Benchmark commit ${index}: ${'representative subject '.repeat(8)}\n`;
    await send(`commit refs/heads/${branch}\nmark :${index}\ncommitter Fixture <fixture@example.invalid> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}${parents.length ? 'from :' + parents[0] + '\n' : ''}${parents.slice(1).map(parent => 'merge :' + parent + '\n').join('')}\n`);
  };
  for (let i = 1; i <= base; i++) await commit(i, 'main', i > 1 ? [i - 1] : []);
  for (let i = 1; i <= sides; i++) await commit(base + i, 'topic-' + i, [Math.floor(base / 2)]);
  await commit(count, 'main', [base, ...Array.from({ length: sides }, (_, i) => base + i + 1)]);
  child.stdin.end('done\n');
  const [code] = await finished; if (code !== 0) throw new Error(error || 'fast-import failed');
  const tags = count >= 100000 ? 200 : count >= 10000 ? 10 : 0;
  const head = await git(path, 'rev-parse', 'HEAD');
  for (let i = 0; i < tags; i++) await git(path, 'update-ref', 'refs/tags/benchmark-' + i, head);
  await writeFile(marker, JSON.stringify({ version: 1, count, sides, tags }));
  return path;
}

const read = createGitReader(host, root), results = [];
for (const count of [50, 10000, 100000]) {
  const path = await fixture(count), repo = await discoverRepository(host, path);
  const samples = []; let snapshot;
  for (let run = 0; run < 4; run++) {
    const start = performance.now(); snapshot = await nextPage(read, repo, await startSnapshot(read, repo)); samples.push(performance.now() - start);
  }
  const start = performance.now();
  while (snapshot.hasMore) snapshot = await nextPage(read, repo, snapshot);
  const loadRemainingMs = performance.now() - start;
  const layoutStart = performance.now(), graph = layout(snapshot.commits), layoutMs = performance.now() - layoutStart;
  const renderSamples = [];
  for (let run = 0; run < 30; run++) {
    const start = performance.now();
    for (const [index, commit] of snapshot.commits.slice(0, 18).entries()) {
      const glyphs = graphGlyphs(graph[index], 0, 8);
      const refs = snapshot.refs.filter(ref => ref.commit === commit.oid);
      historyRowParts(commit, refs, 'auto', 89 - 3 - glyphs.node.length - (glyphs.overflow ? 1 : 0), 89, commit.oid === snapshot.head, snapshot.branch);
    }
    renderSamples.push(performance.now() - start);
  }
  const result = { commits: count, refs: snapshot.refs.length, loaded: snapshot.commits.length, firstReadMs: samples[0], warmFirstPageMedianMs: samples.slice(1).sort((a, b) => a - b)[1], loadRemainingMs, layoutMs, pureVisibleRowsMedianMs: renderSamples.sort((a, b) => a - b)[15] };
  results.push(result); process.stdout.write(JSON.stringify(result) + '\n');
}
await writeFile(join(work, 'results.json'), JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, conditions: 'Local generated histories. OS caches were not flushed; firstReadMs is first measured read after fixture creation/reuse. Visible row timings measure pure data formatting, not Claude terminal rendering.', results }, null, 2));
