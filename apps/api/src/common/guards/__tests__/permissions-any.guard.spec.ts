import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ANY_PERMISSION_KEY } from '../../decorators/require-permission.decorator';
import { PermissionsGuard } from '../permissions.guard';

import type { ExecutionContext } from '@nestjs/common';
import type { Permission } from '@storageos/shared';

function contextWith(permissions: Permission[]): ExecutionContext {
  const req = { user: { role: 'staff', permissions } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function guardWithAny(any: Permission[]): PermissionsGuard {
  const reflector = {
    getAllAndOverride: (key: string) => (key === ANY_PERMISSION_KEY ? any : undefined),
  } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

describe('PermissionsGuard con RequireAnyPermission', () => {
  const guard = guardWithAny(['settings:read', 'billing:configure']);

  it('deja pasar con cualquiera de los permisos (rol a medida sin settings:read)', () => {
    expect(guard.canActivate(contextWith(['billing:configure']))).toBe(true);
    expect(guard.canActivate(contextWith(['settings:read']))).toBe(true);
  });

  it('sin ninguno → forbidden', () => {
    expect(() => guard.canActivate(contextWith(['invoices:read']))).toThrow(ForbiddenException);
  });
});
