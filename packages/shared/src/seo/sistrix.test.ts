import { describe, expect, it } from 'vitest';

import {
  AddSeoProjectKeywordsSchema,
  CreateSeoCompetitorSchema,
  madridInstant,
  normalizeSeoDomain,
  normalizeSeoKeyword,
  sistrixQuotaResetAt,
  sistrixWeekStart,
} from './sistrix';

describe('SISTRIX: utilidades', () => {
  it('normaliza palabras y dominios', () => {
    expect(normalizeSeoKeyword('  Trasteros   VALENCIA ')).toBe('trasteros valencia');
    expect(normalizeSeoDomain('https://www.Competidor.es/precios?x=1')).toBe('competidor.es');
    expect(normalizeSeoDomain('no es un dominio')).toBeNull();
    expect(CreateSeoCompetitorSchema.parse({ domain: 'WWW.bluespace.es' }).domain).toBe(
      'bluespace.es',
    );
    expect(
      AddSeoProjectKeywordsSchema.parse({ keywords: ['Trasteros  Mislata', 'trasteros mislata'] })
        .keywords,
    ).toEqual(['trasteros mislata']);
  });

  it('la cuota del MCP vuelve al día siguiente a las 00:05 de Madrid', () => {
    // Invierno (UTC+1): 25-11-2026 15:00 UTC → 26-11 00:05 Madrid = 25-11 23:05 UTC.
    expect(sistrixQuotaResetAt(new Date('2026-11-25T15:00:00Z')).toISOString()).toBe(
      '2026-11-25T23:05:00.000Z',
    );
    // Verano (UTC+2): 30-06 23:30 UTC ya es 01-07 en Madrid → 02-07 00:05 = 01-07 22:05 UTC.
    expect(sistrixQuotaResetAt(new Date('2026-06-30T23:30:00Z')).toISOString()).toBe(
      '2026-07-01T22:05:00.000Z',
    );
    expect(madridInstant('2026-03-29', 3, 0).toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });

  it('la semana de créditos empieza el lunes en Madrid', () => {
    // Miércoles 25-11-2026.
    expect(sistrixWeekStart(new Date('2026-11-25T10:00:00Z'))).toBe('2026-11-23');
    // Domingo 29-11 a las 23:30 UTC ya es lunes 30 en Madrid.
    expect(sistrixWeekStart(new Date('2026-11-29T23:30:00Z'))).toBe('2026-11-30');
  });
});
