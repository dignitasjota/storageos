import { describe, expect, it } from 'vitest';

import {
  collectionDateIssue,
  isSepaBusinessDay,
  nextSepaBusinessDay,
  sepaId,
  sepaText,
} from './collection';

describe('fecha de cobro SEPA', () => {
  it('festivos TARGET2 y fines de semana', () => {
    expect(isSepaBusinessDay('2026-04-03')).toBe(false); // Viernes Santo
    expect(isSepaBusinessDay('2026-04-06')).toBe(false); // Lunes de Pascua
    expect(isSepaBusinessDay('2026-12-25')).toBe(false);
    expect(isSepaBusinessDay('2026-10-24')).toBe(false); // sábado
    expect(isSepaBusinessDay('2026-10-26')).toBe(true);
    expect(nextSepaBusinessDay('2026-12-25')).toBe('2026-12-28');
  });

  it('pasada, lejana o en festivo', () => {
    expect(collectionDateIssue('2026-10-23', '2026-10-23')?.issue).toBe('past');
    expect(collectionDateIssue('2027-12-01', '2026-10-23')?.issue).toBe('too_far');
    expect(collectionDateIssue('2026-12-26', '2026-10-23')).toEqual({
      issue: 'not_business_day',
      suggestion: '2026-12-28',
    });
    expect(collectionDateIssue('2026-11-02', '2026-10-23')).toBeNull();
  });
});

describe('textos SEPA', () => {
  it('quita acentos y caracteres no admitidos y recorta', () => {
    expect(sepaText('Peña & Hijos, S.L. — trastero «A1»', 70)).toBe(
      'Pena + Hijos, S.L. trastero A1',
    );
    expect(sepaText('x'.repeat(200), 140)).toHaveLength(140);
  });

  it('identificadores sin espacios ni barras dobles', () => {
    expect(sepaId('/MND ÑU//12/')).toBe('MNDNU/12');
    expect(sepaId('E'.repeat(50))).toHaveLength(35);
  });
});

describe('caducidad del mandato', () => {
  it('36 meses desde el último cobro o desde la firma', async () => {
    const { isSepaMandateExpired, sepaMandateExpiresOn } = await import('./collection');
    expect(sepaMandateExpiresOn(null, '2023-10-20')).toBe('2026-10-20');
    expect(sepaMandateExpiresOn('2024-02-29', '2020-01-01')).toBe('2027-02-28');
    expect(isSepaMandateExpired(null, '2023-10-20', '2026-10-23')).toBe(true);
    expect(isSepaMandateExpired('2024-01-10', '2023-10-20', '2026-10-23')).toBe(false);
  });
});
