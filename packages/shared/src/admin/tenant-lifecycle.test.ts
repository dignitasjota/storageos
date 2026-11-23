import { describe, expect, it } from 'vitest';

import {
  companyNameSimilarity,
  isSimilarCompanyName,
  UpdateTenantAddonSchema,
} from './tenant-lifecycle';

describe('nombres de empresa parecidos', () => {
  it('reconoce el mismo negocio escrito de otra forma', () => {
    expect(isSimilarCompanyName('Trasteros Ángel S.L.', 'trasteros angel')).toBe(true);
    expect(isSimilarCompanyName('Trasteros Ana', 'Trasteros Ana Valencia')).toBe(true);
    expect(isSimilarCompanyName('Trastero Garcia', 'Trasteros García')).toBe(true);
  });

  it('no confunde negocios distintos', () => {
    expect(isSimilarCompanyName('Trasteros Ana', 'Guardamuebles Norte')).toBe(false);
    expect(isSimilarCompanyName('Box', 'Boxes del Sur')).toBe(false);
    expect(companyNameSimilarity('', 'algo')).toBe(0);
  });
});

describe('editar un extra asignado', () => {
  it('pide algo que cambiar y una fecha válida', () => {
    expect(UpdateTenantAddonSchema.safeParse({}).success).toBe(false);
    expect(UpdateTenantAddonSchema.safeParse({ nextChargeAt: '2027-02-30x' }).success).toBe(false);
    expect(UpdateTenantAddonSchema.safeParse({ quantity: 2 }).success).toBe(true);
    expect(UpdateTenantAddonSchema.safeParse({ notes: null }).success).toBe(true);
  });
});
