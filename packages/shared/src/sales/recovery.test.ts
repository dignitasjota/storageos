import { describe, expect, it } from 'vitest';

import {
  addMonthsToIsoDate,
  parseRecoverMonths,
  proposeRecoverOn,
  SALES_RECOVER_MONTHS_DEFAULT,
  SalesArchiveLeadSchema,
  UpdateSalesArchiveSchema,
} from './recovery';

describe('recuperación de archivados', () => {
  it('suma meses sin pasarse del último día del mes', () => {
    expect(addMonthsToIsoDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToIsoDate('2026-11-24', 3)).toBe('2027-02-24');
    expect(addMonthsToIsoDate('2027-02-28', 12)).toBe('2028-02-28');
  });

  it('propone la fecha según el motivo', () => {
    expect(proposeRecoverOn('2026-11-24', 'not_now')).toBe('2027-05-24');
    expect(proposeRecoverOn('2026-11-24', 'price')).toBe('2027-11-24');
    expect(proposeRecoverOn('2026-11-24', 'no_response')).toBe('2027-02-24');
    expect(proposeRecoverOn('2026-11-24', 'missing_feature')).toBe('2027-11-24');
    expect(proposeRecoverOn('2026-11-24', 'not_now', { not_now: 2 })).toBe('2027-01-24');
  });

  it('completa los meses guardados con los de la base', () => {
    expect(parseRecoverMonths(null)).toEqual(SALES_RECOVER_MONTHS_DEFAULT);
    const parsed = parseRecoverMonths({ not_now: 4, price: 0, competitor: 'x', other: 40 });
    expect(parsed.not_now).toBe(4);
    expect(parsed.price).toBe(SALES_RECOVER_MONTHS_DEFAULT.price);
    expect(parsed.competitor).toBe(SALES_RECOVER_MONTHS_DEFAULT.competitor);
    expect(parsed.other).toBe(SALES_RECOVER_MONTHS_DEFAULT.other);
  });

  it('valida el «No interesado» y su edición', () => {
    expect(SalesArchiveLeadSchema.safeParse({ reasonCode: 'price' }).success).toBe(true);
    expect(SalesArchiveLeadSchema.safeParse({ reasonCode: 'churned' }).success).toBe(false);
    expect(
      SalesArchiveLeadSchema.safeParse({ reasonCode: 'price', recoverOn: '24/11/2027' }).success,
    ).toBe(false);
    expect(UpdateSalesArchiveSchema.safeParse({}).success).toBe(false);
    expect(UpdateSalesArchiveSchema.safeParse({ doNotContact: true }).success).toBe(true);
  });
});
