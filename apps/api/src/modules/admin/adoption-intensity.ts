import { Prisma } from '@storageos/database';
import { WEB_CHAT_AI_FEATURE, type TenantFeature } from '@storageos/shared';

import type { PrismaAdminService } from '../database/prisma-admin.service';

/**
 * Intensidad de uso de cada función: cuántas veces la usó cada tenant en 30 y
 * 90 días (y desde una fecha más antigua si se pide, para la retención). Solo
 * las funciones con un registro fechado; el resto se mide por configuración y
 * no tiene intensidad (`null`).
 */

/** Qué se cuenta en cada función con intensidad. */
export const INTENSITY_UNITS: Partial<Record<TenantFeature, string>> = {
  ai_assistant: 'consultas',
  sepa: 'remesas',
  bank_reconciliation: 'extractos',
  rent_increases: 'subidas de precio',
  access_control: 'entradas',
  facial_access: 'entradas con la cara',
  automations: 'ejecuciones',
  collections: 'expedientes',
  web_premium: 'entradas del blog',
  whatsapp_business: 'mensajes',
  business_reminders: 'recordatorios enviados',
  unit_cession: 'cesiones',
};

export interface FeatureIntensity {
  d30: number;
  d90: number;
  /** Desde `since` (si se pidió una fecha más antigua que 90 días). */
  all: number;
}

/** `tenantId → función → intensidad`. */
export type IntensityMap = Map<string, Partial<Record<TenantFeature, FeatureIntensity>>>;

const DAY = 86_400_000;

/**
 * Una consulta con todas las fuentes. `since` es el inicio de la ventana más
 * larga (por defecto 90 días).
 */
export async function loadFeatureIntensity(
  admin: PrismaAdminService,
  tenantIds: string[] | null,
  now = new Date(),
  since = new Date(now.getTime() - 90 * DAY),
): Promise<IntensityMap> {
  if (tenantIds && tenantIds.length === 0) return new Map();
  const s30 = new Date(now.getTime() - 30 * DAY);
  const s90 = new Date(now.getTime() - 90 * DAY);
  const scope = tenantIds ? Prisma.sql`AND tenant_id = ANY(${tenantIds}::uuid[])` : Prisma.empty;
  const notAssistant = [WEB_CHAT_AI_FEATURE, 'whatsapp', 'whatsapp_own'];
  const rows = await admin.$queryRaw<
    { tenant_id: string; f: string; n30: bigint; n90: bigint; nall: bigint }[]
  >`
    WITH ev AS (
      SELECT tenant_id, 'ai_assistant' AS f, created_at AS at FROM ai_usage_events
        WHERE counts_as_query AND feature <> ALL(${notAssistant}::text[])
          AND created_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'sepa', created_at FROM sepa_remittances
        WHERE created_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'bank_reconciliation', created_at FROM bank_statements
        WHERE created_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'rent_increases', created_at FROM rent_increases
        WHERE created_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'access_control', occurred_at FROM access_logs
        WHERE result::text = 'allowed' AND occurred_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'facial_access', occurred_at FROM access_logs
        WHERE result::text = 'allowed' AND method::text = 'face' AND occurred_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'automations', started_at FROM automation_runs
        WHERE started_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'collections', created_at FROM delinquency_cases
        WHERE created_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'web_premium', published_at FROM blog_posts
        WHERE published_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'whatsapp_business', created_at FROM whatsapp_messages
        WHERE created_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'business_reminders', sent_at FROM business_reminder_notices
        WHERE sent_at >= ${since} ${scope}
      UNION ALL SELECT tenant_id, 'unit_cession', created_at FROM unit_cessions
        WHERE created_at >= ${since} ${scope}
    )
    SELECT tenant_id::text AS tenant_id, f,
           COUNT(*) FILTER (WHERE at >= ${s30}) AS n30,
           COUNT(*) FILTER (WHERE at >= ${s90}) AS n90,
           COUNT(*) AS nall
    FROM ev GROUP BY 1, 2`;
  const out: IntensityMap = new Map();
  for (const r of rows) {
    const byFeature = out.get(r.tenant_id) ?? {};
    byFeature[r.f as TenantFeature] = {
      d30: Number(r.n30),
      d90: Number(r.n90),
      all: Number(r.nall),
    };
    out.set(r.tenant_id, byFeature);
  }
  return out;
}
