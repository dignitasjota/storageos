import { z } from 'zod';

/**
 * Resumen mensual del marketing del tenant (Marketing → Resumen y correo
 * «Tu marketing en <mes>»): lo que pasó en la web y en los canales, comparado
 * con el mes anterior, y qué hacer. Los consejos se calculan aquí (sin IA)
 * para que el panel y el correo digan lo mismo.
 */

export const MARKETING_SUMMARY_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const UpdateMarketingReportSchema = z.object({ enabled: z.boolean() });
export type UpdateMarketingReportInput = z.infer<typeof UpdateMarketingReportSchema>;

export interface MarketingMonthFigures {
  /** Visitantes de la web (analítica propia). */
  visitors: number;
  /** Clics en llamar, WhatsApp, email y cómo llegar. */
  contactClicks: number;
  /** Contactos que llegaron por la web. */
  webContacts: number;
  /** Contactos nuevos de cualquier origen (también los dados de alta a mano). */
  allContacts: number;
  /** Reservas online y las que acabaron firmadas o con el primer pago. */
  bookings: number;
  signed: number;
  paid: number;
  /** Cobrado en el primer pago de esas reservas. */
  revenue: number;
  /** Gastos de la categoría Marketing del mes. */
  spend: number;
  /** Clics en los anuncios (Google Ads y Meta Ads). */
  adClicks: number;
  /** Sesiones de Google Analytics; null sin conectar. */
  ga4Sessions: number | null;
  /** Clics desde la búsqueda de Google (Search Console); null sin conectar. */
  searchClicks: number | null;
}

export interface MarketingSummarySourceDto {
  source: string;
  visitors: number;
  contacts: number;
  bookings: number;
  signed: number;
  revenue: number;
  cost: number;
  costPerBooking: number | null;
}

export interface MarketingSummaryConnections {
  ga4: boolean;
  searchConsole: boolean;
  /** Algún canal de anuncios vinculado a una campaña. */
  ads: boolean;
  /** Canales con un origen para sus enlaces (`utmSourceMatch`). */
  channelsWithLinks: number;
  /** Funciones del plan (para no sugerir lo que no tiene). */
  webPremium: boolean;
  localSeo: boolean;
}

export type MarketingTipKind = 'warning' | 'good' | 'info';

export interface MarketingTipDto {
  kind: MarketingTipKind;
  text: string;
  /** Página del panel donde actuar. */
  href: string | null;
}

export interface MarketingSummaryDto {
  /** `YYYY-MM`. */
  month: string;
  label: string;
  from: string;
  to: string;
  current: MarketingMonthFigures;
  previous: MarketingMonthFigures;
  sources: MarketingSummarySourceDto[];
  connections: MarketingSummaryConnections;
  tips: MarketingTipDto[];
  /** El correo mensual está activado. */
  reportEnabled: boolean;
}

/** Primer y último día de un mes `YYYY-MM`. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** Mes anterior a `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

/** «octubre de 2026». */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** El mes trae algo que contar (si no, el correo no se envía). */
export function hasMarketingActivity(f: MarketingMonthFigures): boolean {
  return (
    f.visitors +
      f.allContacts +
      f.bookings +
      f.spend +
      f.adClicks +
      (f.ga4Sessions ?? 0) +
      (f.searchClicks ?? 0) >
    0
  );
}

const eur = (n: number) =>
  n.toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sourceName = (s: string) => (s === 'web' ? 'directo o sin origen' : s);

/** Gasto mínimo para decir que un canal no funciona (evita avisar por 3 €). */
const WASTED_SPEND_MIN = 20;
/** Visitantes mínimos para hablar de visitas que no convierten o de tendencia. */
const VISITORS_MIN = 50;
const TREND_BASE_MIN = 20;
const MAX_TIPS = 5;

/**
 * Qué hacer este mes: primero lo que pide actuar, luego lo que funciona y al
 * final lo que falta conectar. Como mucho cinco.
 */
