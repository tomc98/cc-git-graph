export interface Choice { value: string; label: string; }

export function selectPage(choices: readonly Choice[], selected: string, requested = 0) {
  const count = Math.max(1, Math.ceil(choices.length / 63));
  const page = Math.min(Math.max(0, requested), count - 1);
  const options = choices.slice(page * 63, (page + 1) * 63);
  const current = choices.find(choice => choice.value === selected);
  if (current && !options.includes(current)) options.unshift(current);
  return { page, count, options };
}
