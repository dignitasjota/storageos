import { describe, expect, it } from 'vitest';

import {
  SEO_DEFAULT_ALERT_SETTINGS,
  planSeoAlertSync,
  seoAlertSettingsOf,
  seoClicksDropAlert,
  seoGscFreshnessAlerts,
  seoPositionDropAlert,
  type SeoAlertCandidate,
} from './alerts';
import {
  estimateSeoConversionsByQuery,
  isOrganicGoogleSource,
  seoConversionRanges,
  seoConversionRate,
  seoLandingKey,
  seoPageLandingKey,
} from './conversions';
import { scoreSeoOpportunity, type SeoOpportunityFactorsInput } from './opportunities';
import {
  seoIsoWeek,
  seoReportHighlights,
  seoReportPeriod,
  seoReportSettingsOf,
  type SeoReportContentDto,
} from './reports';

describe('conversiones orgánicas', () => {
  it('solo Google orgánico (sin medio también: es un clic en un resultado)', () => {
    expect(isOrganicGoogleSource('google', 'organic')).toBe(true);
    expect(isOrganicGoogleSource('Google', null)).toBe(true);
    expect(isOrganicGoogleSource('google', 'cpc')).toBe(false);
    expect(isOrganicGoogleSource('bing', 'organic')).toBe(false);
    expect(isOrganicGoogleSource(null, 'organic')).toBe(false);
  });

  it('página de entrada: ruta en minúsculas, sin parámetros ni barra final, sin /s/<negocio>', () => {
    expect(seoLandingKey('/Precios/?utm_source=google')).toBe('/precios');
    expect(seoLandingKey('/s/guardalo/trasteros-en-mislata')).toBe('/trasteros-en-mislata');
    expect(seoLandingKey('/s/guardalo')).toBe('/');
    expect(seoLandingKey('')).toBe('');
    expect(seoLandingKey(null)).toBe('');
    expect(seoPageLandingKey('https://www.guardalobox.es/Precios/')).toBe('/precios');
    expect(seoPageLandingKey('https://guardalobox.es/')).toBe('/');
  });

  it('recuentos hasta hoy; la tasa, solo con los días de Google (y los mismos antes)', () => {
    const r = seoConversionRanges({
      period: '7d',
      today: '2026-11-26',
      lastDataDate: '2026-11-24',
    });
    expect(r).toEqual({
      from: '2026-11-20',
      to: '2026-11-26',
      previousFrom: '2026-11-13',
      previousTo: '2026-11-19',
      rate: {
        from: '2026-11-20',
        to: '2026-11-24',
        previousFrom: '2026-11-15',
        previousTo: '2026-11-19',
      },
    });
    // A mano: no pasa de hoy, y con Google al día la tasa usa el periodo entero.
    const custom = seoConversionRanges({
      period: 'custom',
      from: '2026-11-20',
      to: '2026-11-30',
      today: '2026-11-26',
      lastDataDate: '2026-11-26',
    });
    expect(custom?.to).toBe('2026-11-26');
    expect(custom?.rate).toMatchObject({ from: '2026-11-20', to: '2026-11-26' });
    // Sin datos de Google en el periodo: sin tasa, pero con recuentos.
    const none = seoConversionRanges({
      period: '7d',
      today: '2026-11-26',
      lastDataDate: '2026-11-10',
    });
    expect(none?.rate).toBeNull();
    expect(
      seoConversionRanges({ period: '7d', today: '2026-11-26', lastDataDate: null })?.rate,
    ).toBeNull();
    expect(
      seoConversionRanges({ period: 'custom', today: '2026-11-26', lastDataDate: null }),
    ).toBeNull();
  });

  it('tasa con clics; sin clics, null', () => {
    expect(seoConversionRate(3, 150)).toBe(0.02);
    expect(seoConversionRate(3, 0)).toBeNull();
  });

  it('reparte cada página entre sus búsquedas en proporción a los clics', () => {
    const out = estimateSeoConversionsByQuery(
      [
        { landingKey: '/precios', conversions: 4 },
        { landingKey: '/', conversions: 1 },
        { landingKey: '/sin-busquedas', conversions: 3 },
        { landingKey: '', conversions: 2 },
      ],
      [
        { query: 'precio trastero', pageKey: '/precios', clicks: 30 },
        { query: 'trasteros mislata', pageKey: '/precios', clicks: 10 },
        { query: 'trasteros mislata', pageKey: '/', clicks: 5 },
        { query: 'sin clics', pageKey: '/precios', clicks: 0 },
      ],
    );
    expect(out).toEqual([
      { query: 'precio trastero', conversions: 3, clicks: 30, pages: ['/precios'] },
      { query: 'trasteros mislata', conversions: 2, clicks: 15, pages: ['/precios', '/'] },
    ]);
  });
});

