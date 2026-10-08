import { monthsInPeriod, ownerFee, renderStatementEmail } from '../owner-statements.service';

import type { OwnerStatementDto } from '@storageos/shared';

describe('liquidación al propietario', () => {
  it('cuenta los meses naturales del periodo', () => {
    expect(monthsInPeriod('2026-10-01', '2026-10-31')).toBe(1);
    expect(monthsInPeriod('2026-10-01', '2026-12-31')).toBe(3);
    expect(monthsInPeriod('2026-12-15', '2027-01-10')).toBe(2);
  });

  it('honorarios: % de lo cobrado o cuota fija, con IVA del 21 %', () => {
    expect(ownerFee('percentage', 8, 1000, 1)).toEqual({ base: 80, vat: 16.8 });
    expect(ownerFee('percentage', 8, -50, 1)).toEqual({ base: 0, vat: 0 });
    expect(ownerFee('fixed', 50, 1000, 3)).toEqual({ base: 150, vat: 31.5 });
  });

  it('el correo escapa los datos y muestra lo que se transfiere', () => {
    const s = {
      ownerName: 'Pérez & <Hijos>',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      collected: 1000,
      refunded: 0,
      feeType: 'percentage',
      feeValue: 8,
      feeBase: 80,
      feeVat: 16.8,
      expenses: 100,
      withholding: 0,
      net: 803.2,
      pending: 0,
      ownerIbanLast4: '1332',
      payments: [],
      expenseLines: [],
    } as unknown as OwnerStatementDto;
    const mail = renderStatementEmail(s, 'Gestiones SL');
    expect(mail.subject).toBe('Liquidación 01/10/2026 – 31/10/2026 — Gestiones SL');
    expect(mail.html).toContain('Pérez &amp; &lt;Hijos&gt;');
    expect(mail.html).not.toContain('<Hijos>');
    expect(mail.text).toContain('A transferir: 803,20');
    expect(mail.text).toContain('terminada en 1332');
  });
});
