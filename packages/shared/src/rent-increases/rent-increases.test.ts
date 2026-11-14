import { describe, expect, it } from 'vitest';

import {
  CreateRentIncreaseSchema,
  earliestRentIncreaseDate,
  fillRentIncreaseNotice,
  isFirstOfMonth,
  RENT_INCREASE_NOTICE_DEFAULTS,
  RentIncreaseNoticeTemplateSchema,
} from './index';

describe('subidas de precio', () => {
  it('solo admite días 1 reales', () => {
    expect(isFirstOfMonth('2027-03-01')).toBe(true);
    expect(isFirstOfMonth('2027-03-02')).toBe(false);
    expect(isFirstOfMonth('2027-02-31')).toBe(false);
  });

  it('el primer día 1 posible respeta el preaviso', () => {
    expect(earliestRentIncreaseDate('2027-01-15', 30)).toBe('2027-03-01');
    expect(earliestRentIncreaseDate('2027-01-30', 2)).toBe('2027-02-01');
  });

  it('«hasta la tarifa» se limita como un porcentaje', () => {
    const base = {
      name: 'Tarifa 2027',
      increaseType: 'to_list_price' as const,
      effectiveDate: '2027-03-01',
      scope: { minMonthsSinceSigned: 0 },
    };
    expect(CreateRentIncreaseSchema.safeParse({ ...base, increaseValue: 15 }).success).toBe(true);
    expect(CreateRentIncreaseSchema.safeParse({ ...base, increaseValue: 150 }).success).toBe(false);
  });

  it('rellena las variables del aviso y deja las desconocidas', () => {
    const text = fillRentIncreaseNotice('Hola {nombre}: desde el {fecha} pagas {cuota_nueva} {x}', {
      nombre: 'Lucía',
      fecha: '1 de marzo de 2027',
      cuota_nueva: '72,60 €',
    });
    expect(text).toBe('Hola Lucía: desde el 1 de marzo de 2027 pagas 72,60 € {x}');
  });

  it('el texto de serie es una plantilla válida', () => {
    expect(RentIncreaseNoticeTemplateSchema.safeParse(RENT_INCREASE_NOTICE_DEFAULTS).success).toBe(
      true,
    );
    expect(
      RentIncreaseNoticeTemplateSchema.safeParse({ es: { subject: 'x', body: 'corto' } }).success,
    ).toBe(false);
  });
});
