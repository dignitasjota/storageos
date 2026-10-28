import { describe, expect, it } from 'vitest';

import { Permissions, ROLE_TEMPLATES, summarizePermissions } from './permissions';

describe('plantillas de roles', () => {
  it('solo usan permisos del catálogo y sin repetir', () => {
    for (const t of ROLE_TEMPLATES) {
      for (const p of t.permissions) expect(Permissions).toContain(p);
      expect(new Set(t.permissions).size).toBe(t.permissions.length);
    }
  });

  it('ninguna da administración del negocio', () => {
    for (const t of ROLE_TEMPLATES) {
      expect(t.permissions).not.toContain('users:manage');
      expect(t.permissions).not.toContain('settings:manage');
      expect(t.permissions).not.toContain('billing:configure');
    }
  });

  it('resume qué ve y qué cambia', () => {
    const r = summarizePermissions(['invoices:read', 'customers:read', 'customers:write']);
    expect(r.sees).toEqual(['Facturas', 'Inquilinos']);
    expect(r.changes).toEqual(['Inquilinos']);
  });
});
