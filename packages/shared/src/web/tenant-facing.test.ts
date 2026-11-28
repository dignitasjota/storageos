import { describe, expect, it } from 'vitest';

import { isTenantFacingPath } from './tenant-facing';

describe('isTenantFacingPath', () => {
  it.each([
    '/s/mislata',
    '/s/mislata/precios',
    '/book/mislata',
    '/reservar/x',
    '/portal/login',
    '/sign/abc',
    '/g/ABC',
  ])('es de cara al cliente de un negocio: %s', (path) => {
    expect(isTenantFacingPath(path)).toBe(true);
  });

  it.each(['/', '/precios', '/login', '/dashboard', '/sign-up', '/portal-info', '/gestion'])(
    'es de la plataforma: %s',
    (path) => {
      expect(isTenantFacingPath(path)).toBe(false);
    },
  );
});
