import { mkdir, readFile, writeFile, copyFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditRuntime } from './audit-runtime.mjs';
import { runtimeFiles } from './release-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await auditRuntime(root);
const destination = join(root, 'dist/cc-git-graph');
const stamp = '.cc-git-graph-build.json';
let present = false;
try { await access(destination); present = true; } catch {}
if (present) {
  const previous = JSON.parse(await readFile(join(destination, stamp), 'utf8'));
  if (previous.kind !== 'cc-git-graph.generated.v1') throw new Error('Refusing to replace an unrecognized distribution directory.');
  await rm(destination, { recursive: true });
}
await mkdir(destination, { recursive: true });
const files = [];
async function copy(path) {
  const bytes = await readFile(join(root, path));
  await mkdir(join(destination, path, '..'), { recursive: true });
  await copyFile(join(root, path), join(destination, path));
  files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const path of await runtimeFiles(root)) await copy(path);
await writeFile(join(destination, stamp), JSON.stringify({ kind: 'cc-git-graph.generated.v1', files }, null, 2));
await mkdir(join(root, 'dist/.claude-plugin'), { recursive: true });
await copyFile(join(root, 'packaging/marketplace.json'), join(root, 'dist/.claude-plugin/marketplace.json'));
process.stdout.write(`Packaged ${files.length} files (${files.reduce((sum, file) => sum + file.bytes, 0)} bytes) into ${destination}\n`);
