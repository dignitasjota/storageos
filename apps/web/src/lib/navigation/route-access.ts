import type { Permission, TenantFeature } from '@storageos/shared';

import { settingsItemFor } from '@/app/(app)/settings/settings-nav';
import { useCompanyWide, useFeatures, useMe, usePermissions } from '@/lib/auth/hooks';

/** Lo que exige una página del panel para abrirla. */
export interface RouteRequirements {
  permission?: Permission;
  feature?: TenantFeature;
  /** Pantallas de toda la empresa: no para quien solo ve unos locales. */
  companyWide?: boolean;
}

/**
 * Qué pide cada sección del panel: el permiso y la función del menú lateral
 * (`app-sidebar.tsx`), las funciones de las páginas con `FeatureGate` y las
 * páginas de importación o de alta que no están en el menú. Las páginas de
 * Configuración toman su permiso de `settings-nav.ts`.
 *
 * Si se añade una sección al menú con permiso o función, conviene añadirla
 * aquí también (si falta, el enlace se muestra y la propia página avisa).
 */
const RULES: Array<RouteRequirements & { prefix: string }> = [
  { prefix: '/customers', permission: 'customers:read' },
  { prefix: '/customers/import', permission: 'imports:manage' },
  { prefix: '/messages', permission: 'customers:read' },
  { prefix: '/contracts', permission: 'contracts:read' },
  { prefix: '/contracts/new', permission: 'contracts:write' },
  { prefix: '/contracts/import', permission: 'imports:manage' },
  { prefix: '/unit-inbox', permission: 'reservations:read' },
  { prefix: '/reservations', permission: 'reservations:read' },
  { prefix: '/waitlist', permission: 'reservations:read' },
  { prefix: '/unit-change-requests', permission: 'contracts:read' },
  { prefix: '/unit-requests', permission: 'contracts:read' },
  { prefix: '/calendar', permission: 'tasks:read' },
  { prefix: '/tasks', permission: 'tasks:read' },
  { prefix: '/maintenance', permission: 'tasks:read' },
  { prefix: '/reminders', permission: 'reminders:read', feature: 'business_reminders' },
  { prefix: '/incidents', permission: 'incidents:read' },
  { prefix: '/access', permission: 'access:read', feature: 'access_control' },
  { prefix: '/cameras', permission: 'access:read', feature: 'cameras' },
  { prefix: '/facilities', permission: 'facilities:read' },
  { prefix: '/units', permission: 'units:read' },
  { prefix: '/units/import', permission: 'imports:manage' },
  { prefix: '/products', permission: 'products:read' },
  { prefix: '/owners', permission: 'facilities:read', feature: 'multi_owner' },
  { prefix: '/invoices', permission: 'invoices:read' },
  { prefix: '/payments', permission: 'payments:read' },
  { prefix: '/collections-month', permission: 'payments:read' },
  { prefix: '/arrears', permission: 'payments:read' },
  { prefix: '/cash', permission: 'payments:read' },
  { prefix: '/collections', permission: 'collections:read', feature: 'collections' },
  { prefix: '/returned-receipts', permission: 'payments:read' },
  {
    prefix: '/sepa-remittances',
    permission: 'payments:read',
    feature: 'sepa',
    companyWide: true,
  },
  { prefix: '/sepa-remittances/import-mandates', permission: 'imports:manage' },
  {
    prefix: '/bank-reconciliation',
    permission: 'payments:read',
    feature: 'bank_reconciliation',
    companyWide: true,
  },
  { prefix: '/expenses', permission: 'expenses:read' },
  { prefix: '/expenses/import', permission: 'imports:manage' },
  { prefix: '/fiscal', permission: 'invoices:manage', companyWide: true },
  { prefix: '/rent-increases', permission: 'contracts:manage', feature: 'rent_increases' },
  { prefix: '/renewals', permission: 'contracts:read' },
  { prefix: '/price-changes', permission: 'contracts:read' },
  { prefix: '/insurance-plans', permission: 'insurance:read', feature: 'insurance' },
  { prefix: '/leads', permission: 'leads:read' },
  { prefix: '/leads/import', permission: 'imports:manage' },
  { prefix: '/followups', permission: 'customers:read' },
  { prefix: '/opportunities', permission: 'customers:read' },
  { prefix: '/campaigns', permission: 'communications:read' },
  {
    prefix: '/whatsapp',
    permission: 'communications:read',
    feature: 'whatsapp_business',
  },
  { prefix: '/communications', permission: 'communications:read' },
  { prefix: '/message-templates', permission: 'templates:read' },
  { prefix: '/automations', permission: 'automations:read', feature: 'automations' },
  { prefix: '/promotions', permission: 'promotions:read' },
  { prefix: '/coupons', permission: 'promotions:read' },
  { prefix: '/referrals', permission: 'referrals:read' },
  { prefix: '/reviews', permission: 'reviews:read' },
  { prefix: '/marketing', permission: 'marketing:read' },
  { prefix: '/analytics', permission: 'analytics:read' },
  { prefix: '/competitors', permission: 'analytics:read' },
  { prefix: '/seo', permission: 'analytics:read', feature: 'local_seo' },
  // Sin función: la página enseña qué ofrece el extra a quien no lo tiene.
  { prefix: '/seo-advanced', permission: 'analytics:read' },
  { prefix: '/reports', permission: 'reports:read' },
  { prefix: '/assistant', permission: 'ai:use', feature: 'ai_assistant' },
  // Configuración: el permiso sale de `settings-nav.ts`; aquí solo las funciones.
  { prefix: '/settings/web', feature: 'web_premium' },
  { prefix: '/settings/blog', feature: 'web_premium' },
  { prefix: '/settings/promo-landings', feature: 'web_premium' },
  { prefix: '/settings/area-pages', feature: 'local_seo' },
  { prefix: '/settings/ai', feature: 'ai_assistant' },
  { prefix: '/settings/whatsapp', feature: 'whatsapp_business' },
  { prefix: '/settings/domain', feature: 'custom_domain' },
  { prefix: '/settings/access', feature: 'access_control' },
];

