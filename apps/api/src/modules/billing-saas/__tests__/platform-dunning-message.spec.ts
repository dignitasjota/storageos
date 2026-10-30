import { dunningMessage } from '../platform-dunning-message';

const base = {
  tenantName: 'Trasteros <García>',
  planName: 'Starter',
  amount: 237,
  periods: 3,
  since: new Date('2026-08-01T10:00:00Z'),
  daysOverdue: 75,
  billingMode: 'manual',
  sepaBounced: false,
  cardError: null,
  suspended: false,
  link: 'https://trasteros.pro/settings/saas-billing',
};

describe('dunningMessage', () => {
  it('lleva el importe con las cuotas, cómo pagar y escapa el nombre', () => {
    const m = dunningMessage(base);
    expect(m.subject).toContain('237,00');
    expect(m.text).toContain('3 cuotas');
    expect(m.text).toContain('transferencia');
    expect(m.html).toContain('Trasteros &lt;García&gt;');
    expect(m.html).not.toContain('<García>');
  });

  it('adapta el texto a la forma de cobro y a la suspensión', () => {
    expect(dunningMessage({ ...base, billingMode: 'sepa', sepaBounced: true }).text).toContain(
      'devuelto el adeudo',
    );
    expect(
      dunningMessage({ ...base, billingMode: 'redsys', cardError: 'Denegada' }).text,
    ).toContain('Denegada');
    expect(dunningMessage({ ...base, billingMode: 'stripe' }).text).toContain(
      'Gestionar suscripción',
    );
    const s = dunningMessage({ ...base, suspended: true });
    expect(s.subject).toContain('suspendida');
    expect(s.html).toContain('Pagar y reactivar');
  });
});
