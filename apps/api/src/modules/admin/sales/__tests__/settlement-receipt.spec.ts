import { renderSettlementReceipt } from '../settlement-receipt';

describe('renderSettlementReceipt', () => {
  const base = {
    repName: 'Ana <Comercial>',
    repEmail: 'ana@example.com',
    month: '2026-10',
    total: 155,
    paidAt: new Date('2026-11-02T10:00:00Z'),
    paidByName: 'Dirección',
    receivedAt: null,
    receivedNote: null,
    note: null,
    items: [
      {
        month: '2026-10',
        tenantName: 'Trasteros Sur',
        kind: 'sale',
        description: 'Venta',
        amount: 50,
      },
      { month: '2026-10', tenantName: null, kind: 'bonus', description: 'Objetivo', amount: 105 },
    ],
  };

  it('lleva el comercial, cada partida, el total y la forma de pago', () => {
    const html = renderSettlementReceipt(base);
    expect(html).toContain('Ana &lt;Comercial&gt;');
    expect(html).toContain('Octubre de 2026');
    expect(html).toContain('Trasteros Sur');
    expect(html).toContain('Bonus por objetivo');
    expect(html).toContain('155,00 €');
    expect(html).toContain('efectivo');
    expect(html).toContain('Pendiente de que el comercial confirme');
  });

  it('dice cuándo lo recibió el comercial', () => {
    const html = renderSettlementReceipt({
      ...base,
      receivedAt: new Date('2026-11-03T09:30:00Z'),
      receivedNote: 'Todo correcto',
    });
    expect(html).toContain('Recibido por el comercial');
    expect(html).toContain('03/11/2026');
    expect(html).toContain('Todo correcto');
  });
});
