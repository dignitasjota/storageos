import { describe, expect, it } from 'vitest';

import {
  medianHours,
  supportCategoryLabel,
  supportResponseTimeText,
  UpdateServiceStatusSchema,
} from './support';

describe('soporte del tenant', () => {
  it('pone nombre a las categorías y deja las antiguas tal cual', () => {
    expect(supportCategoryLabel('billing')).toBe('Facturación y cobros');
    expect(supportCategoryLabel('custom_domain')).toBe('Dominio propio');
    expect(supportCategoryLabel('Facturas raras')).toBe('Facturas raras');
    expect(supportCategoryLabel('')).toBeNull();
    expect(supportCategoryLabel(null)).toBeNull();
  });

  it('dice el plazo de respuesta en palabras', () => {
    expect(supportResponseTimeText(0.4)).toBe('Solemos responder en menos de una hora');
    expect(supportResponseTimeText(1.2)).toBe('Solemos responder en una hora más o menos');
    expect(supportResponseTimeText(8)).toBe('Solemos responder en unas 8 horas');
    expect(supportResponseTimeText(48)).toBe('Solemos responder en unos 2 días');
  });

  it('calcula la mediana en horas', () => {
    expect(medianHours([])).toBeNull();
    expect(medianHours([60])).toBe(1);
    expect(medianHours([30, 90, 600])).toBe(1.5);
    expect(medianHours([60, 120, 180, 240])).toBe(2.5);
  });

  it('exige un mensaje para publicar una incidencia', () => {
    expect(UpdateServiceStatusSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(UpdateServiceStatusSchema.safeParse({ status: 'incident', message: '' }).success).toBe(
      false,
    );
    expect(
      UpdateServiceStatusSchema.safeParse({ status: 'degraded', message: 'Va lento' }).success,
    ).toBe(true);
  });
});
