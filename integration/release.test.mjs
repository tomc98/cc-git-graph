import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { sourceFiles } from '../scripts/release-files.mjs';
import { auditRelease } from '../scripts/audit-release.mjs';

const exec = promisify(execFile);

test('release audit rejects drift, extra files and private paths; packaging excludes local state', async t => {
  const source = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'graph-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of await sourceFiles(source)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(source, path), join(root, path));
  }
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'));
  for (const directory of ['.claude', '.cache', 'work']) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, 'private.txt'), 'local state must not ship');
  }
  await writeFile(join(root, '.env'), 'PRIVATE_FIXTURE=local');
  await exec(process.execPath, ['scripts/package.mjs'], { cwd: root });
  const valid = await auditRelease(root);
  assert.ok(valid.packagedFiles > 30);
  const packaged = JSON.parse(await readFile(join(root, 'dist/cc-git-graph/.cc-git-graph-build.json'), 'utf8'));
  assert.ok(packaged.files.some(file => file.path === 'LICENSE'));
  assert.ok(packaged.files.every(file => !/^(?:\.claude\/|\.cache\/|work\/|integration\/|tests\/|node_modules\/)/.test(file.path)));

  const manifestPath = join(root, '.claude-plugin/plugin.json');
  const manifest = await readFile(manifestPath, 'utf8');
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifest), version: '99.0.0' }));
  await assert.rejects(auditRelease(root), /versions must agree/);
  await writeFile(manifestPath, manifest);

  const built = join(root, 'dist/cc-git-graph/LICENSE');
  const license = await readFile(built);
  await writeFile(built, 'tampered');
  await assert.rejects(auditRelease(root), /Package file changed/);
  await writeFile(built, license);

  const extra = join(root, 'dist/cc-git-graph/unlisted.txt');
  await writeFile(extra, 'unexpected');
  await assert.rejects(auditRelease(root), /Unlisted files/);
  await rm(extra);

  const note = join(root, 'private-note.md');
  await writeFile(note, ['', 'Users', 'private', 'project'].join('/'));
  await assert.rejects(auditRelease(root), /Private path/);
  await rm(note);

  const escape = join(root, 'hooks/escape.ts');
  await symlink(join(root, 'LICENSE'), escape);
  await assert.rejects(auditRelease(root), /symlink/);
  await rm(escape);
  assert.deepEqual(await auditRelease(root), valid);
});
