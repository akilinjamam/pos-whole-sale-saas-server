import { describe, expect, it } from 'vitest';

import {
  SLUG_MAX_LENGTH,
  baseSlug,
  slugCandidate,
  slugify,
  trialEndsAt,
} from '../src/domain/tenant.js';

describe('slugify', () => {
  it('lowercases and joins words with single hyphens', () => {
    expect(slugify('Rahman Optical & Co.')).toBe('rahman-optical-co');
    expect(slugify('  Eye   Line -- Optics  ')).toBe('eye-line-optics');
  });

  it('strips accents rather than dropping the letter', () => {
    expect(slugify('Café Óptica')).toBe('cafe-optica');
  });

  it('leaves nothing for a name with no latin letters or digits', () => {
    expect(slugify('চশমা ঘর')).toBe('');
  });

  it('keeps digits', () => {
    expect(slugify('Optics 24/7')).toBe('optics-24-7');
  });

  it('never exceeds the maximum length or ends on a hyphen', () => {
    const slug = slugify('a'.repeat(SLUG_MAX_LENGTH - 1) + ' bcd');
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('baseSlug', () => {
  it('falls back to "business" for an unusable name', () => {
    expect(baseSlug('চশমা ঘর')).toBe('business');
    expect(baseSlug('!')).toBe('business');
    expect(baseSlug('A')).toBe('business');
  });

  it('refuses reserved words', () => {
    expect(baseSlug('Admin')).toBe('business');
    expect(baseSlug('API')).toBe('business');
  });

  it('uses the slugified name otherwise', () => {
    expect(baseSlug('Rahman Optical')).toBe('rahman-optical');
  });
});

describe('slugCandidate', () => {
  it('returns the base first, then numbered suffixes', () => {
    expect(slugCandidate('rahman-optical', 1)).toBe('rahman-optical');
    expect(slugCandidate('rahman-optical', 2)).toBe('rahman-optical-2');
    expect(slugCandidate('rahman-optical', 12)).toBe('rahman-optical-12');
  });

  it('trims the base so the suffix fits', () => {
    const base = 'x'.repeat(SLUG_MAX_LENGTH);
    const candidate = slugCandidate(base, 10);
    expect(candidate.length).toBe(SLUG_MAX_LENGTH);
    expect(candidate.endsWith('-10')).toBe(true);
  });
});

describe('trialEndsAt', () => {
  const start = new Date('2026-10-16T06:00:00.000Z');

  it('adds whole days', () => {
    expect(trialEndsAt(start, 14).toISOString()).toBe('2026-10-30T06:00:00.000Z');
  });

  it('defaults to 14 days', () => {
    expect(trialEndsAt(start).toISOString()).toBe('2026-10-30T06:00:00.000Z');
  });

  it('rejects a negative or fractional length', () => {
    expect(() => trialEndsAt(start, -1)).toThrow();
    expect(() => trialEndsAt(start, 1.5)).toThrow();
  });
});
