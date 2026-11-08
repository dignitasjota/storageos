import { verifactuLockedUntil } from '../verifactu-settings.service';

describe('verifactuLockedUntil', () => {
  it('hasta el 31 de diciembre del año en que se activó', () => {
    expect(verifactuLockedUntil(new Date('2026-11-08T10:00:00Z'), 'Europe/Madrid')).toBe(
      '2026-12-31',
    );
  });

  it('el año es el de la hora del negocio, no el de UTC', () => {
    // 31-12-2026 a las 23:30 UTC ya es 1 de enero de 2027 en Madrid.
    expect(verifactuLockedUntil(new Date('2026-12-31T23:30:00Z'), 'Europe/Madrid')).toBe(
      '2027-12-31',
    );
    // Y en Canarias (UTC+0 en invierno) sigue siendo 2026.
    expect(verifactuLockedUntil(new Date('2026-12-31T23:30:00Z'), 'Atlantic/Canary')).toBe(
      '2026-12-31',
    );
  });
});
