import { renderCashClosureHtml, type CashClosurePdfData } from '../cash-closure-template';

import type { CashClosureDto } from '@storageos/shared';

const closure = (over: Partial<CashClosureDto> = {}): CashClosureDto => ({
  id: 'c1',
  date: '2026-11-10',
  facilityId: null,
  facilityName: null,
  expectedCash: 170,
  countedCash: 165,
  difference: -5,
  notes: 'Faltan <5> €',
  closedByName: 'Ana',
  closedAt: '2026-11-10T19:00:00.000Z',
  reopenedAt: null,
  reopenedByName: null,
  reopenReason: null,
  denominations: { '5000': 3, '500': 3 },
  breakdown: {
    cashIn: 121,
    cashRefunds: 21,
    depositReturnsCash: 0,
    movementsIn: 100,
    movementsOut: 30,
    byMethod: { cash: 121, card: 40, sepaDebit: 0, bankTransfer: 0, bizum: 0, other: 0 },
    movements: [
      { kind: 'opening_float', amount: 100, notes: null },
      { kind: 'bank_withdrawal', amount: 30, notes: 'Ingreso' },
    ],
  },
  ...over,
});

const data = (c: CashClosureDto): CashClosurePdfData => ({
  businessName: 'Trasteros García',
  facilityName: c.facilityName,
  dateLabel: '10 de noviembre de 2026',
  closedAtLabel: '10/11/2026, 20:00',
  reopenedAtLabel: null,
  closure: c,
});

/** Normaliza el espacio duro de los importes («121,00 €»). */
const text = (html: string) => html.replace(/\u00a0/g, ' ');

describe('renderCashClosureHtml', () => {
  it('desglosa el esperado, el recuento y deja sitio para las firmas', () => {
    const html = text(renderCashClosureHtml(data(closure())));
    expect(html).toContain('Trasteros García · Toda la empresa');
    expect(html).toContain('10 de noviembre de 2026');
    expect(html).toContain('Cobros en efectivo');
    expect(html).toContain('Devoluciones en efectivo');
    expect(html).toContain('Fondo de apertura');
    expect(html).toContain('Retirada al banco (Ingreso)');
    expect(html).toContain('-30,00 €');
    expect(html).toContain('170,00 €');
    // Recuento: 3 × 50 € y 3 × 5 €.
    expect(html).toContain('50 €');
    expect(html).toContain('150,00 €');
    expect(html).toContain('15,00 €');
    expect(html).toContain('Total contado');
    // Tarjeta sí (hay importe), Bizum no.
    expect(html).toContain('Tarjeta');
    expect(html).not.toContain('Bizum');
    expect(html).toContain('Firma de quien cierra la caja');
    // Lo que escribe el usuario va escapado.
    expect(html).toContain('Faltan &lt;5&gt; €');
  });

  it('sin recuento por billetes no pinta la tabla; un cierre reabierto lo dice', () => {
    const html = text(
      renderCashClosureHtml({
        ...data(
          closure({
            denominations: null,
            reopenedAt: '2026-11-11T09:00:00.000Z',
            reopenedByName: 'Luis',
            reopenReason: 'Faltaba un cobro',
          }),
        ),
        reopenedAtLabel: '11/11/2026, 10:00',
      }),
    );
    expect(html).not.toContain('Total contado');
    expect(html).toContain('se reabrió el 11/11/2026, 10:00 por Luis: Faltaba un cobro');
  });
});
