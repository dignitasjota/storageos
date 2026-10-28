import { describe, expect, it } from 'vitest';

import { addMonthsYmd, preOpeningCancelOutcome } from './pre-opening';

describe('preOpeningCancelOutcome', () => {
  const base = { signedOn: '2026-11-01', deadline: '2027-05-01', started: false };

  it('dentro de los 14 días devuelve todo', () => {
    expect(preOpeningCancelOutcome({ ...base, today: '2026-11-15' })).toMatchObject({
      reason: 'withdrawal',
      refundRent: true,
      refundDeposit: true,
      withdrawalEndsOn: '2026-11-15',
    });
  });

  it('después retiene la fianza y devuelve la mensualidad', () => {
    expect(preOpeningCancelOutcome({ ...base, today: '2026-11-16' })).toMatchObject({
      reason: 'standard',
      refundRent: true,
      refundDeposit: false,
    });
  });

  it('pasada la fecha límite sin abrir devuelve todo', () => {
    expect(preOpeningCancelOutcome({ ...base, today: '2027-05-02' })).toMatchObject({
      reason: 'not_opened_in_time',
      refundDeposit: true,
    });
  });

  it('una vez empezado no es una cancelación de reserva', () => {
    expect(preOpeningCancelOutcome({ ...base, today: '2026-11-02', started: true }).allowed).toBe(
      false,
    );
  });

  it('suma meses ajustando a fin de mes', () => {
    expect(addMonthsYmd('2026-08-31', 6)).toBe('2027-02-28');
  });
});
