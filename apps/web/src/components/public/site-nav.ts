import {
  BarChart3,
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
  Rocket,
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

/** Ancla de la tarjeta de cada funcionalidad en la portada. */
export const featureAnchor = (key: FeatureKey) => `/#func-${key}`;

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

/** Desplegable «Soluciones». */
export const SOLUTIONS_MENU: SiteMenuLink[] = [
  { key: 'operators', href: '/#para-quien', icon: Warehouse },
  { key: 'managers', href: '/#administradores', icon: Users },
  { key: 'housing', href: '/#viviendas', icon: Home },
];

/** Desplegable «Recursos». */
export const RESOURCES_MENU: SiteMenuLink[] = [
  { key: 'howItWorks', href: '/#como-funciona', icon: Rocket },
  { key: 'compliance', href: '/#cumplimiento', icon: Scale },
  { key: 'faq', href: '/#faq', icon: CircleHelp },
  { key: 'contact', href: '/#contacto', icon: Mail, needsContact: true },
  { key: 'tenantPortal', href: '/portal/login', icon: LogIn },
];
