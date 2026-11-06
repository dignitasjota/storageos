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

  it('concuerda con la entidad y nombra las acciones de locales y plantas', () => {
    expect(auditActionLabel('floor.created')).toBe('Planta · creada');
    expect(auditActionLabel('floor.deleted')).toBe('Planta · borrada');
    expect(auditActionLabel('facility.deleted')).toBe('Local · borrado');
    expect(auditActionLabel('floor.plan_uploaded')).toBe('Planta · plano subido');
    expect(auditActionLabel('floor.layout_updated')).toBe('Planta · plano reorganizado');
    expect(auditActionLabel('facility.images_updated')).toBe('Local · fotos cambiadas');
    expect(auditActionLabel('facility.document_added')).toBe('Local · documento añadido');
    expect(auditActionLabel('unit_type.deactivated')).toBe('Tipo de trastero · desactivado');
  });

  it('nombra los permisos', () => {
    expect(permissionLabel('invoices:refund')).toBe('Facturas · Devolver dinero');
  });
});
