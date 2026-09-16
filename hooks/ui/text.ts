export function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    character => character === '\n' ? '\\n' : character === '\t' ? '\\t' : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function graphemeWidth(value: string): number {
  if (/\p{Regional_Indicator}|\u20e3/u.test(value) || /\p{Extended_Pictographic}/u.test(value) && /\u200d|\p{Emoji_Modifier}/u.test(value)) return 2;
  let width = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (/\p{Mark}/u.test(character) || point === 0x200d || point === 0xfe0f) continue;
    width += /\p{Extended_Pictographic}/u.test(character) || (point >= 0x1100 && (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff00 && point <= 0xff60 || point >= 0x20000)) ? 2 : 1;
  }
  return width;
}

export function cellWidth(value: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(value)) width += graphemeWidth(segment);
  return width;
}

export function clip(value: string, columns: number): string {
  const clean = safeText(value);
  if (cellWidth(clean) <= columns) return clean;
  let result = '', width = 0;
  for (const { segment } of segmenter.segment(clean)) {
    const next = graphemeWidth(segment);
    if (width + next > Math.max(0, columns - 1)) break;
    result += segment; width += next;
  }
  return columns > 0 ? result + '…' : '';
}
