import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  permissionsForRole,
  roleHasPermission,
  ROLE_PERMISSIONS,
  Permissions,
} from '@storageos/shared';

import { PERMISSION_KEY } from '../../decorators/require-permission.decorator';
import { PermissionsGuard } from '../permissions.guard';

import type { ExecutionContext } from '@nestjs/common';
import type { Permission } from '@storageos/shared';

function contextWith(role: string | undefined): ExecutionContext {
  const req = { user: role ? { role } : undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function guardWith(required: Permission[] | undefined): PermissionsGuard {
  const reflector = {
    getAllAndOverride: (key: string) => (key === PERMISSION_KEY ? required : undefined),
  } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

describe('PermissionsGuard', () => {
  it('deja pasar si el handler no declara permisos', () => {
    expect(guardWith(undefined).canActivate(contextWith('readonly'))).toBe(true);
    expect(guardWith([]).canActivate(contextWith('readonly'))).toBe(true);
  });

  it('owner pasa cualquier permiso', () => {
    expect(guardWith(['invoices:refund']).canActivate(contextWith('owner'))).toBe(true);
  });

  it('manager NO puede invoices:refund (regla fina)', () => {
    expect(() => guardWith(['invoices:refund']).canActivate(contextWith('manager'))).toThrow(
      ForbiddenException,
    );
  });

  it('manager sí puede invoices:manage', () => {
    expect(guardWith(['invoices:manage']).canActivate(contextWith('manager'))).toBe(true);
  });

  it('staff puede invoices:write pero no invoices:manage', () => {
    expect(guardWith(['invoices:write']).canActivate(contextWith('staff'))).toBe(true);
    expect(() => guardWith(['invoices:manage']).canActivate(contextWith('staff'))).toThrow(
      ForbiddenException,
    );
  });

  it('sin usuario → forbidden', () => {
    expect(() => guardWith(['invoices:read']).canActivate(contextWith(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('exige TODOS los permisos listados', () => {
    // staff tiene write pero no refund.
    expect(() =>
      guardWith(['invoices:write', 'invoices:refund']).canActivate(contextWith('staff')),
    ).toThrow(ForbiddenException);
  });
});

describe('ROLE_PERMISSIONS map', () => {
  it('owner tiene todos los permisos del catálogo', () => {
    expect(permissionsForRole('owner').sort()).toEqual([...Permissions].sort());
  });

  it('readonly solo tiene permisos :read', () => {
    expect(permissionsForRole('readonly').every((p) => p.endsWith(':read'))).toBe(true);
    expect(roleHasPermission('readonly', 'invoices:read')).toBe(true);
    expect(roleHasPermission('readonly', 'invoices:write')).toBe(false);
  });

  it('manager no tiene acciones sensibles (refunds, settings, integraciones)', () => {
    for (const p of [
      'invoices:refund',
      'payments:refund',
      'settings:manage',
      'billing:configure',
      'integrations:manage',
      'users:manage',
      'rgpd:manage',
    ] as Permission[]) {
      expect(roleHasPermission('manager', p)).toBe(false);
    }
  });

  it('cada rol tiene una lista definida', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(
      ['manager', 'owner', 'readonly', 'staff'].sort(),
    );
  });
});
