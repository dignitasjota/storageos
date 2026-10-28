import { describe, expect, it } from 'vitest';

import { permissionLabel } from '../auth/permissions';

import { auditActionLabel } from './labels';

describe('auditActionLabel', () => {
  it('traduce acciones conocidas y conserva las desconocidas', () => {
    expect(auditActionLabel('invoice.issued')).toBe('Factura · emitida');
    expect(auditActionLabel('tenant.billing.settings_changed')).toBe(
      'Ajustes de facturación · ajustes cambiados',
    );
    expect(auditActionLabel('auth.login.success')).toBe('Inicio de sesión');
    expect(auditActionLabel('unit_type.created')).toBe('Tipo de trastero · creado');
    expect(auditActionLabel('foo.bar_baz')).toBe('foo bar baz');
  });

  it('nombra los permisos', () => {
    expect(permissionLabel('invoices:refund')).toBe('Facturas · Devolver dinero');
  });
});
