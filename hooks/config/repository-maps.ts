import type { Repository } from '../git/repository.ts';
import { containsPath, normalizePath } from './paths.ts';

export interface RepositoryChoice {
  id: string;
  label: string;
  path: string;
  repository?: Repository;
  error?: string;
}

export interface RepositoryContext {
  key: string;
  cwd: string;
  mapPath?: string;
  choices: RepositoryChoice[];
  selectedId?: string;
  mapped: boolean;
  diagnostics: string[];
}

export interface MapServices {
  canonical(path: string): Promise<string>;
  discover(path: string): Promise<Repository>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function resolveRepositoryContext(input: {
  config: string | undefined;
  cwd: string;
  home: string;
  previous?: Pick<RepositoryContext, 'key' | 'choices' | 'selectedId'>;
}, services: MapServices): Promise<RepositoryContext> {
  const diagnostics: string[] = [];
  const cwd = await services.canonical(normalizePath(input.cwd, input.home, false));
  let maps: unknown[] = [];
  if (input.config?.trim()) {
    try {
      const config: unknown = JSON.parse(input.config);
      if (!record(config)) throw new Error('Configuration must be an object.');
      if (Object.keys(config).length > 0) {
        if (config.version !== 1) throw new Error('Unsupported or missing repository-map version. Use version 1.');
        if (!Array.isArray(config.repositoryMaps)) throw new Error('repositoryMaps must be an array.');
        maps = config.repositoryMaps;
      }
    } catch (error) { diagnostics.push(`Configuration: ${String(error)}`); }
  }
  const matches: { map: Record<string, unknown>; path: string; index: number }[] = [];
  const seen = new Set<string>();
  for (const [index, map] of maps.entries()) {
    try {
      if (!record(map) || !text(map.whenPath)) throw new Error('Each map requires whenPath.');
      const path = await services.canonical(normalizePath(map.whenPath, input.home));
      if (seen.has(path)) diagnostics.push(`Map ${index + 1}: duplicate normalized whenPath; the earlier matching map wins.`);
      seen.add(path);
      const descendants = map.includeSubdirectories !== false;
      if (containsPath(path, cwd, descendants)) matches.push({ map, path, index });
    } catch (error) { diagnostics.push(`Map ${index + 1}: ${String(error)}`); }
  }
  matches.sort((a, b) => b.path.length - a.path.length || a.index - b.index);
  const matched = matches[0];
  const key = matched ? `map:${matched.path}` : `cwd:${cwd}`;
  const choices: RepositoryChoice[] = [];
  let current: Repository | undefined;
  try { current = await services.discover(cwd); } catch { /* An orchestration directory may be outside Git. */ }

  if (matched) {
    const map = matched.map;
    const validFlag = map.includeSubdirectories === undefined || typeof map.includeSubdirectories === 'boolean';
    if (!validFlag || !Array.isArray(map.repositories)) {
      diagnostics.push('The matching map has an invalid shape; using the current repository.');
    } else {
      const ids = new Set<string>();
      const identities = new Set<string>();
      for (const [index, value] of map.repositories.entries()) {
        if (!record(value) || !text(value.id) || !text(value.label) || !text(value.path)) {
          diagnostics.push(`Repository ${index + 1}: id, label and path must be nonempty strings.`); continue;
        }
        if (ids.has(value.id)) { diagnostics.push(`Duplicate repository id: ${value.id}. Keeping the first entry.`); continue; }
        ids.add(value.id);
        const choice: RepositoryChoice = { id: value.id, label: value.label, path: value.path };
        try {
          choice.path = await services.canonical(normalizePath(value.path, input.home));
          choice.repository = await services.discover(choice.path);
          if (identities.has(choice.repository.identity)) {
            diagnostics.push(`Duplicate checkout: ${choice.label}. Keeping its first button.`); continue;
          }
          identities.add(choice.repository.identity);
        } catch (error) { choice.error = String(error); diagnostics.push(`${choice.label}: ${choice.error}`); }
        choices.push(choice);
      }
    }
  }
  const usable = choices.filter(choice => choice.repository);
  if (!usable.length) {
    if (matched) diagnostics.push('The matching map has no usable repositories; using the session repository.');
    if (current) choices.push({ id: '__current__' + choices.length, label: current.root.split('/').at(-1) || current.root, path: current.root, repository: current });
    else diagnostics.push('The session directory is not a Git repository. Add a repository map or choose a repository path.');
  }
  const available = choices.filter(choice => choice.repository);
  const defaultId = matched?.map.defaultRepository;
  const defaultChoice = text(defaultId) ? usable.find(choice => choice.id === defaultId) : undefined;
  if (defaultId !== undefined && !defaultChoice) diagnostics.push('The configured defaultRepository is unavailable; choosing a usable repository.');
  const previousRepo = input.previous?.choices.find(choice => choice.id === input.previous?.selectedId)?.repository;
  const preserved = input.previous?.key === key && previousRepo
    ? available.find(choice => choice.repository?.identity === previousRepo.identity) : undefined;
  const selected = preserved ?? defaultChoice ?? available.find(choice => choice.repository?.identity === current?.identity) ?? available[0];
  return { key, cwd, mapPath: matched?.path, choices, selectedId: selected?.id, mapped: Boolean(matched && usable.length), diagnostics };
}
