import { describe, expect, it } from 'vitest';

import { emailKey, leadScore, phoneKey } from './index';

const base = {
  status: 'new',
  source: 'manual',
  email: null,
  phone: null,
  message: null,
  preferredFacilityId: null,
  preferredUnitTypeId: null,
  preferredStartDate: null,
  budgetMonthly: null,
  createdAt: '2026-10-01T10:00:00Z',
};
const now = new Date('2026-10-02T10:00:00Z');

describe('leadScore', () => {
  it('un contacto completo y con prisa puntúa alto', () => {
    const r = leadScore(
      {
        ...base,
        source: 'web',
        phone: '600111222',
        email: 'a@b.es',
        preferredUnitTypeId: 'x',
        preferredStartDate: '2026-10-10',
        budgetMonthly: 50,
      },
      now,
    );
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.reasons[0]).toBe('Lo necesita en menos de un mes');
  });

  it('uno sin datos puntúa poco y uno antiguo baja', () => {
    expect(leadScore(base, now).score).toBe(10);
    expect(leadScore(base, new Date('2027-01-01T00:00:00Z')).score).toBe(0);
  });

  it('ganados y perdidos no puntúan', () => {
    expect(leadScore({ ...base, status: 'won', phone: '600111222' }, now).score).toBe(0);
  });
});

describe('claves de duplicados', () => {
  it('teléfono por las últimas 9 cifras y email en minúsculas', () => {
    expect(phoneKey('+34 600 11 12 22')).toBe('600111222');
    expect(phoneKey('1234')).toBeNull();
    expect(emailKey(' Ana@Ejemplo.ES ')).toBe('ana@ejemplo.es');
  });
});
