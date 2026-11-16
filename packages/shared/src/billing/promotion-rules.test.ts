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
