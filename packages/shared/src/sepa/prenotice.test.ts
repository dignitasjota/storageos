import { describe, expect, it } from 'vitest';

import { daysUntilCollection, earliestCollectionDate } from './index';

describe('preaviso SEPA', () => {
  const today = new Date('2026-10-01T15:30:00Z');

  it('primera fecha válida = hoy + plazo', () => {
    expect(earliestCollectionDate(14, today)).toBe('2026-10-15');
    expect(earliestCollectionDate(2, today)).toBe('2026-10-03');
    expect(earliestCollectionDate(14, new Date('2026-12-25T00:00:00Z'))).toBe('2027-01-08');
  });

  it('días hasta la fecha de cargo', () => {
    expect(daysUntilCollection('2026-10-15', today)).toBe(14);
    expect(daysUntilCollection('2026-10-05', today)).toBe(4);
    expect(daysUntilCollection('2026-09-30', today)).toBe(-1);
  });
});
