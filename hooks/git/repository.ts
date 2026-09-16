import { git, lineValue, requireSuccess, type ReadHost } from '../host.ts';
import { canonicalPath } from '../config/paths.ts';

export interface Repository {
  identity: string;
  root: string;
  gitDir: string;
  commonDir: string;
  bare: boolean;
  shallow: boolean;
  objectFormat: 'sha1' | 'sha256';
}

export async function discoverRepository(host: ReadHost, path: string): Promise<Repository> {
  const cwd = await canonicalPath(host, path);
  const read = async (args: string[]) => lineValue(requireSuccess(await git(host, cwd, ['rev-parse', ...args]), 'Repository discovery'));
  const bareText = await read(['--is-bare-repository']);
  if (!['true', 'false'].includes(bareText)) throw new Error('The directory is not a Git repository.');
  const bare = bareText === 'true';
  const [gitPath, commonPath, rootPath, shallowText, objectFormat] = await Promise.all([
    read(['--absolute-git-dir']), read(['--path-format=absolute', '--git-common-dir']),
    bare ? Promise.resolve(cwd) : read(['--show-toplevel']),
    read(['--is-shallow-repository']), read(['--show-object-format']),
  ]);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error(`Unsupported Git object format: ${objectFormat}`);
  const [root, gitDir, commonDir] = await Promise.all([bare ? gitPath : rootPath, gitPath, commonPath].map(p => canonicalPath(host, p)));
  return { identity: JSON.stringify([root, gitDir]), root: root!, gitDir: gitDir!, commonDir: commonDir!, bare, shallow: shallowText === 'true', objectFormat };
}
