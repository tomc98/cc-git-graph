import { objectId, type Ref } from './history.ts';
import { complete, type GitReader } from './read.ts';
import type { Repository } from './repository.ts';

export interface TagDetail { ref: Ref; annotated: boolean; target: string; targetType: string; tagger?: string; message: string; messageComplete: boolean; }

export async function readTag(read: GitReader, repo: Repository, ref: Ref): Promise<TagDetail> {
  if (ref.kind !== 'tag' || !ref.name.startsWith('refs/tags/') || !objectId(ref.oid, repo.objectFormat)) throw new Error('Select an existing tag with its full object ID.');
  const type = complete(await read(repo.root, ['cat-file', '-t', ref.oid]), 'Read tag type').trim();
  if (type !== 'tag') return { ref, annotated: false, target: ref.oid, targetType: type, message: '', messageComplete: true };
  const result = await read(repo.root, ['cat-file', 'tag', ref.oid], { limit: 65536 });
  if (result.exitCode !== 0) throw new Error('Read tag: ' + result.stderr);
  const split = result.stdout.indexOf('\n\n');
  if (split < 0) throw new Error('Tag headers are incomplete or exceed the preview limit.');
  const header = result.stdout.slice(0, split).split('\n');
  const target = header.find(line => line.startsWith('object '))?.slice(7);
  const targetType = header.find(line => line.startsWith('type '))?.slice(5);
  if (!target || !objectId(target, repo.objectFormat) || !targetType) throw new Error('Invalid tag object headers.');
  return { ref, annotated: true, target, targetType, tagger: header.find(line => line.startsWith('tagger '))?.slice(7), message: result.stdout.slice(split + 2), messageComplete: result.stdoutComplete && result.stdoutValidUtf8 };
}
