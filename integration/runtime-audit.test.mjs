import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditRuntime } from '../scripts/audit-runtime.mjs';

test('runtime package audit permits local source and host types, rejects external or dynamic loading', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graph-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'hooks'));
  const source = join(root, 'hooks/register.ts');
  await writeFile(join(root, 'hooks/local.ts'), 'export const value = 1;');
  await writeFile(source, "import type { Register } from 'claude-code'; import { value } from './local.ts';");
  assert.equal((await auditRuntime(root)).files, 2);
  for (const code of ["import fs from 'node:fs';", "export * from 'react';", "import { x } from 'claude-code';", "import('node:fs');", "require('fs');", "eval('code');", "new Function('code');"]) {
    await writeFile(source, code);
    await assert.rejects(auditRuntime(root), /unsupported external|dynamic module/);
  }
  await writeFile(join(root, 'outside.ts'), 'export const value = 2;');
  await symlink('../outside.ts', join(root, 'hooks/escape.ts'));
  await writeFile(source, "import { value } from './escape.ts';");
  await assert.rejects(auditRuntime(root), /escapes runtime source/);
});