describe('alertas', () => {
  const t = SEO_DEFAULT_ALERT_SETTINGS;

  it('caída de clics: con las dos semanas completas, mínimo de clics y umbral', () => {
    const base = {
      domainId: 'd1',
      domain: 'ejemplo.es',
      to: '2026-11-22',
      thresholds: t,
    };
    const a = seoClicksDropAlert({
      ...base,
      current: { clicks: 40, days: 7 },
      previous: { clicks: 100, days: 7 },
    });
    expect(a?.type).toBe('clicks_drop');
    expect(a?.key).toBe('clicks_drop|d1');
    expect(a?.severity).toBe('high');
    expect(a?.title).toContain('60 %');
    // Bajada pequeña, pocos clics o semana incompleta: nada.
    expect(
      seoClicksDropAlert({
        ...base,
        current: { clicks: 80, days: 7 },
        previous: { clicks: 100, days: 7 },
      }),
    ).toBeNull();
    expect(
      seoClicksDropAlert({
        ...base,
        current: { clicks: 0, days: 7 },
        previous: { clicks: 10, days: 7 },
      }),
    ).toBeNull();
    expect(
      seoClicksDropAlert({
        ...base,
        current: { clicks: 10, days: 6 },
        previous: { clicks: 100, days: 7 },
      }),
    ).toBeNull();
  });

  it('palabra importante que baja: puestos e impresiones mínimas', () => {
    const base = { domainId: 'd1', domain: 'ejemplo.es', keyword: 'trasteros', thresholds: t };
    const a = seoPositionDropAlert({
      ...base,
      current: { position: 12, impressions: 100 },
      previous: { position: 8, impressions: 100 },
    });
    expect(a?.severity).toBe('high'); // sale de la primera página
    expect(a?.data.drop).toBe(4);
    expect(
      seoPositionDropAlert({
        ...base,
        current: { position: 10, impressions: 100 },
        previous: { position: 8, impressions: 100 },
      }),
    ).toBeNull();
    expect(
      seoPositionDropAlert({
        ...base,
        current: { position: 20, impressions: 10 },
        previous: { position: 8, impressions: 100 },
      }),
    ).toBeNull();
    expect(
      seoPositionDropAlert({
        ...base,
        current: { position: null, impressions: 100 },
        previous: { position: 8, impressions: 100 },
      }),
    ).toBeNull();
  });

  it('Search Console: sin acceso o sin datos nuevos', () => {
    const base = {
      domainId: 'd1',
      domain: 'ejemplo.es',
      lastError: 'User does not have sufficient permission',
      initialDone: true,
      today: '2026-11-26',
      thresholds: t,
    };
    expect(
      seoGscFreshnessAlerts({ ...base, connectionStatus: 'error', dataUntil: '2026-11-24' })[0]
        ?.type,
    ).toBe('gsc_access_lost');
    expect(
      seoGscFreshnessAlerts({ ...base, connectionStatus: 'connected', dataUntil: '2026-11-15' })[0]
        ?.type,
    ).toBe('gsc_stale');
    expect(
      seoGscFreshnessAlerts({ ...base, connectionStatus: 'connected', dataUntil: '2026-11-23' }),
    ).toEqual([]);
    expect(
      seoGscFreshnessAlerts({
        ...base,
        connectionStatus: 'connected',
        dataUntil: '2026-11-01',
        initialDone: false,
      }),
    ).toEqual([]);
  });

  it('ajustes: valores por defecto, límites y tipos válidos', () => {
    const s = seoAlertSettingsOf({
      thresholds: { clicksDropPct: 500, gscStaleDays: 7 },
      disabled: ['clicks_drop', 'otra'],
      email: true,
    });
    expect(s.thresholds.clicksDropPct).toBe(90);
    expect(s.thresholds.gscStaleDays).toBe(7);
    expect(s.thresholds.positionDropPlaces).toBe(3);
    expect(s.disabled).toEqual(['clicks_drop']);
    expect(s.email).toBe(true);
    expect(seoAlertSettingsOf(null).email).toBe(false);
  });

  describe('sincronización', () => {
    const cand = (key: string, type: SeoAlertCandidate['type'] = 'clicks_drop') =>
      ({ type, key, severity: 'medium', title: key, message: '', data: {} }) as SeoAlertCandidate;
    const now = new Date('2026-11-26T10:00:00Z');

    it('crea las nuevas y no repite las que siguen abiertas', () => {
      const plan = planSeoAlertSync(
        [{ id: 'a1', key: 'k1', status: 'open', silencedUntil: null }],
        [cand('k1'), cand('k2')],
        now,
      );
      expect(plan.create.map((c) => c.key)).toEqual(['k2']);
      expect(plan.touch.map((t2) => t2.id)).toEqual(['a1']);
      expect(plan.resolve).toEqual([]);
    });

    it('se resuelven solas cuando la condición desaparece (también las silenciadas)', () => {
      const plan = planSeoAlertSync(
        [
          { id: 'a1', key: 'k1', status: 'open', silencedUntil: null },
          { id: 'a2', key: 'k2', status: 'silenced', silencedUntil: '2026-12-01T00:00:00Z' },
          { id: 'a3', key: 'k3', status: 'resolved', silencedUntil: null },
        ],
        [],
        now,
      );
      expect(plan.resolve.sort()).toEqual(['a1', 'a2']);
      expect(plan.create).toEqual([]);
    });

    it('silenciada: no avisa hasta que acaba el plazo; entonces se reabre', () => {
      const silenced = (until: string) =>
        planSeoAlertSync(
          [{ id: 'a1', key: 'k1', status: 'silenced', silencedUntil: until }],
          [cand('k1')],
          now,
        );
      expect(silenced('2026-12-01T00:00:00Z').touch.map((x) => x.id)).toEqual(['a1']);
      expect(silenced('2026-11-25T00:00:00Z').reopen.map((x) => x.id)).toEqual(['a1']);
    });

    it('una resuelta que vuelve a pasar es una alerta nueva; los tipos apagados no cuentan', () => {
      const plan = planSeoAlertSync(
        [
          { id: 'a1', key: 'k1', status: 'resolved', silencedUntil: null },
          { id: 'a2', key: 'k2', status: 'open', silencedUntil: null },
        ],
        [cand('k1'), cand('k2', 'position_drop')],
        now,
        ['position_drop'],
      );
      expect(plan.create.map((c) => c.key)).toEqual(['k1']);
      expect(plan.resolve).toEqual(['a2']);
    });
  });
});

