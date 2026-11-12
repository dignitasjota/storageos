import {
  BarChart3,
  BookOpen,
  Calculator,
  CalendarCheck,
  Cctv,
  CircleHelp,
  CreditCard,
  FileSignature,
  Globe,
  Home,
  KeyRound,
  LogIn,
  Mail,
  Map,
  Megaphone,
  Presentation,
  ReceiptText,
  Scale,
  ShieldCheck,
  Smartphone,
  TrendingUp,
  Upload,
  Users,
  Warehouse,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * Menú de la web de TrasterOS. Para añadir una sección nueva basta con
 * añadir un grupo o un enlace aquí (y su texto en `publicHeader.menu`).
 */

/** Funcionalidades de la portada: el icono se comparte con sus tarjetas. */
export const FEATURE_ICONS = {
  plan: Map,
  contracts: FileSignature,
  billing: ReceiptText,
  payments: CreditCard,
  access: KeyRound,
  portal: Smartphone,
  booking: CalendarCheck,
  crm: Megaphone,
  whitelabel: Globe,
  operations: Wrench,
  analytics: BarChart3,
  insurance: ShieldCheck,
  pricing: TrendingUp,
  migration: Upload,
  cameras: Cctv,
} as const satisfies Record<string, LucideIcon>;

export type FeatureKey = keyof typeof FEATURE_ICONS;

/**
 * Página propia de cada funcionalidad (`/funcionalidades/<slug>`); las que no
 * tienen página llevan a su tarjeta de la portada.
 */
export const FEATURE_PAGE_SLUG: Partial<Record<FeatureKey, string>> = {
  plan: 'plano-de-trasteros',
  contracts: 'contratos-firma-electronica',
  billing: 'facturacion-veri-factu',
  payments: 'cobros-sepa-tarjeta-bizum',
  access: 'control-de-accesos',
  portal: 'portal-del-inquilino',
  booking: 'reserva-online',
  whitelabel: 'web-y-seo-local',
  crm: 'web-y-seo-local',
};

/** Enlace de cada funcionalidad: su página o, si no tiene, su tarjeta en la portada. */
export const featureAnchor = (key: FeatureKey) => {
  const slug = FEATURE_PAGE_SLUG[key];
  return slug ? `/funcionalidades/${slug}` : `/#func-${key}`;
};

/** Columnas del desplegable «Producto» (títulos en `publicHeader.menu.groups`). */
export const PRODUCT_MENU: { group: string; features: FeatureKey[] }[] = [
  { group: 'manage', features: ['plan', 'contracts', 'portal', 'operations', 'migration'] },
  { group: 'money', features: ['billing', 'payments', 'insurance', 'pricing'] },
  { group: 'growth', features: ['booking', 'crm', 'whitelabel', 'analytics'] },
  { group: 'security', features: ['access', 'cameras'] },
];

export interface SiteMenuLink {
  /** Clave del texto en `publicHeader.menu.links` (título y descripción). */
  key: string;
  href: string;
  icon: LucideIcon;
  /** Solo si el formulario de contacto está activo. */
  needsContact?: boolean;
}

/** Página de cada tipo de cliente (`/soluciones/<slug>`). */
export const AUDIENCE_PAGE_SLUG: Record<string, string> = {
  operators: 'operadores-self-storage',
  managers: 'administradores-de-trasteros',
  housing: 'trasteros-y-viviendas',
};

/** Desplegable «Soluciones». */
export const SOLUTIONS_MENU: SiteMenuLink[] = [
  { key: 'operators', href: '/soluciones/operadores-self-storage', icon: Warehouse },
  { key: 'managers', href: '/soluciones/administradores-de-trasteros', icon: Users },
  { key: 'housing', href: '/soluciones/trasteros-y-viviendas', icon: Home },
];

/** Desplegable «Recursos». */
export const RESOURCES_MENU: SiteMenuLink[] = [
  { key: 'blog', href: '/blog', icon: BookOpen },
  { key: 'calculator', href: '/calculadora-rentabilidad-trasteros', icon: Calculator },
  { key: 'demo', href: '/#demo', icon: Presentation },
  { key: 'compliance', href: '/funcionalidades/facturacion-veri-factu', icon: Scale },
  { key: 'faq', href: '/#faq', icon: CircleHelp },
  { key: 'contact', href: '/#contacto', icon: Mail, needsContact: true },
  { key: 'tenantPortal', href: '/portal/login', icon: LogIn },
];
