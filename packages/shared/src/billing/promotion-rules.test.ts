import { describe, expect, it } from 'vitest';

import { CreatePromotionSchema, promotionRuleIssues } from './schemas';

describe('promotionRuleIssues', () => {
  it('acepta una promoción normal', () => {
    expect(promotionRuleIssues({ discountType: 'percentage', discountValue: 20 })).toEqual([]);
    expect(promotionRuleIssues({ discountType: 'fixed', discountValue: 150 })).toEqual([]);
    expect(promotionRuleIssues({ discountType: 'free_months', discountValue: 2 })).toEqual([]);
  });

  it('rechaza un porcentaje de más de 100 y los meses gratis con decimales', () => {
    expect(promotionRuleIssues({ discountType: 'percentage', discountValue: 150 })[0]?.path).toBe(
      'discountValue',
    );
    expect(promotionRuleIssues({ discountType: 'free_months', discountValue: 1.5 })[0]?.path).toBe(
      'discountValue',
    );
  });

  it('la fecha de fin va después de la de inicio', () => {
    const issues = promotionRuleIssues({
      discountType: 'percentage',
      discountValue: 10,
      validFrom: '2026-12-31T00:00:00.000Z',
      validUntil: '2026-01-01T00:00:00.000Z',
    });
    expect(issues[0]?.path).toBe('validUntil');
  });

  it('los meses gratis no llevan duración; un descuento sí', () => {
    expect(
      promotionRuleIssues({ discountType: 'free_months', discountValue: 2, durationMonths: 3 })[0]
        ?.path,
    ).toBe('durationMonths');
    expect(
      promotionRuleIssues({ discountType: 'percentage', discountValue: 20, durationMonths: 3 }),
    ).toEqual([]);
    const created = CreatePromotionSchema.safeParse({
      code: 'tresmeses',
      name: 'Tres meses',
      discountType: 'fixed',
      discountValue: 10,
      durationMonths: 3,
    });
    expect(created.success && created.data.durationMonths).toBe(3);
    // Sin condiciones: todo el contrato, todos los trasteros y cualquier cliente.
    const plain = CreatePromotionSchema.safeParse({
      code: 'siempre',
      name: 'Siempre',
      discountType: 'percentage',
      discountValue: 5,
    });
    expect(plain.success && plain.data).toMatchObject({
      durationMonths: null,
      unitTypeIds: [],
      facilityIds: [],
      newCustomersOnly: false,
      oncePerCustomer: false,
    });
  });

  it('el alta aplica las mismas reglas y no anuncia en la web por defecto', () => {
    const ok = CreatePromotionSchema.safeParse({
      code: 'verano20',
      name: 'Verano',
      discountType: 'percentage',
      discountValue: 20,
    });
    expect(ok.success && ok.data.code).toBe('VERANO20');
    expect(ok.success && ok.data.announceOnWeb).toBe(false);
    expect(
      CreatePromotionSchema.safeParse({
        code: 'MAL',
        name: 'Mal',
        discountType: 'percentage',
        discountValue: 120,
      }).success,
    ).toBe(false);
  });
});
