export const lanePalette = ['#5cc8ff', '#ff9e45', '#b18cff', '#68d391', '#ff7a90', '#f6d365', '#56d4c7', '#ef8fca', '#759bff', '#c4db6c', '#ff966c', '#8ddde3'] as const;

export const laneColour = (identity: number) => lanePalette[identity % lanePalette.length]!;

export const refColours = { head: '#eff6ff', remote: '#759bff', tag: '#ffd479', more: '#b6c2d1' } as const;
export const badgeTextColour = '#111827';
