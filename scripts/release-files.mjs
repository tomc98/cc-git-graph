import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function sourceFiles(root) {
  const excluded = new Set(['.git', '.claude', '.cache', 'node_modules', 'work', 'dist', 'coverage']);
  const files = [];
  async function walk(path = '') {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if ((!path && excluded.has(entry.name)) || entry.name === '.DS_Store' || entry.name.endsWith('.log') || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Release source must not contain a symlink: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else files.push(name);
    }
  }
  await walk();
  return files.sort();
}

export async function runtimeFiles(root) {
  const files = await sourceFiles(root);
  const documents = new Set(['README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SPEC.md', 'PLAN.md']);
  const helpers = new Set(['git-read.py', 'git-state.py', 'file-preview.py', 'git-files.py', 'github-read.py']);
  return files.filter(path => path === '.claude-plugin/plugin.json'
    || /^skills\/.*\.md$/.test(path)
    || /^hooks\/.*\.(ts|tsx|json)$/.test(path)
    || (path.startsWith('scripts/') && helpers.has(path.slice(8)))
    || documents.has(path)
    || /^docs\/.*\.(md|png|jpg|jpeg|webp|gif)$/.test(path)
    || /^examples\/.*\.json$/.test(path));
}
