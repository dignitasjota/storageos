import { describe, expect, it } from 'vitest';

import { productUpdateCategoryFromSlug, productUpdateTargets } from './index';

describe('productUpdateTargets', () => {
  it('sin destinatarios le toca a todos', () => {
    expect(productUpdateTargets({ targetPlans: [], targetRoles: [] }, null, 'staff')).toBe(true);
  });

  it('filtra por plan y por rol a la vez', () => {
    const u = { targetPlans: ['pro'], targetRoles: ['owner', 'manager'] };
    expect(productUpdateTargets(u, 'pro', 'owner')).toBe(true);
    expect(productUpdateTargets(u, 'starter', 'owner')).toBe(false);
    expect(productUpdateTargets(u, 'pro', 'staff')).toBe(false);
    expect(productUpdateTargets(u, null, 'owner')).toBe(false);
  });
});

describe('productUpdateCategoryFromSlug', () => {
  it('traduce el tipo de la dirección', () => {
    expect(productUpdateCategoryFromSlug('mejora')).toBe('improvement');
    expect(productUpdateCategoryFromSlug('correccion')).toBe('fix');
    expect(productUpdateCategoryFromSlug('otra')).toBeNull();
    expect(productUpdateCategoryFromSlug(null)).toBeNull();
  });
});