describe('informes', () => {
  it('semana ISO', () => {
    expect(seoIsoWeek('2026-11-16')).toBe('2026-W47');
    expect(seoIsoWeek('2026-11-22')).toBe('2026-W47');
    expect(seoIsoWeek('2027-01-01')).toBe('2026-W53');
  });

  it('semanal: la semana de lunes a domingo anterior y la de antes', () => {
    const p = seoReportPeriod('weekly', '2026-11-23'); // lunes
    expect(p).toMatchObject({
      from: '2026-11-16',
      to: '2026-11-22',
      previousFrom: '2026-11-09',
      previousTo: '2026-11-15',
      key: '2026-W47',
    });
    // Enviado a mano un jueves: la misma semana cerrada.
    expect(seoReportPeriod('weekly', '2026-11-26').from).toBe('2026-11-16');
  });

  it('mensual: el mes anterior completo (también en enero)', () => {
    expect(seoReportPeriod('monthly', '2026-11-03')).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      previousFrom: '2026-09-01',
      previousTo: '2026-09-30',
      key: '2026-10',
      label: 'octubre de 2026',
    });
    expect(seoReportPeriod('monthly', '2027-01-03')).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-31',
      previousFrom: '2026-11-01',
      key: '2026-12',
    });
    expect(seoReportPeriod('monthly', '2027-03-03').to).toBe('2027-02-28');
  });

  it('ajustes por defecto: mensual sí, semanal no', () => {
    expect(seoReportSettingsOf(null)).toEqual({
      weekly: false,
      monthly: true,
      recipientIds: [],
      extraEmails: [],
    });
    expect(seoReportSettingsOf({ weekly: true, extraEmails: ['A@B.es', 'a@b.es'] })).toMatchObject({
      weekly: true,
      extraEmails: ['a@b.es', 'a@b.es'],
    });
  });

  const content = (
    over: Partial<SeoReportContentDto> = {},
  ): Omit<SeoReportContentDto, 'highlights'> => ({
    period: seoReportPeriod('weekly', '2026-11-23'),
    project: { id: 'p', name: 'P', tenantId: null, domain: 'ejemplo.es' },
    complete: true,
    comparable: true,
    totals: { clicks: 120, impressions: 3000, ctr: 0.04, position: 8 },
    previous: { clicks: 100, impressions: 2800, ctr: 0.036, position: 8.5 },
    change: { clicksPct: 20, impressionsPct: 7.1, ctrDiff: 0.004, positionDiff: 0.5 },
    conversions: {
      scope: 'tenant',
      items: [
        { type: 'booking_started', count: 2, previous: 1 },
        { type: 'contact', count: 0, previous: 0 },
      ],
      revenue: null,
      rate: 0.0167,
    },
    visibility: [],
    keywordsUp: [{ keyword: 'trasteros', position: 4, previousPosition: 9, diff: 5, clicks: 10 }],
    keywordsDown: [],
    opportunities: [],
    cannibalizationsOpen: 0,
    cannibalizations: [],
    indexFindingsOpen: 0,
    changesWithResult: [],
    tasksDone: 1,
    tasksOverdue: 2,
    alerts: [],
    ...over,
  });

  it('frases en lenguaje llano con el periodo comparable', () => {
    const h = seoReportHighlights(content());
    expect(h[0]).toBe(
      'Has recibido un 20 % más de visitas desde Google que en el periodo anterior (120 clics).',
    );
    expect(h).toContain('Desde Google llegaron: 2 reservas online.');
    expect(h).toContain('La que más sube: «trasteros», 5 puestos.');
    expect(h).toContain('Hay 2 tareas SEO atrasadas.');
  });

  it('sin periodo completo no compara y lo dice', () => {
    const h = seoReportHighlights(content({ complete: false, comparable: false, change: null }));
    expect(h[0]).toContain('todavía no ha dado los datos');
    expect(h[1]).toBe('120 clics desde Google en el periodo.');
  });
});

