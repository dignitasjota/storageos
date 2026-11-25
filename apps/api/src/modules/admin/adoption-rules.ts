import { resolvePlanFeatures, type TenantFeature } from '@storageos/shared';

/**
 * Reglas puras de Adopción (sin base de datos): qué cuenta como «usa la
 * función», cuándo un tenant topa un límite y qué plan se le recomienda.
 */

/**
 * Cómo se mide el uso de cada función. Donde hay fecha, en los últimos 90 días;
 * donde no, cuenta la configuración activa.
 */
export const ADOPTION_SIGNALS: Record<TenantFeature, string> = {
  ai_assistant: 'Consultas al asistente IA (panel o área de clientes) en 90 días',
  sepa: 'Remesas SEPA generadas en 90 días',
  bank_reconciliation: 'Extractos bancarios importados en 90 días',
  rent_increases: 'Subidas de precio creadas en 90 días',
  insurance: 'Contratos en vigor con seguro',
  access_control: 'Dispositivos de acceso activos o entradas registradas en 90 días',
  cameras: 'Cámaras dadas de alta (configuración activa)',
  facial_access: 'Accesos faciales activos',
  automations: 'Automatizaciones ejecutadas en 90 días',
  collections: 'Expedientes de impago abiertos o creados en 90 días',
  custom_domain: 'Dominio propio verificado (configuración activa)',
  web_premium: 'Plantilla de web propia o entradas del blog publicadas en 90 días',
  housing: 'Contratos en vigor sobre viviendas',
  multi_owner: 'Locales con propietario (configuración activa)',
  whatsapp_business: 'Mensajes de WhatsApp en 90 días',
  local_seo: 'Páginas de zona publicadas (configuración activa)',
  business_reminders: 'Vencimientos activos o en pausa (configuración activa)',
  unit_cession: 'Trasteros cedidos en curso o cedidos en 90 días',
  branded_panel: 'Función activa con logo subido o color de marca',
  seo_advanced: 'Proyecto de SEO con algún dominio conectado a Search Console',
};

/** A partir de qué parte de un límite se avisa de «cerca del límite». */
export const NEAR_LIMIT_RATIO = 0.8;

export interface LimitUsage {
  units: number;
  facilities: number;
  users: number;
}

export interface LimitMax {
  units: number | null;
  facilities: number | null;
  users: number | null;
}

export interface AdoptionLimits {
  /** Algún límite al 100 % o por encima (con las reglas de abajo). */
  tapsLimit: boolean;
  /** Algún límite entre el 80 % y el 100 % (sin topar ninguno). */
  nearLimit: boolean;
  /** Qué recurso está en el límite (para pedir hueco para uno más). */
  atLimit: { units: boolean; facilities: boolean; users: boolean };
  /** Texto con los recursos al límite o cerca. */
  detail: string | null;
}

const LABELS: Record<keyof LimitUsage, [string, string]> = {
  units: ['trastero', 'trasteros'],
  facilities: ['local', 'locales'],
  users: ['usuario', 'usuarios'],
};

/**
 * ¿Topa o se acerca a algún límite?
 *  - Trasteros: al 100 % o más, siempre (se van llenando).
 *  - Locales: por encima del límite, o en él si el plan permite más de uno
 *    (un operador de un solo local en un plan de un local no «topa»).
 *  - Usuarios: por encima, o en el límite si el plan permite más de uno y el
 *    tenant tiene uso real (contratos en vigor) y no está en prueba.
 * «Cerca» = al 80 % o más de un límite de 2 o más, sin topar ninguno.
 */
export function adoptionLimits(
  use: LimitUsage,
  max: LimitMax,
  ctx: { inTrial: boolean; realUse: boolean },
): AdoptionLimits {
  const atLimit = {
    units: max.units !== null && use.units >= max.units,
    facilities:
      max.facilities !== null &&
      (use.facilities > max.facilities || (use.facilities >= max.facilities && max.facilities > 1)),
    users:
      max.users !== null &&
      (use.users > max.users ||
        (use.users >= max.users && max.users > 1 && !ctx.inTrial && ctx.realUse)),
  };
  const tapsLimit = atLimit.units || atLimit.facilities || atLimit.users;
  const keys = ['units', 'facilities', 'users'] as const;
  const near = keys.filter((k) => {
    const m = max[k];
    return m !== null && m >= 2 && use[k] >= m * NEAR_LIMIT_RATIO && use[k] < m;
  });
  const nearLimit = !tapsLimit && near.length > 0;
  const shown = tapsLimit ? keys.filter((k) => atLimit[k]) : nearLimit ? near : [];
  const detail =
    shown.length === 0
      ? null
      : shown
          .map((k) => {
            const m = max[k] ?? 0;
            const pct = m > 0 ? Math.round((use[k] / m) * 100) : 0;
            return `${use[k]} de ${m} ${LABELS[k][m === 1 ? 0 : 1]} (${pct} %)`;
          })
          .join(' · ');
  return { tapsLimit, nearLimit, atLimit, detail };
}

interface PlanLike {
  id: string;
  slug: string;
  priceMonthly: unknown;
  maxUnits: number | null;
  maxFacilities: number | null;
  maxUsers: number | null;
  tenantFeatures: string[];
}

/** ¿Cabe `need` en el límite `max` más la capacidad extra? */
function fits(max: number | null, extra: number, need: number): boolean {
  return max === null || max + extra >= need;
}

/**
 * Plan más barato (de `plans`, ya ordenados por precio y solo públicos y
 * activos) que cubre las funciones en uso y los límites con margen: trasteros
 * como mucho al 80 % y hueco para un local o usuario más donde ya está en el
 * límite. Si ninguno llega con margen, el más barato que cubre lo que usa hoy.
 */
export function pickRecommendedPlan<P extends PlanLike>(
  plans: P[],
  args: {
    used: Set<TenantFeature>;
    sellableInPlans: Set<TenantFeature>;
    usage: LimitUsage;
    extra: LimitUsage;
    needsRoom: { units: boolean; facilities: boolean; users: boolean };
  },
): P | null {
  const covers = (plan: P, margin: boolean): boolean => {
    const feats = resolvePlanFeatures(plan);
    for (const ft of args.used) {
      if (args.sellableInPlans.has(ft) && !feats.includes(ft)) return false;
    }
    const { usage, extra, needsRoom } = args;
    const needUnits = margin ? Math.ceil(usage.units / NEAR_LIMIT_RATIO) : usage.units;
    const needFacilities = usage.facilities + (margin && needsRoom.facilities ? 1 : 0);
    const needUsers = usage.users + (margin && needsRoom.users ? 1 : 0);
    return (
      fits(plan.maxUnits, extra.units, needUnits) &&
      fits(plan.maxFacilities, extra.facilities, needFacilities) &&
      fits(plan.maxUsers, extra.users, needUsers)
    );
  };
  return plans.find((p) => covers(p, true)) ?? plans.find((p) => covers(p, false)) ?? null;
}
