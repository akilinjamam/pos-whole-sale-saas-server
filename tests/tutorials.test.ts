import { describe, expect, it } from 'vitest';

import { parseYouTubeId } from '../src/shared/tutorials.js';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTubeId', () => {
  it.each([
    [ID],
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=42s&list=PL123`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`youtube.com/watch?v=${ID}`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abcdef`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube-nocookie.com/embed/${ID}?autoplay=1`],
    [`https://www.youtube.com/live/${ID}`],
    [`  https://youtu.be/${ID}  `],
  ])('reads %s', (input) => {
    expect(parseYouTubeId(input)).toBe(ID);
  });

  it.each([
    [''],
    ['not a link'],
    ['https://vimeo.com/123456789'],
    ['https://www.youtube.com/watch?v=short'],
    ['https://www.youtube.com/channel/UCabcdefghijk'],
    ['https://evil.example.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtu.be/'],
  ])('refuses %j', (input) => {
    expect(parseYouTubeId(input)).toBeNull();
  });
});
