import { permissionsForRole } from '@storageos/shared';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * Lo que puede ver de Marketing quien consulta: el dinero solo con su permiso
 * (lo cobrado con facturas y cobros; el gasto con gastos) y solo sus locales
 * si tiene alcance. Las tareas automáticas (correo mensual a los propietarios)
 * lo ven todo.
 */
export interface MarketingViewer {
  /** Ingresos y cuotas: `invoices:read` y `payments:read`. */
  revenue: boolean;
  /** Gasto y coste por contacto o reserva: `expenses:read`. */
  cost: boolean;
  /** Locales que ve (null = todos). */
  facilityScope: string[] | null;
}

export const FULL_MARKETING_VIEWER: MarketingViewer = {
  revenue: true,
  cost: true,
  facilityScope: null,
};

export function marketingViewer(user: AuthenticatedUser): MarketingViewer {
  const p = user.permissions ?? permissionsForRole(user.role);
  return {
    revenue: p.includes('invoices:read') && p.includes('payments:read'),
    cost: p.includes('expenses:read'),
    facilityScope: user.facilityScope ?? null,
  };
}

/** ¿El local entra en lo que ve? (sin local = de toda la empresa: sí). */
export function inViewerScope(viewer: MarketingViewer, facilityId: string | null): boolean {
  return !viewer.facilityScope || !facilityId || viewer.facilityScope.includes(facilityId);
}
