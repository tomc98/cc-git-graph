import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runtimeFiles, sourceFiles } from './release-files.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export async function auditRelease(root) {
  const pkg = await json(join(root, 'package.json'));
  const lock = await json(join(root, 'package-lock.json'));
  const plugin = await json(join(root, '.claude-plugin/plugin.json'));
  const marketplace = await json(join(root, '.claude-plugin/marketplace.json'));
  const local = await json(join(root, 'packaging/marketplace.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  for (const item of [lock, lock.packages[''], plugin, ...marketplace.plugins, ...local.plugins]) assert.equal(item.version, pkg.version, 'Release versions must agree');
  for (const item of [pkg, lock.packages[''], plugin, ...marketplace.plugins, ...local.plugins]) assert.equal(item.license, 'MIT');
  assert.equal(marketplace.name, 'cc-git-graph');
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(local.name, 'cc-git-graph-local');
  assert.equal(local.plugins[0].source, './cc-git-graph');
  assert.match(await readFile(join(root, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Thomas Csere/);
  const sources = await sourceFiles(root);
  const privateContent = /\/Users\/[A-Za-z0-9_.-]+|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-ant-api)[A-Za-z0-9_-]{16,}/i;
  for (const path of sources) {
    if (/\.(?:png|jpe?g|webp|gif)$/.test(path)) continue;
    const content = await readFile(join(root, path), 'utf8');
    assert.ok(!privateContent.test(content), `Private path, project name or credential marker in ${path}`);
  }
  const destination = join(root, 'dist/cc-git-graph');
  const stamp = await json(join(destination, '.cc-git-graph-build.json'));
  assert.equal(stamp.kind, 'cc-git-graph.generated.v1');
  const expected = await runtimeFiles(root);
  assert.deepEqual(stamp.files.map(file => file.path).sort(), expected, 'Package inventory must match the runtime allowlist');
  for (const file of stamp.files) {
    const source = await readFile(join(root, file.path));
    const built = await readFile(join(destination, file.path));
    assert.equal(file.bytes, source.length, `Source size changed: ${file.path}`);
    assert.equal(hash(source), file.sha256, `Source changed after packaging: ${file.path}`);
    assert.equal(hash(built), file.sha256, `Package file changed: ${file.path}`);
  }
  const actual = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      assert.ok(!entry.isSymbolicLink(), `Unexpected package symlink: ${path}`);
      if (entry.isDirectory()) await walk(join(directory, entry.name), path + '/');
      else actual.push(path);
    }
  }
  await walk(destination);
  assert.deepEqual(actual.sort(), [...expected, '.cc-git-graph-build.json'].sort(), 'Unlisted files in package');
  assert.deepEqual(await json(join(root, 'dist/.claude-plugin/marketplace.json')), local);
  return { version: pkg.version, sourceFiles: sources.length, packagedFiles: expected.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditRelease(fileURLToPath(new URL('..', import.meta.url)));
  process.stdout.write(`Release audit passed: ${result.sourceFiles} public source files, ${result.packagedFiles} packaged files, version ${result.version}.\n`);
}
