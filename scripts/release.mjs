import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRelease } from './audit-release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = await auditRelease(root);
const name = `cc-git-graph-${version}.tar.gz`;
const archive = join(root, 'dist', name);
execFileSync('tar', ['-czf', archive, '-C', join(root, 'dist'), 'cc-git-graph'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit' });
const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', `${checksum}  ${name}\n`);
process.stdout.write(`Prepared ${archive} and its SHA-256 checksum. Nothing was published.\n`);
