import { describe, expect, it } from 'vitest';

import {
  hasMarketingActivity,
  marketingSummaryTips,
  monthBounds,
  previousMonth,
  type MarketingMonthFigures,
  type MarketingSummaryConnections,
  type MarketingSummarySourceDto,
} from './summary';

const figures = (over: Partial<MarketingMonthFigures> = {}): MarketingMonthFigures => ({
  visitors: 0,
  contactClicks: 0,
  webContacts: 0,
  allContacts: 0,
  bookings: 0,
  signed: 0,
  paid: 0,
  pendingSignature: 0,
  signedUnpaid: 0,
  revenue: 0,
  spend: 0,
  adClicks: 0,
  ga4Sessions: null,
  searchClicks: null,
  socialFollowers: null,
  socialReach: null,
  ...over,
});

const source = (over: Partial<MarketingSummarySourceDto>): MarketingSummarySourceDto => ({
  source: 'instagram',
  paidTraffic: false,
  visitors: 0,
  contacts: 0,
  bookings: 0,
  signed: 0,
  revenue: 0,
  cost: 0,
  costPerBooking: null,
  ...over,
});

const connected: MarketingSummaryConnections = {
  ga4: true,
  searchConsole: true,
  ads: true,
  channelsWithLinks: 2,
  webPremium: true,
  localSeo: true,
  social: true,
};

describe('meses', () => {
  it('calcula los límites y el mes anterior', () => {
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthBounds('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(previousMonth('2026-01')).toBe('2025-12');
  });

  it('un mes vacío no tiene actividad', () => {
    expect(hasMarketingActivity(figures())).toBe(false);
    expect(hasMarketingActivity(figures({ spend: 30 }))).toBe(true);
    expect(hasMarketingActivity(figures({ searchClicks: 12 }))).toBe(true);
  });
});

describe('marketingSummaryTips', () => {
  it('avisa primero del gasto que no trae reservas y destaca el canal más rentable', () => {
    const tips = marketingSummaryTips({
      current: figures({ visitors: 200, webContacts: 5, bookings: 3, signed: 3, paid: 3 }),
      previous: figures({ visitors: 190 }),
      sources: [
        source({ source: 'meta', paidTraffic: true, cost: 120, bookings: 0 }),
        source({ source: 'google', paidTraffic: true, cost: 90, bookings: 3, costPerBooking: 30 }),
      ],
      connections: connected,
    });
    expect(tips.map((t) => t.kind)).toEqual(['warning', 'good']);
    expect(tips[0]!.text).toMatch(/120\s€/);
    expect(tips[0]!.text).toContain('«Anuncios de Meta (Facebook e Instagram)»');
    expect(tips[1]!.text).toContain('«Anuncios de Google»');
    expect(tips[1]!.text).toMatch(/30\s€/);
  });

  it('reservas sin firmar o sin pagar y visitas que no convierten', () => {
    const tips = marketingSummaryTips({
      current: figures({
        visitors: 80,
        bookings: 3,
        signed: 1,
        paid: 0,
        // Una de las dos sin firmar ya caducó: solo cuenta la que sigue en pie.
        pendingSignature: 1,
        signedUnpaid: 1,
      }),
      previous: figures(),
      sources: [],
      connections: connected,
    });
    expect(tips.map((t) => t.text)).toEqual([
      expect.stringContaining('1 reserva online sigue sin firmar'),
      expect.stringContaining('1 contrato firmado tiene el primer pago pendiente'),
    ]);

    const noContacts = marketingSummaryTips({
      current: figures({ visitors: 80 }),
      previous: figures(),
      sources: [],
      connections: connected,
    });
    expect(noContacts[0]!.href).toBe('/settings/web');
  });

  it('tendencia de las visitas y lo que falta conectar según el plan', () => {
    const down = marketingSummaryTips({
      current: figures({ visitors: 30, webContacts: 1 }),
      previous: figures({ visitors: 60 }),
      sources: [],
      connections: { ...connected, ga4: false, searchConsole: false, channelsWithLinks: 0 },
    });
    expect(down.map((t) => t.kind)).toEqual(['warning', 'info', 'info', 'info']);
    expect(down[0]!.text).toContain('50 %');

    const noPlan = marketingSummaryTips({
      current: figures(),
      previous: figures(),
      sources: [],
      connections: {
        ...connected,
        ga4: false,
        searchConsole: false,
        webPremium: false,
        localSeo: false,
        social: false,
      },
    });
    expect(noPlan).toEqual([]);
  });

  it('nunca da más de cinco consejos', () => {
    const tips = marketingSummaryTips({
      current: figures({
        visitors: 100,
        bookings: 3,
        signed: 1,
        pendingSignature: 2,
        signedUnpaid: 1,
      }),
      previous: figures({ visitors: 300 }),
      sources: [source({ source: 'facebook', cost: 50 })],
      connections: { ...connected, ga4: false, searchConsole: false, channelsWithLinks: 0 },
    });
    expect(tips).toHaveLength(5);
  });

  it('redes: alcance sin visitas a la web, subida del alcance y conectar', () => {
    const tips = marketingSummaryTips({
      current: figures({ socialReach: 2400 }),
      previous: figures({ socialReach: 1000 }),
      sources: [],
      connections: connected,
    });
    expect(tips.map((t) => [t.kind, t.href])).toEqual([
      ['warning', '/marketing/channels'],
      ['good', '/marketing/social'],
    ]);
    expect(tips[0]!.text).toContain('sumaron 2400 de alcance');

    // Con visitas desde Instagram no avisa.
    const fine = marketingSummaryTips({
      current: figures({ socialReach: 2400 }),
      previous: figures(),
      sources: [source({ source: 'instagram', visitors: 12 })],
      connections: connected,
    });
    expect(fine).toEqual([]);

    const notConnected = marketingSummaryTips({
      current: figures(),
      previous: figures(),
      sources: [],
      connections: { ...connected, social: false },
    });
    expect(notConnected.map((t) => t.href)).toEqual(['/marketing/social']);
  });

  it('el canal más rentable necesita dos reservas, y los de Meta cuentan como redes', () => {
    const one = marketingSummaryTips({
      current: figures({ visitors: 10, bookings: 1 }),
      previous: figures(),
      sources: [
        source({ source: 'google', paidTraffic: true, cost: 30, bookings: 1, costPerBooking: 30 }),
      ],
      connections: connected,
    });
    expect(one.some((t) => t.text.includes('más rentable'))).toBe(false);

    // `ig` (Meta Ads) e `instagram_feed` son visitas desde las redes.
    const ig = marketingSummaryTips({
      current: figures({ socialReach: 2400 }),
      previous: figures(),
      sources: [source({ source: 'instagram_feed', visitors: 3 })],
      connections: connected,
    });
    expect(ig).toEqual([]);
  });

  it('sin datos de todo el mes anterior no hay tendencias, y sin permiso no se habla del gasto', () => {
    const partial = marketingSummaryTips({
      current: figures({ visitors: 30, webContacts: 1, socialReach: 2400 }),
      previous: figures({ visitors: 60, socialReach: 1000 }),
      sources: [source({ source: 'instagram', visitors: 3 })],
      connections: connected,
      previousComplete: { web: false, ga4: false, social: false },
    });
    expect(partial).toEqual([]);

    const noMoney = marketingSummaryTips({
      current: figures({ visitors: 10, webContacts: 1 }),
      previous: figures(),
      sources: [source({ source: 'meta', paidTraffic: true, cost: 120, bookings: 0 })],
      connections: connected,
      money: { revenue: false, cost: false },
    });
    expect(noMoney).toEqual([]);
  });
});
