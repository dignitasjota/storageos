import { describe, expect, it } from 'vitest';

import {
  CreateCouponSchema,
  couponSummary,
  publicCouponRejectMessage,
  quoteCoupon,
  type CouponRules,
} from './index';

const base: CouponRules = {
  discountType: 'percentage',
  discountValue: 20,
  minMonths: 1,
  minAmount: null,
  unitTypeIds: [],
  facilityIds: [],
  newCustomersOnly: false,
  maxUses: null,
  usedCount: 0,
  validFrom: null,
  validUntil: null,
  isActive: true,
};

describe('quoteCoupon', () => {
  it('porcentaje sobre todos los meses que se pagan', () => {
    expect(quoteCoupon(base, { monthlyPrice: 50, months: 1 })).toMatchObject({
      valid: true,
      rentSubtotal: 50,
      discountAmount: 10,
      rentTotal: 40,
    });
    expect(quoteCoupon(base, { monthlyPrice: 50, months: 12 })).toMatchObject({
      rentSubtotal: 600,
      discountAmount: 120,
      rentTotal: 480,
    });
  });

  it('importe fijo, sin pasar del alquiler', () => {
    const fixed = { ...base, discountType: 'fixed' as const, discountValue: 30 };
    expect(quoteCoupon(fixed, { monthlyPrice: 50, months: 3 })).toMatchObject({
      discountAmount: 30,
      rentTotal: 120,
    });
    expect(quoteCoupon(fixed, { monthlyPrice: 20, months: 1 })).toMatchObject({
      discountAmount: 20,
      rentTotal: 0,
    });
  });

  it('meses gratis: contrata 3 y paga 2; con 12 sigue siendo 1', () => {
    const free = { ...base, discountType: 'free_months' as const, discountValue: 1, minMonths: 3 };
    expect(quoteCoupon(free, { monthlyPrice: 45.5, months: 3 })).toMatchObject({
      valid: true,
      freeMonths: 1,
      discountAmount: 45.5,
      rentTotal: 91,
    });
    expect(quoteCoupon(free, { monthlyPrice: 45.5, months: 12 })).toMatchObject({ freeMonths: 1 });
    expect(quoteCoupon(free, { monthlyPrice: 45.5, months: 2 })).toMatchObject({
      valid: false,
      reason: 'min_months',
      message: 'Este cupón es a partir de 3 meses pagados por adelantado',
    });
  });

  it('condiciones', () => {
    const t = '00000000-0000-0000-0000-000000000001';
    const f = '00000000-0000-0000-0000-000000000002';
    expect(
      quoteCoupon({ ...base, unitTypeIds: [t] }, { monthlyPrice: 50, months: 1, unitTypeId: 'x' }),
    ).toMatchObject({ valid: false, reason: 'unit_type' });
    expect(
      quoteCoupon({ ...base, unitTypeIds: [t] }, { monthlyPrice: 50, months: 1, unitTypeId: t }),
    ).toMatchObject({ valid: true });
    expect(
      quoteCoupon({ ...base, facilityIds: [f] }, { monthlyPrice: 50, months: 1, facilityId: null }),
    ).toMatchObject({ valid: false, reason: 'facility' });
    expect(quoteCoupon({ ...base, minAmount: 100 }, { monthlyPrice: 50, months: 1 })).toMatchObject(
      { valid: false, reason: 'min_amount' },
    );
    expect(quoteCoupon({ ...base, minAmount: 100 }, { monthlyPrice: 50, months: 2 })).toMatchObject(
      {
        valid: true,
      },
    );
    expect(
      quoteCoupon(
        { ...base, newCustomersOnly: true },
        { monthlyPrice: 50, months: 1, isNewCustomer: false },
      ),
    ).toMatchObject({ valid: false, reason: 'new_customers_only' });
    expect(
      quoteCoupon({ ...base, newCustomersOnly: true }, { monthlyPrice: 50, months: 1 }),
    ).toMatchObject({ valid: true });
  });

  it('fechas, usos y estado', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    expect(
      quoteCoupon({ ...base, isActive: false }, { monthlyPrice: 50, months: 1, now }),
    ).toMatchObject({
      reason: 'inactive',
    });
    expect(
      quoteCoupon(
        { ...base, validFrom: '2026-11-01T00:00:00Z' },
        { monthlyPrice: 50, months: 1, now },
      ),
    ).toMatchObject({ reason: 'not_started' });
    expect(
      quoteCoupon(
        { ...base, validUntil: '2026-10-01T00:00:00Z' },
        { monthlyPrice: 50, months: 1, now },
      ),
    ).toMatchObject({ reason: 'expired' });
    expect(
      quoteCoupon({ ...base, maxUses: 2, usedCount: 2 }, { monthlyPrice: 50, months: 1, now }),
    ).toMatchObject({ reason: 'max_uses_reached' });
    expect(quoteCoupon(base, { monthlyPrice: 50, months: 13, now })).toMatchObject({
      reason: 'invalid_months',
    });
  });
});

describe('CreateCouponSchema', () => {
  it('meses gratis: el mínimo de meses debe superar a los regalados', () => {
    const r = CreateCouponSchema.safeParse({
      code: 'tres-por-dos',
      name: 'Tres por dos',
      discountType: 'free_months',
      discountValue: 1,
      minMonths: 1,
    });
    expect(r.success).toBe(false);
    const ok = CreateCouponSchema.parse({
      code: 'tres-por-dos',
      name: 'Tres por dos',
      discountType: 'free_months',
      discountValue: 1,
      minMonths: 3,
    });
    expect(ok.code).toBe('TRES-POR-DOS');
    expect(ok.unitTypeIds).toEqual([]);
  });

  it('resumen', () => {
    expect(couponSummary({ discountType: 'free_months', discountValue: 1, minMonths: 3 })).toBe(
      '1 mes gratis desde 3 meses',
    );
    expect(couponSummary({ discountType: 'percentage', discountValue: 15, minMonths: 1 })).toBe(
      '15 %',
    );
  });
});

describe('un uso por cliente', () => {
  it('rechaza si el cliente ya lo usó', () => {
    const rules = {
      discountType: 'percentage' as const,
      discountValue: 10,
      minMonths: 1,
      minAmount: null,
      unitTypeIds: [],
      facilityIds: [],
      newCustomersOnly: false,
      oncePerCustomer: true,
      maxUses: null,
      usedCount: 3,
      validFrom: null,
      validUntil: null,
      isActive: true,
    };
    const used = quoteCoupon(rules, { monthlyPrice: 50, months: 1, usedByCustomer: true });
    expect(used.valid).toBe(false);
    if (!used.valid) expect(used.reason).toBe('already_used');
    expect(quoteCoupon(rules, { monthlyPrice: 50, months: 1, usedByCustomer: false }).valid).toBe(
      true,
    );
  });

  it('en la web pública no dice si un código existe', () => {
    expect(publicCouponRejectMessage('not_found', 'Este cupón no existe')).toBe(
      'Este cupón no es válido',
    );
    expect(publicCouponRejectMessage('expired', 'Este cupón ha caducado')).toBe(
      'Este cupón no es válido',
    );
    expect(publicCouponRejectMessage('min_months', 'A partir de 3 meses')).toBe(
      'A partir de 3 meses',
    );
  });
});