describe('factor «La página convierte» de las oportunidades', () => {
  const base: SeoOpportunityFactorsInput = {
    impressions: 400,
    clicks: 20,
    volume: null,
    gain: null,
    position: 6,
    ctr: 0.05,
    intent: 'do',
    priority: null,
    positionDiff: null,
    impressionsPct: null,
    competition: null,
    hasGsc: true,
    hasSistrix: false,
    comparable: false,
  };

  it('sin datos de conversión la puntuación no cambia', () => {
    const a = scoreSeoOpportunity(base);
    const b = scoreSeoOpportunity({ ...base, pageConversions: null });
    const c = scoreSeoOpportunity({ ...base, pageConversions: { conversions: 5, clicks: 3 } });
    expect(b.score).toBe(a.score);
    expect(c.score).toBe(a.score);
    expect(a.factors.find((f) => f.key === 'conversions')).toBeUndefined();
  });

  it('una página que convierte bien sube la puntuación', () => {
    const a = scoreSeoOpportunity(base);
    const c = scoreSeoOpportunity({ ...base, pageConversions: { conversions: 4, clicks: 50 } });
    expect(c.score).toBeGreaterThan(a.score);
    const f = c.factors.find((x) => x.key === 'conversions');
    expect(f?.value).toBe(1);
    expect(f?.detail).toContain('4 de 50 clics');
  });
});
