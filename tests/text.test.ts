import { expect, test, tier } from 'claude-code/testing';

import { cellWidth, clip } from '../hooks/ui/text.ts';

tier('user');

test('runtime supports grapheme segmentation for terminal labels', () => {
  const segments = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment('👩🏽‍💻🇦🇺e\u0301')].map(item => item.segment);
  expect(segments).toEqual(['👩🏽‍💻', '🇦🇺', 'e\u0301']);
});


test('terminal labels keep emoji and combining graphemes intact', () => {
  for (const value of ['👩🏽‍💻', '👨‍👩‍👧‍👦', '🇦🇺', '👍🏽', '1️⃣']) {
    expect(cellWidth(value)).toBe(2);
    expect(clip(value + 'abc', 2)).toBe('…');
    expect(clip(value + 'abc', 3)).toBe(value + '…');
  }
  expect(cellWidth('中文')).toBe(4);
  expect(cellWidth('e\u0301')).toBe(1);
  expect(clip('e\u0301abcd', 2)).toBe('e\u0301…');
});
