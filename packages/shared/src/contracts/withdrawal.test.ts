import { describe, expect, it } from 'vitest';

import {
  needsImmediateStartRequest,
  withdrawalDeadline,
  withdrawalKeptCents,
  withdrawalUsedDays,
} from './withdrawal';

describe('desistimiento', () => {
  it('el plazo son 14 días naturales a partir del día siguiente a la firma', () => {
    expect(withdrawalDeadline('2026-11-11')).toBe('2026-11-25');
    expect(withdrawalDeadline('2026-12-20')).toBe('2027-01-03');
  });

  it('hay que pedir empezar ya si el alquiler empieza dentro del plazo', () => {
    expect(needsImmediateStartRequest({ startDate: '2026-11-11', signedOn: '2026-11-11' })).toBe(
      true,
    );
    expect(needsImmediateStartRequest({ startDate: '2026-11-25', signedOn: '2026-11-11' })).toBe(
      true,
    );
    expect(needsImmediateStartRequest({ startDate: '2026-11-26', signedOn: '2026-11-11' })).toBe(
      false,
    );
  });

  it('cuenta los días usados, el del aviso incluido', () => {
    expect(withdrawalUsedDays({ startDate: '2026-11-11', communicatedOn: '2026-11-11' })).toBe(1);
    expect(withdrawalUsedDays({ startDate: '2026-11-11', communicatedOn: '2026-11-15' })).toBe(5);
    expect(withdrawalUsedDays({ startDate: '2026-11-20', communicatedOn: '2026-11-15' })).toBe(0);
  });

  it('se queda la parte de los días usados solo si pidió empezar ya', () => {
    // Del 11 al 30 de noviembre (20 días) por 100 €; desiste el 15: 5 días.
    const base = {
      paidCents: 10_000,
      periodStart: '2026-11-11',
      periodEnd: '2026-11-30',
      startDate: '2026-11-11',
      communicatedOn: '2026-11-15',
    };
    expect(withdrawalKeptCents({ ...base, immediateStartRequested: true })).toBe(2_500);
    expect(withdrawalKeptCents({ ...base, immediateStartRequested: false })).toBe(0);
  });

  it('en un pago de varios meses solo cuentan los días usados dentro de ese periodo', () => {
    // Tres meses por 180 € (92 días); desiste a los 10 días.
    expect(
      withdrawalKeptCents({
        paidCents: 18_000,
        periodStart: '2026-11-01',
        periodEnd: '2027-01-31',
        startDate: '2026-11-01',
        communicatedOn: '2026-11-10',
        immediateStartRequested: true,
      }),
    ).toBe(Math.round((18_000 * 10) / 92));
    // Una factura de un periodo que aún no había empezado: nada.
    expect(
      withdrawalKeptCents({
        paidCents: 5_000,
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        startDate: '2026-11-20',
        communicatedOn: '2026-11-25',
        immediateStartRequested: true,
      }),
    ).toBe(0);
  });
});
