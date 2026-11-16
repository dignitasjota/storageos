import { commissionBase, splitPaymentForCommission } from '../commission-split';

const addons = [
  { addonId: 'a1', name: 'IA ampliada', monthly: 15, billingMode: 'manual' },
  { addonId: 'a2', name: 'Dominio propio', monthly: 15, billingMode: 'stripe' },
];

describe('splitPaymentForCommission', () => {
  it('pago a mano del plan: todo es del plan, sin IVA', () => {
    const r = splitPaymentForCommission({
      gross: 121,
      refunded: 0,
      taxRate: 21,
      provider: 'manual',
      description: null,
      lines: [],
      planMonthly: 79,
      addons,
    });
    expect(r).toEqual({ planNet: 100, addons: [] });
  });

  it('un cobro «Add-on: X» es todo de ese extra', () => {
    const r = splitPaymentForCommission({
      gross: 18.15,
      refunded: 0,
      taxRate: 21,
      provider: 'manual',
      description: 'Add-on: IA ampliada',
      lines: [],
      planMonthly: 79,
      addons,
    });
    expect(r.planNet).toBe(0);
    expect(r.addons).toEqual([{ addonId: 'a1', net: 15 }]);
  });

  it('remesa SEPA: reparte plan y extras que no van por Stripe según su precio', () => {
    const r = splitPaymentForCommission({
      gross: 113.74,
      refunded: 0,
      taxRate: 21,
      provider: 'sepa',
      description: 'Remesa SEPA plataforma',
      lines: [],
      planMonthly: 79,
      addons,
    });
    // 94 € de base: 79 de plan y 15 del extra a mano (el de Stripe no va en la remesa).
    expect(r.planNet).toBeCloseTo(79, 1);
    expect(r.addons).toEqual([{ addonId: 'a1', net: expect.closeTo(15, 1) }]);
  });

  it('con el desglose de la factura usa sus líneas y descuenta lo devuelto', () => {
    const r = splitPaymentForCommission({
      gross: 114,
      refunded: 57,
      taxRate: 0,
      provider: 'stripe',
      description: null,
      lines: [
        { kind: 'plan', description: 'Starter', total: 79 },
        { kind: 'addon', description: 'Dominio propio', total: 15 },
        { kind: 'adjustment', description: 'Ajuste', total: 20 },
      ],
      planMonthly: 79,
      addons,
    });
    expect(r.planNet).toBeCloseTo(49.5, 2);
    expect(r.addons).toEqual([{ addonId: 'a2', net: 7.5 }]);
  });

  it('la base solo suma los extras aprobados', () => {
    const split = {
      planNet: 100,
      addons: [
        { addonId: 'a1', net: 15 },
        { addonId: 'a2', net: 15 },
      ],
    };
    expect(commissionBase(split, new Set())).toBe(100);
    expect(commissionBase(split, new Set(['a2']))).toBe(115);
  });

  it('sin importe no hay base', () => {
    const r = splitPaymentForCommission({
      gross: 0,
      refunded: 0,
      taxRate: 21,
      provider: 'manual',
      description: null,
      lines: [],
      planMonthly: 79,
      addons,
    });
    expect(r).toEqual({ planNet: 0, addons: [] });
  });
});
