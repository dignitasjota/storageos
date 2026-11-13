import {
  accountantReportKey,
  buildAccountantReportToken,
  readAccountantReportToken,
} from '../../../common/accountant-report-token';
import { quarterOf } from '../../../common/fiscal-closure';
import { duePeriod } from '../accountant-report.service';
import { numberingGaps } from '../fiscal-periods.service';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('duePeriod (envío a la asesoría)', () => {
  it('cada mes, el anterior desde el día 5', () => {
    expect(duePeriod('monthly', d('2026-11-04'))).toBeNull();
    expect(duePeriod('monthly', d('2026-11-05'))).toMatchObject({
      key: '2026-10',
      from: '2026-10-01',
      to: '2026-10-31',
      label: 'octubre de 2026',
    });
    expect(duePeriod('monthly', d('2027-01-20'))?.key).toBe('2026-12');
  });

  it('cada trimestre, solo en el primer mes del siguiente', () => {
    expect(duePeriod('quarterly', d('2026-10-05'))).toMatchObject({
      key: '2026-T3',
      from: '2026-07-01',
      to: '2026-09-30',
      label: 'tercer trimestre de 2026',
    });
    expect(duePeriod('quarterly', d('2026-11-05'))).toBeNull();
    expect(duePeriod('quarterly', d('2027-01-06'))?.key).toBe('2026-T4');
    expect(duePeriod('off', d('2026-10-05'))).toBeNull();
  });
});

describe('enlace del Excel de la asesoría', () => {
  const key = accountantReportKey('clave-maestra-de-prueba');
  const tenant = '0190f0a0-0000-7000-8000-000000000001';

  it('lleva el tenant y el fichero, y caduca', () => {
    const later = new Date(Date.now() + 60_000);
    const token = buildAccountantReportToken(key, tenant, 'asesoria-2026-10.xlsx', later);
    expect(readAccountantReportToken(key, token)).toEqual({
      tenantId: tenant,
      fileName: 'asesoria-2026-10.xlsx',
    });
    expect(readAccountantReportToken(key, token, new Date(later.getTime() + 1))).toBeNull();
  });

  it('no vale con otra clave ni tocado', () => {
    const token = buildAccountantReportToken(key, tenant, 'a.xlsx', new Date(Date.now() + 60_000));
    expect(readAccountantReportToken(accountantReportKey('otra'), token)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(`${tenant}|../b.xlsx|${Date.now() + 60_000}`).toString('base64url');
    expect(readAccountantReportToken(key, `${forged}.${sig}`)).toBeNull();
    expect(readAccountantReportToken(key, `${payload}.${sig}x`)).toBeNull();
  });
});

describe('numeración y trimestres', () => {
  it('encuentra los huecos', () => {
    expect(numberingGaps([1, 2, 3])).toEqual([]);
    expect(numberingGaps([1, 3, 4, 8])).toEqual(['2', '5-7']);
  });

  it('trimestre de una fecha', () => {
    expect(quarterOf(d('2026-03-31'))).toEqual({ year: 2026, quarter: 1 });
    expect(quarterOf(d('2026-10-01'))).toEqual({ year: 2026, quarter: 4 });
  });
});
