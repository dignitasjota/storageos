import { z } from 'zod';

import { SUSPENSION_WEB_OFFLINE_DAYS } from '../admin/suspension';

/**
 * Control de indexación de la web pública de cada tenant (D3, SEO web fase 1).
 *
 * Un único punto de decisión: `decideWebIndexing`. La API la usa para el
 * sitemap y para los datos de la web (`noindex` de cada página del tenant); la
 * web no vuelve a decidir nada, solo pinta lo que recibe.
 *
 * - `auto` (por defecto): indexable si la web está publicada y el negocio está
 *   activo o en prueba, no es la cuenta de demostración y no está dado de baja.
 *   Un suspendido sigue como hoy (página indexable, fuera del sitemap) hasta
 *   `SUSPENSION_WEB_OFFLINE_DAYS` días; a partir de ahí, fuera del índice.
 * - `on`: fuerza indexable (si la web está publicada, es decir, con cuenta
 *   verificada y algún local). Ignora demo, suspensión y baja a propósito.
 * - `off`: noindex y fuera del sitemap, siempre.
 *
 * Los textos legales de un negocio (aviso legal, privacidad, cookies,
 * condiciones) NUNCA se indexan: lo fija `legalDocRobots`, no depende del modo.
 */

export const WEB_INDEXING_MODES = ['auto', 'on', 'off'] as const;
export type WebIndexingMode = (typeof WEB_INDEXING_MODES)[number];
export const WebIndexingModeSchema = z.enum(WEB_INDEXING_MODES);

export const WEB_INDEXING_LABELS: Record<WebIndexingMode, string> = {
  auto: 'Automático',
  on: 'Sí, indexar',
  off: 'No indexar',
};

export const SetWebIndexingSchema = z.object({
  mode: WebIndexingModeSchema,
  reason: z.string().trim().max(500).optional(),
});
export type SetWebIndexingInput = z.infer<typeof SetWebIndexingSchema>;

export type WebIndexingStatus = 'trial' | 'active' | 'suspended' | 'cancelled';

export interface WebIndexingInput {
  /** La web está publicada: cuenta verificada y algún local activo. */
  webPublished: boolean;
  status: WebIndexingStatus;
  /** Cuenta de demostración (etiqueta `demo`). */
  isDemo: boolean;
  /** Días que lleva suspendido; `null` si no está suspendido. */
  suspendedDays: number | null;
  mode: WebIndexingMode;
}

export type WebIndexingReason =
  | 'off'
  | 'on'
  | 'not_published'
  | 'demo'
  | 'live'
  | 'cancelled'
  | 'suspended_grace'
  | 'suspended_offline';

export interface WebIndexingDecision {
  /** La página lleva `index` (no `noindex`). */
  indexable: boolean;
  /** La página entra en `sitemap.xml`. */
  inSitemap: boolean;
  reason: WebIndexingReason;
}

export function decideWebIndexing(input: WebIndexingInput): WebIndexingDecision {
  const { webPublished, status, isDemo, suspendedDays, mode } = input;
  if (mode === 'off') return { indexable: false, inSitemap: false, reason: 'off' };
  if (!webPublished) return { indexable: false, inSitemap: false, reason: 'not_published' };
  if (mode === 'on') return { indexable: true, inSitemap: true, reason: 'on' };
  if (isDemo) return { indexable: false, inSitemap: false, reason: 'demo' };
  if (status === 'trial' || status === 'active') {
    return { indexable: true, inSitemap: true, reason: 'live' };
  }
  if (status === 'cancelled') return { indexable: false, inSitemap: false, reason: 'cancelled' };
  // Suspendido: la web sigue sirviéndose el plazo de SUSPENSION_WEB_OFFLINE_DAYS.
  if ((suspendedDays ?? 0) >= SUSPENSION_WEB_OFFLINE_DAYS) {
    return { indexable: false, inSitemap: false, reason: 'suspended_offline' };
  }
  return { indexable: true, inSitemap: false, reason: 'suspended_grace' };
}

/**
 * Cómo estaba la indexación ANTES de esta regla: el sitemap filtraba por
 * estado (trial/active), cuenta verificada, local activo y no demo; la página
 * era indexable salvo en la demostración. Sirve para la lista previa.
 */
export function todayWebIndexing(input: {
  webPublished: boolean;
  status: WebIndexingStatus;
  isDemo: boolean;
}): { indexable: boolean; inSitemap: boolean } {
  const live = input.status === 'trial' || input.status === 'active';
  return {
    indexable: !input.isDemo,
    inSitemap: input.webPublished && live && !input.isDemo,
  };
}

/**
 * Metaetiquetas `robots` de un texto legal del negocio. Siempre `noindex`
 * (decisión del dueño): no depende del modo del tenant.
 */
export function legalDocRobots(): { index: false; follow: true } {
  return { index: false, follow: true };
}

/** Previsualización por tenant de la lista previa (solo lectura). */
export interface WebIndexingPreviewRow {
  tenantId: string;
  slug: string;
  name: string;
  status: WebIndexingStatus;
  isDemo: boolean;
  mode: WebIndexingMode;
  webPublished: boolean;
  today: { indexable: boolean; inSitemap: boolean };
  withRule: WebIndexingDecision;
  /** La indexación o la presencia en el sitemap cambian con la regla. */
  changes: boolean;
}

/** Estado de indexación de un tenant, para su ficha del panel admin. */
export interface AdminTenantWebIndexingDto {
  tenantId: string;
  name: string;
  slug: string;
  status: WebIndexingStatus;
  isDemo: boolean;
  mode: WebIndexingMode;
  webPublished: boolean;
  suspendedDays: number | null;
  /** Lo que resulta con el modo guardado (lo que ve el público hoy). */
  decision: WebIndexingDecision;
}

export interface AdminWebIndexingPreviewDto {
  checkedAt: string;
  /** Tenants cuya indexación o presencia en el sitemap cambiaría con la regla. */
  changedCount: number;
  rows: WebIndexingPreviewRow[];
}
