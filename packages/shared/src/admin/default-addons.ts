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
  feature: TenantFeature;
}

export const DEFAULT_SAAS_ADDONS: DefaultAddon[] = [
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
    description: '«Tu cara es la llave»: el inquilino entra con reconocimiento facial en el terminal.',
    priceMonthly: 20,
    feature: 'facial_access',
  },
];
