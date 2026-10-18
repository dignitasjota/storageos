'use client';

import { useAdminAuthStore } from './auth-store';

/**
 * `true` si el super admin conectado tiene el rol completo. El rol `support`
 * solo lee la configuración de la plataforma, los cobros y la facturación: el
 * API le responde 403 en esas acciones, así que la web las deshabilita.
 */
export function useIsSuperadmin(): boolean {
  return useAdminAuthStore((s) => s.superAdmin?.role === 'superadmin');
}

/** Secciones del panel que el rol `support` solo puede consultar. */
export const SUPERADMIN_ONLY_PATHS = [
  '/admin/platform-sepa',
  '/admin/platform-dunning',
  '/admin/platform-billing',
  '/admin/platform-banner',
  '/admin/legal',
  '/admin/platform-alerts',
  '/admin/webhooks-cleanup',
  '/admin/plans',
  '/admin/addons',
  '/admin/coupons',
  '/admin/payments',
  '/admin/website',
  '/admin/email',
  '/admin/whatsapp-ai',
  '/admin/product-updates',
  '/admin/super-admins',
];