/** La ruta sin parámetros ni ancla (`/help#x` → `/help`). */
function routePath(href: string): string {
  const path = href.split(/[?#]/)[0] ?? '';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function matches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** El dato de la regla de ruta más larga que lo define. */
function longest<K extends keyof RouteRequirements>(
  path: string,
  key: K,
): RouteRequirements[K] | undefined {
  let best: { value: RouteRequirements[K]; len: number } | null = null;
  for (const rule of RULES) {
    if (rule[key] === undefined || !matches(path, rule.prefix)) continue;
    if (!best || rule.prefix.length > best.len)
      best = { value: rule[key], len: rule.prefix.length };
  }
  return best?.value;
}

/** Qué exige una ruta interna del panel (vacío si no exige nada o no es interna). */
export function routeRequirements(href: string): RouteRequirements {
  if (!href.startsWith('/') || href.startsWith('//')) return {};
  const path = routePath(href);
  const permission = matches(path, '/settings')
    ? settingsItemFor(path)?.permission
    : longest(path, 'permission');
  const feature = longest(path, 'feature');
  const companyWide = longest(path, 'companyWide');
  return {
    ...(permission ? { permission } : {}),
    ...(feature ? { feature } : {}),
    ...(companyWide ? { companyWide } : {}),
  };
}

/** Lo que puede hacer el usuario con un enlace del panel. */
export interface RouteAccess {
  /** Tiene permiso (y alcance) para abrir la página. */
  allowed: boolean;
  /** La función que la página necesita y su plan no incluye (o null). */
  missingFeature: TenantFeature | null;
}

/**
 * Comprueba enlaces internos contra los permisos y el plan del usuario.
 * Mientras se carga la sesión, todo se da por permitido (como el menú).
 * Cosmético: la frontera real la pone el backend.
 */
export function useRouteAccess(): (href: string) => RouteAccess {
  const me = useMe();
  const permissions = usePermissions();
  const features = useFeatures();
  const companyWide = useCompanyWide();
  const loaded = !!me.data;
  return (href) => {
    if (!loaded) return { allowed: true, missingFeature: null };
    const req = routeRequirements(href);
    const allowed =
      (!req.permission || permissions.includes(req.permission)) &&
      (!req.companyWide || companyWide);
    const missingFeature = req.feature && !features.includes(req.feature) ? req.feature : null;
    return { allowed, missingFeature };
  };
}

/** Página de planes y extras de la suscripción. */
export const PLANS_HREF = '/settings/saas-billing';
