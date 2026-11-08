import { ownerInstallationNumber, verifactuInstallationNumber } from '../verifactu-installation';
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

describe('número de instalación', () => {
  it('la fecha y hora de la activación (UTC) y el principio del id del negocio', () => {
    expect(
      verifactuInstallationNumber(
        new Date('2026-11-08T15:30:07.123Z'),
        '01a1bb39-7e35-75b9-b347-7a0eae15d982',
      ),
    ).toBe('20261108153007-01a1bb39');
  });

  it('otra activación, otro número; cada propietario, el suyo', () => {
    const id = '01a1bb39-7e35-75b9-b347-7a0eae15d982';
    const first = verifactuInstallationNumber(new Date('2026-11-08T15:30:07Z'), id);
    const again = verifactuInstallationNumber(new Date('2027-01-02T09:00:00Z'), id);
    expect(again).not.toBe(first);
    expect(ownerInstallationNumber(first, '7e35a2b1-0000-0000-0000-000000000000')).toBe(
      '20261108153007-01a1bb39-7e35a2b1',
    );
  });
});
