import { describe, expect, it } from 'vitest';

import {
  PLAN_FEATURES,
  effectiveFeaturesFromList,
  featuresForPlan,
  resolvePlanFeatures,
} from './index';

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

describe('effectiveFeaturesFromList', () => {
  it('aplica los overrides sobre el plan', () => {
    expect(
      effectiveFeaturesFromList(
        ['sepa', 'insurance'],
        [
          { feature: 'insurance', enabled: false },
          { feature: 'cameras', enabled: true },
        ],
      ).sort(),
    ).toEqual(['cameras', 'sepa']);
  });

  it('SEO Avanzado incluye SEO local, aunque un override lo quite', () => {
    const withExtra = effectiveFeaturesFromList([], [{ feature: 'seo_advanced', enabled: true }]);
    expect(withExtra).toContain('local_seo');
    const forced = effectiveFeaturesFromList(
      ['local_seo'],
      [
        { feature: 'local_seo', enabled: false },
        { feature: 'seo_advanced', enabled: true },
      ],
    );
    expect(forced).toContain('local_seo');
    expect(effectiveFeaturesFromList(['local_seo'], [])).not.toContain('seo_advanced');
  });

  it('ningún plan trae SEO Avanzado', () => {
    for (const list of Object.values(PLAN_FEATURES)) expect(list).not.toContain('seo_advanced');
    expect(resolvePlanFeatures({ slug: 'desconocido' })).not.toContain('seo_advanced');
  });
});
