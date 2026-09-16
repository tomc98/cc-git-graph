import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export async function auditRuntime(root) {
  const hooks = await realpath(resolve(root, 'hooks'));
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  }
  await walk(hooks);
  const imports = [];
  for (const path of files) {
    const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const pending = [];
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const name = specifier.text;
          const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
          if (name === 'claude-code' && typeOnly) imports.push({ file: relative(root, path), module: name, typeOnly: true });
          else {
            if (!name.startsWith('./') && !name.startsWith('../')) throw new Error(`${path}: unsupported external import ${name}`);
            pending.push(async () => {
              const target = await realpath(resolve(dirname(path), name));
              const within = relative(hooks, target);
              if (within.startsWith('..') || isAbsolute(within) || !/\.tsx?$/.test(target)) throw new Error(`${path}: import escapes runtime source: ${name}`);
              imports.push({ file: relative(root, path), module: name, typeOnly: Boolean(typeOnly) });
            });
          }
        }
      }
      if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text)))) || (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function')) {
        throw new Error(`${path}: dynamic module/code loading is outside the audited runtime contract`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    await Promise.all(pending.map(check => check()));
  }
  return { files: files.length, imports: imports.sort((a, b) => a.file.localeCompare(b.file) || a.module.localeCompare(b.module)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditRuntime(fileURLToPath(new URL('..', import.meta.url)));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
