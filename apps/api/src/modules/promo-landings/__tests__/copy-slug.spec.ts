import { copySlug } from '../promo-landings.service';

describe('copySlug', () => {
  it('añade -copia y -copia-N', () => {
    expect(copySlug('verano', 1)).toBe('verano-copia');
    expect(copySlug('verano', 3)).toBe('verano-copia-3');
  });

  it('una dirección larga se recorta antes del sufijo y cabe en 60 caracteres', () => {
    const base = 'a'.repeat(58);
    for (const n of [1, 2, 10, 123]) {
      const slug = copySlug(base, n);
      expect(slug.length).toBeLessThanOrEqual(60);
      expect(slug.endsWith(n === 1 ? '-copia' : `-copia-${n}`)).toBe(true);
    }
    // Sin guion doble si el corte cae en un guion.
    expect(copySlug(`${'b'.repeat(53)}-xyz`, 1)).not.toContain('--');
  });
});
