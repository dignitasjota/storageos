import { sistrixQuotaResetAt, type SeoSistrixWaitReason } from '@storageos/shared';

/**
 * Enrutador de proveedores de SISTRIX: para un fondo y una operación decide
 * por dónde se pide (función pura, probada aparte).
 *
 * Plataforma: MCP si está conectado y con cuota → API si el super admin la
 * autorizó («Continuar por API»), está activada, tiene clave y le queda
 * presupuesto → si no, esperar con el motivo. Sin autorización expresa nunca
 * se gastan créditos.
 *
 * Tenant: solo su clave de API (activada y con presupuesto); sin clave, nada.
 */
export interface RouteMcpState {
  status: string;
  quotaExhaustedUntil: Date | null;
}

export interface RouteApiState {
  enabled: boolean;
  hasKey: boolean;
  authorizedUntil: Date | null;
  weeklyBudget: number;
  /** Gastado esta semana (ya con el cambio de semana aplicado). */
  weekSpent: number;
}

export interface RouteInput {
  pool: 'platform' | 'tenant';
  mcp: RouteMcpState | null;
  api: RouteApiState | null;
  /** La operación existe en la API clásica. */
  supportsApi: boolean;
}

export type RouteDecision =
  | { provider: 'sistrix_mcp' | 'sistrix_api'; waitReason: null; until: null }
  | { provider: null; waitReason: SeoSistrixWaitReason; until: Date | null };

/** Créditos que quedan de la semana (0 si el presupuesto es 0 o está gastado). */
export function apiBudgetRemaining(api: Pick<RouteApiState, 'weeklyBudget' | 'weekSpent'>): number {
  return Math.max(0, api.weeklyBudget - api.weekSpent);
}

export function mcpUsable(mcp: RouteMcpState | null, now: Date): boolean {
  if (!mcp || mcp.status !== 'connected') return false;
  return !mcp.quotaExhaustedUntil || mcp.quotaExhaustedUntil.getTime() <= now.getTime();
}

const wait = (waitReason: SeoSistrixWaitReason, until: Date | null = null): RouteDecision => ({
  provider: null,
  waitReason,
  until,
});

function apiDecision(api: RouteApiState, supportsApi: boolean): RouteDecision | null {
  if (!supportsApi) return wait('not_supported');
  if (apiBudgetRemaining(api) <= 0) return wait('api_budget');
  return { provider: 'sistrix_api', waitReason: null, until: null };
}

export function decideSistrixRoute(input: RouteInput, now: Date = new Date()): RouteDecision {
  const { api } = input;
  const apiReady = !!api && api.enabled && api.hasKey;

  if (input.pool === 'tenant') {
    if (!apiReady) return wait('not_connected');
    return apiDecision(api, input.supportsApi)!;
  }

  if (mcpUsable(input.mcp, now)) {
    return { provider: 'sistrix_mcp', waitReason: null, until: null };
  }
  const mcp = input.mcp;
  const quota = !!mcp && mcp.status === 'connected' && !!mcp.quotaExhaustedUntil;
  const mcpWait: RouteDecision =
    mcp?.status === 'needs_reauth'
      ? wait('mcp_needs_reauth')
      : quota
        ? wait('mcp_quota', mcp.quotaExhaustedUntil)
        : wait('not_connected');

  const authorized =
    apiReady && !!api.authorizedUntil && api.authorizedUntil.getTime() > now.getTime();
  if (!authorized) return mcpWait;
  const decision = apiDecision(api, input.supportsApi)!;
  // Si la API no puede, se espera al MCP (que vuelve solo con la cuota).
  if (decision.provider === null && quota)
    return wait(decision.waitReason, mcp.quotaExhaustedUntil);
  return decision;
}

/**
 * Hasta cuándo vale «Continuar por API»: se acaba cuando el MCP se reanuda
 * (la hora de la cuota); si el MCP no está agotado, hasta mañana a las 00:05.
 */
export function apiAuthorizationUntil(quotaExhaustedUntil: Date | null, now = new Date()): Date {
  if (quotaExhaustedUntil && quotaExhaustedUntil.getTime() > now.getTime())
    return quotaExhaustedUntil;
  return sistrixQuotaResetAt(now);
}
