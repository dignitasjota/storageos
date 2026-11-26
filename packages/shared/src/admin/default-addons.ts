import type { TenantFeature } from '../features';

/**
 * Catálogo por defecto de add-ons facturables del SaaS (grupo 1): cada feature
 * premium ya construida, vendible suelta a tenants cuyo plan no la incluye.
 * Asignar el add-on activa la feature (override). El super admin edita precios y
 * activa/desactiva desde `/admin/addons`. El seed/bootstrap los siembra
 * idempotente por `slug` sin sobrescribir ediciones posteriores.
 */
export interface DefaultAddon {
  slug: string;
  name: string;
  description: string;
  priceMonthly: number;
  /** Función que activa (null = extra de capacidad, sin función propia). */
  feature: TenantFeature | null;
  /** Consultas al mes del asistente IA que añade. */
  grantsAiQueries?: number;
  /** Usuarios de más que da (por unidad). */
  grantsUsers?: number;
  /** Solo en estos planes (vacío = en cualquiera). */
  planSlugs?: string[];
  /** Cantidad máxima por cliente. */
  maxQuantity?: number;
  /** De la plataforma: no se contrata ni se quita a mano. */
  isSystem?: boolean;
}

/** Plan de entrada: 1 € por trastero con un mínimo de 19 €. */
export const BASIC_PLAN_SLUG = 'basic';
/** Extra interno con los trasteros que pasan de los incluidos en la cuota. */
export const EXTRA_UNITS_ADDON_SLUG = 'addon-extra-units';
/** Segundo usuario del plan Basic. */
export const BASIC_USER_ADDON_SLUG = 'addon-basic-user';

/** Trasteros que se cobran aparte: los que pasan de los incluidos. */
export function extraUnitsFor(units: number, includedUnits: number | null | undefined): number {
  if (includedUnits == null) return 0;
  return Math.max(0, Math.floor(units) - includedUnits);
}

export const DEFAULT_SAAS_ADDONS: DefaultAddon[] = [
  {
    slug: EXTRA_UNITS_ADDON_SLUG,
    name: 'Trasteros de más',
    description:
      'Plan Basic: cada trastero por encima de los 19 incluidos. Se fija con los trasteros dados de alta antes de cada cobro.',
    priceMonthly: 1,
    feature: null,
    planSlugs: [BASIC_PLAN_SLUG],
    isSystem: true,
  },
  {
    slug: BASIC_USER_ADDON_SLUG,
    name: 'Segundo usuario',
    description: 'Plan Basic: un usuario más para el equipo.',
    priceMonthly: 10,
    feature: null,
    grantsUsers: 1,
    planSlugs: [BASIC_PLAN_SLUG],
    maxQuantity: 1,
  },
  {
    slug: 'addon-ai-extra',
    name: 'IA ampliada',
    description: '500 consultas más al mes del asistente IA.',
    priceMonthly: 15,
    feature: null,
    grantsAiQueries: 500,
  },
  {
    slug: 'addon-ai-assistant',
    name: 'Asistente IA',
    description: 'Asistente con acceso a los datos del negocio para el equipo.',
    priceMonthly: 12,
    feature: 'ai_assistant',
  },
  {
    slug: 'addon-sepa',
    name: 'Domiciliación SEPA / GoCardless',
    description: 'Cobro por adeudo directo SEPA sin comisión de pasarela.',
    priceMonthly: 9,
    feature: 'sepa',
  },
  {
    slug: 'addon-bank-reconciliation',
    name: 'Conciliación bancaria (N43)',
    description: 'Casa los cobros con el extracto bancario Norma 43.',
    priceMonthly: 6,
    feature: 'bank_reconciliation',
  },
  {
    slug: 'addon-access-control',
    name: 'Control de accesos',
    description: 'Credenciales PIN/QR/RFID, apertura remota y registro de accesos.',
    priceMonthly: 15,
    feature: 'access_control',
  },
  {
    slug: 'addon-rent-increases',
    name: 'Subidas de precio a cartera (ECRI)',
    description: 'Revisión de cuotas de la cartera con preaviso y aplicación programada.',
    priceMonthly: 10,
    feature: 'rent_increases',
  },
  {
    slug: 'addon-insurance',
    name: 'Gestión de seguros',
    description: 'Planes de protección de contenido facturados con la cuota.',
    priceMonthly: 6,
    feature: 'insurance',
  },
  {
    slug: 'addon-automations',
    name: 'Automatizaciones',
    description: 'Reglas evento→acción (emails/WhatsApp) sobre el negocio.',
    priceMonthly: 8,
    feature: 'automations',
  },
  {
    slug: 'addon-collections',
    name: 'Gestión de impagos (overlock)',
    description: 'Expedientes de impago: candado, requerimiento y disposición.',
    priceMonthly: 12,
    feature: 'collections',
  },
  {
    slug: 'addon-custom-domain',
    name: 'Dominio propio (white-label)',
    description: 'Sirve la web pública del operador bajo su propio dominio.',
    priceMonthly: 15,
    feature: 'custom_domain',
  },
  {
    slug: 'addon-cameras',
    name: 'Cámaras y alarma',
    description: 'Videovigilancia y alarma: log de eventos, snapshots y avisos de intrusión.',
    priceMonthly: 24,
    feature: 'cameras',
  },
  {
    slug: 'addon-facial-access',
    name: 'Acceso por reconocimiento facial',
    description:
      '«Tu cara es la llave»: el inquilino entra con reconocimiento facial en el terminal.',
    priceMonthly: 20,
    feature: 'facial_access',
  },
  {
    slug: 'addon-web-premium',
    name: 'Web Premium',
    description:
      'Web pública personalizable: elige plantilla de diseño y presenta tu empresa con reserva online integrada.',
    priceMonthly: 18,
    feature: 'web_premium',
  },
  {
    slug: 'addon-housing',
    name: 'Viviendas',
    description:
      'Alquila también viviendas: facturas exentas de IVA, contrato de arrendamiento (LAU), depósito de la fianza en la comunidad autónoma y actualización anual de la renta. Sin límite de viviendas.',
    priceMonthly: 15,
    feature: 'housing',
  },
  {
    slug: 'addon-whatsapp-business',
    name: 'WhatsApp Business',
    description:
      'Tu WhatsApp en tu web: quien te escribe desde la web (o por cualquier vía) aparece en el panel como contacto y le respondes desde ahí.',
    priceMonthly: 29,
    feature: 'whatsapp_business',
  },
  {
    slug: 'addon-local-seo',
    name: 'SEO local',
    description:
      'Sal en Google en tu ciudad y en los pueblos de alrededor: páginas de zona con textos redactados con IA, revisión de SEO de tu web, seguimiento de posiciones con Search Console e informe mensual.',
    priceMonthly: 12,
    feature: 'local_seo',
  },
  {
    slug: 'addon-seo-advanced',
    name: 'SEO Avanzado',
    description:
      'Todo lo de SEO local y además el detalle completo de Google: por qué búsquedas, páginas, países y dispositivos te encuentran, día a día y con los datos de hasta 16 meses, para tu dominio principal y hasta tres más. Con tu cuenta de SISTRIX, además, ves a tu competencia, el volumen de cada búsqueda y quién sale en Google para tus palabras.',
    priceMonthly: 199,
    feature: 'seo_advanced',
  },
];
