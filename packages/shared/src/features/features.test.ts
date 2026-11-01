import { describe, expect, it } from 'vitest';

import { PLAN_FEATURES, featuresForPlan, resolvePlanFeatures } from './index';

describe('resolvePlanFeatures', () => {
  it('usa las funciones guardadas en el plan', () => {
    expect(resolvePlanFeatures({ slug: 'basico', tenantFeatures: ['sepa'] })).toEqual(['sepa']);
  });

  it('un plan creado desde el panel sin funciones no tiene ninguna premium', () => {
    expect(resolvePlanFeatures({ slug: 'basico', tenantFeatures: [] })).toEqual([]);
    expect(featuresForPlan('basico')).toEqual([]);
  });

  it('un plan sembrado sin lista usa el mapa en código', () => {
    expect(resolvePlanFeatures({ slug: 'pro', tenantFeatures: [] })).toEqual(PLAN_FEATURES.pro);
  });

  it('nunca da las funciones que solo se venden como extra', () => {
    const all = resolvePlanFeatures({ slug: 'desconocido' });
    expect(all).not.toContain('facial_access');
    expect(all).not.toContain('web_premium');
  });
});
