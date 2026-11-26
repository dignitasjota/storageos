import {
  apiAuthorizationUntil,
  apiBudgetRemaining,
  decideSistrixRoute,
  type RouteApiState,
} from '../providers/seo-provider-router';

const NOW = new Date('2026-11-25T12:00:00Z');
const LATER = new Date('2026-11-25T23:05:00Z');
const api = (over: Partial<RouteApiState> = {}): RouteApiState => ({
  enabled: true,
  hasKey: true,
  authorizedUntil: null,
  weeklyBudget: 1000,
  weekSpent: 0,
  ...over,
});

describe('Enrutador de SISTRIX (MCP → API autorizada → esperar)', () => {
  it('plataforma: MCP conectado y con cuota → MCP', () => {
    expect(
      decideSistrixRoute(
        {
          pool: 'platform',
          mcp: { status: 'connected', quotaExhaustedUntil: null },
          api: api(),
          supportsApi: true,
        },
        NOW,
      ),
    ).toMatchObject({ provider: 'sistrix_mcp' });
  });

  it('plataforma: cuota agotada y sin autorización → espera hasta las 00:05 (no gasta créditos)', () => {
    expect(
      decideSistrixRoute(
        {
          pool: 'platform',
          mcp: { status: 'connected', quotaExhaustedUntil: LATER },
          api: api(),
          supportsApi: true,
        },
        NOW,
      ),
    ).toEqual({ provider: null, waitReason: 'mcp_quota', until: LATER });
  });

  it('plataforma: cuota agotada y «Continuar por API» autorizado con presupuesto → API', () => {
    expect(
      decideSistrixRoute(
        {
          pool: 'platform',
          mcp: { status: 'connected', quotaExhaustedUntil: LATER },
          api: api({ authorizedUntil: LATER }),
          supportsApi: true,
        },
        NOW,
      ),
    ).toMatchObject({ provider: 'sistrix_api' });
  });

  it('plataforma: autorizada pero sin presupuesto, o dato sin método en la API → espera al MCP', () => {
    expect(
      decideSistrixRoute(
        {
          pool: 'platform',
          mcp: { status: 'connected', quotaExhaustedUntil: LATER },
          api: api({ authorizedUntil: LATER, weekSpent: 1000 }),
          supportsApi: true,
        },
        NOW,
      ),
    ).toEqual({ provider: null, waitReason: 'api_budget', until: LATER });
    expect(
      decideSistrixRoute(
        {
          pool: 'platform',
          mcp: { status: 'connected', quotaExhaustedUntil: LATER },
          api: api({ authorizedUntil: LATER }),
          supportsApi: false,
        },
        NOW,
      ),
    ).toEqual({ provider: null, waitReason: 'not_supported', until: LATER });
  });

  it('plataforma: la API desactivada nunca se usa, aunque haya autorización', () => {
    expect(
      decideSistrixRoute(
        {
          pool: 'platform',
          mcp: null,
          api: api({ enabled: false, authorizedUntil: LATER }),
          supportsApi: true,
        },
        NOW,
      ),
    ).toMatchObject({ provider: null, waitReason: 'not_connected' });
  });

  it('plataforma: hay que volver a conectar → espera con ese motivo', () => {
    expect(
      decideSistrixRoute(
        {
          pool: 'platform',
          mcp: { status: 'needs_reauth', quotaExhaustedUntil: null },
          api: null,
          supportsApi: true,
        },
        NOW,
      ),
    ).toMatchObject({ provider: null, waitReason: 'mcp_needs_reauth' });
  });

  it('la cuota caducada ya no frena', () => {
    expect(
      decideSistrixRoute(
        {
          pool: 'platform',
          mcp: { status: 'connected', quotaExhaustedUntil: new Date('2026-11-25T11:00:00Z') },
          api: null,
          supportsApi: true,
        },
        NOW,
      ),
    ).toMatchObject({ provider: 'sistrix_mcp' });
  });

  it('tenant: solo su clave de API, con presupuesto; sin clave no hay SISTRIX', () => {
    expect(
      decideSistrixRoute({ pool: 'tenant', mcp: null, api: api(), supportsApi: true }, NOW),
    ).toMatchObject({ provider: 'sistrix_api' });
    expect(
      decideSistrixRoute({ pool: 'tenant', mcp: null, api: null, supportsApi: true }, NOW),
    ).toMatchObject({ waitReason: 'not_connected' });
    expect(
      decideSistrixRoute(
        { pool: 'tenant', mcp: null, api: api({ weeklyBudget: 0 }), supportsApi: true },
        NOW,
      ),
    ).toMatchObject({ waitReason: 'api_budget' });
    // Un tenant nunca usa el MCP de la plataforma.
    expect(
      decideSistrixRoute(
        {
          pool: 'tenant',
          mcp: { status: 'connected', quotaExhaustedUntil: null },
          api: null,
          supportsApi: true,
        },
        NOW,
      ),
    ).toMatchObject({ provider: null });
  });

  it('presupuesto semanal: corte duro al llegar', () => {
    expect(apiBudgetRemaining({ weeklyBudget: 500, weekSpent: 120 })).toBe(380);
    expect(apiBudgetRemaining({ weeklyBudget: 500, weekSpent: 600 })).toBe(0);
    expect(apiBudgetRemaining({ weeklyBudget: 0, weekSpent: 0 })).toBe(0);
  });

  it('la autorización de la API caduca cuando vuelve el MCP', () => {
    expect(apiAuthorizationUntil(LATER, NOW)).toEqual(LATER);
    expect(apiAuthorizationUntil(null, NOW).toISOString()).toBe('2026-11-25T23:05:00.000Z');
  });
});
