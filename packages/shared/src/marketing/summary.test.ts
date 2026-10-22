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
  revenue: 0,
  spend: 0,
  adClicks: 0,
  ga4Sessions: null,
  searchClicks: null,
  ...over,
});

const source = (over: Partial<MarketingSummarySourceDto>): MarketingSummarySourceDto => ({
  source: 'instagram',
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
        source({ source: 'facebook', cost: 120, bookings: 0 }),
        source({ source: 'google', cost: 90, bookings: 3, costPerBooking: 30 }),
      ],
      connections: connected,
    });
    expect(tips.map((t) => t.kind)).toEqual(['warning', 'good']);
    expect(tips[0]!.text).toMatch(/120\s€/);
    expect(tips[0]!.text).toContain('facebook');
    expect(tips[1]!.text).toContain('«google»');
    expect(tips[1]!.text).toMatch(/30\s€/);
  });

  it('reservas sin firmar o sin pagar y visitas que no convierten', () => {
    const tips = marketingSummaryTips({
      current: figures({ visitors: 80, bookings: 2, signed: 1, paid: 0 }),
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
      },
    });
    expect(noPlan).toEqual([]);
  });

  it('nunca da más de cinco consejos', () => {
    const tips = marketingSummaryTips({
      current: figures({ visitors: 100, bookings: 3, signed: 1 }),
      previous: figures({ visitors: 300 }),
      sources: [source({ source: 'facebook', cost: 50 })],
      connections: { ...connected, ga4: false, searchConsole: false, channelsWithLinks: 0 },
    });
    expect(tips).toHaveLength(5);
  });
});