export function marketingSummaryTips(input: {
  current: MarketingMonthFigures;
  previous: MarketingMonthFigures;
  sources: MarketingSummarySourceDto[];
  connections: MarketingSummaryConnections;
}): MarketingTipDto[] {
  const { current: c, previous: p, sources, connections: conn } = input;
  const warnings: MarketingTipDto[] = [];
  const good: MarketingTipDto[] = [];
  const info: MarketingTipDto[] = [];

  const wasted = sources
    .filter((s) => s.cost >= WASTED_SPEND_MIN && s.bookings === 0)
    .sort((a, b) => b.cost - a.cost)[0];
  if (wasted) {
    warnings.push({
      kind: 'warning',
      text: `Gastaste ${eur(wasted.cost)} en «${sourceName(wasted.source)}» y no trajo ninguna reserva. Revisa el anuncio y la página a la que lleva, o pásale el presupuesto a lo que sí funciona.`,
      href: '/marketing/performance',
    });
  }

  const unsigned = c.bookings - c.signed;
  if (unsigned > 0) {
    warnings.push({
      kind: 'warning',
      text: `${plural(unsigned, 'reserva online sigue', 'reservas online siguen')} sin firmar. Escríbeles para que terminen: el trastero se libera a las 72 horas.`,
      href: '/contracts',
    });
  }
  const unpaid = c.signed - c.paid;
  if (unpaid > 0) {
    warnings.push({
      kind: 'warning',
      text: `${plural(unpaid, 'contrato firmado tiene', 'contratos firmados tienen')} el primer pago pendiente.`,
      href: '/invoices?status=issued',
    });
  }

  if (c.visitors >= VISITORS_MIN && c.webContacts + c.bookings === 0) {
    warnings.push({
      kind: 'warning',
      text: `La web tuvo ${c.visitors} visitantes y ningún contacto ni reserva. Comprueba en el móvil que los precios y el botón de reservar se ven a la primera.`,
      href: '/settings/web',
    });
  }

  if (p.visitors >= TREND_BASE_MIN) {
    const change = Math.round(((c.visitors - p.visitors) / p.visitors) * 100);
    if (change <= -20) {
      warnings.push({
        kind: 'warning',
        text: `Las visitas a la web bajaron un ${-change} % respecto al mes anterior. Mira en Visitas de la web qué origen ha caído.`,
        href: '/marketing/web',
      });
    } else if (change >= 20) {
      good.push({
        kind: 'good',
        text: `Las visitas a la web subieron un ${change} % respecto al mes anterior.`,
        href: '/marketing/web',
      });
    }
  }

  const paidSources = sources
    .filter((s) => s.bookings > 0 && s.cost > 0 && s.costPerBooking != null)
    .sort((a, b) => a.costPerBooking! - b.costPerBooking!);
  const best = paidSources[0];
  if (best) {
    good.push({
      kind: 'good',
      text: `«${sourceName(best.source)}» es tu canal más rentable: ${plural(best.bookings, 'reserva', 'reservas')} a ${eur(best.costPerBooking!)} cada una. Dale más presupuesto.`,
      href: '/marketing/performance',
    });
  } else {
    const top = sources
      .filter((s) => s.bookings > 0 && s.source !== 'web')
      .sort((a, b) => b.bookings - a.bookings)[0];
    if (top) {
      good.push({
        kind: 'good',
        text: `«${top.source}» te trajo ${plural(top.bookings, 'reserva', 'reservas')} sin coste. Sigue publicando ahí.`,
        href: '/marketing/web',
      });
    }
  }

  if (conn.channelsWithLinks === 0) {
    info.push({
      kind: 'info',
      text: 'Crea un enlace por canal (Instagram, un flyer, Google Ads…) en Marketing → Canales para saber cuál te trae clientes.',
      href: '/marketing/channels',
    });
  }
  if (conn.webPremium && !conn.ga4) {
    info.push({
      kind: 'info',
      text: 'Conecta Google Analytics para ver sus sesiones junto a tus visitas.',
      href: '/marketing/web',
    });
  }
  if (conn.localSeo && !conn.searchConsole) {
    info.push({
      kind: 'info',
      text: 'Conecta Search Console para saber por qué búsquedas te encuentran en Google.',
      href: '/seo',
    });
  }

  return [...warnings, ...good, ...info].slice(0, MAX_TIPS);
}
