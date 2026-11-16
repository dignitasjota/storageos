import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  NON_CASH_PAYMENT_METHODS,
  WEB_ANALYTICS_DAYS,
  WEB_ANALYTICS_START,
  channelReportSource,
  deviceFromUserAgent,
  isAdChannel,
  isBotUserAgent,
  isValidWebPath,
  normalizeWebPath,
  trafficKey,
  type WebAnalyticsDto,
  type WebAnalyticsFunnelDto,
  type WebAnalyticsPageDto,
  type WebAnalyticsSourceDto,
  type WebEventInput,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { todayInTimezone, zonedDayStart } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { QUEUE_BILLING } from '../queues/queues.module';

import { FULL_MARKETING_VIEWER, inViewerScope, type MarketingViewer } from './marketing-viewer';

/** Una página vista cuenta una vez por visitante y página cada 30 minutos. */
const PAGE_VIEW_WINDOW_MS = 30 * 60_000;
/** Un clic de contacto repetido en 10 s (doble toque) cuenta una vez. */
const CLICK_WINDOW_MS = 10_000;
/** Eventos por IP y día: de sobra para una persona o una oficina, un freno para un script. */
const EVENTS_PER_IP_DAY = 1500;
/** Eventos por negocio y día: tope ante un ataque desde muchas IP. */
const EVENTS_PER_TENANT_DAY = 50_000;
/** El informe se calcula en la base de datos; con mucho tráfico tarda más de 5 s. */
const REPORT_TIMEOUT_MS = 20_000;

const round2 = (n: number) => Math.round(n * 100) / 100;
const lower = (v: string | null | undefined) => (v ? v.toLowerCase() : null);

const emptyFunnel = (): WebAnalyticsFunnelDto => ({
  visitors: 0,
  pageViews: 0,
  calls: 0,
  whatsapp: 0,
  emails: 0,
  directions: 0,
  contacts: 0,
  bookings: 0,
  signed: 0,
  paid: 0,
  revenue: 0,
});

const CLICK_FIELD = {
  call_click: 'calls',
  whatsapp_click: 'whatsapp',
  email_click: 'emails',
  directions_click: 'directions',
} as const;

/** `YYYY-MM-DD` desplazado `n` días. */
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días de `from` a `to` (incluidos). */
function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDay(d, 1)) out.push(d);
  return out;
}

/**
 * Analítica propia de la web del tenant: visitas y clics de contacto con su
 * origen, y el embudo hasta el contrato pagado. Sin IP ni datos personales.
 */
@Injectable()
export class WebAnalyticsService {
  private readonly logger = new Logger(WebAnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    @InjectQueue(QUEUE_BILLING) private readonly queue: Queue,
  ) {}

  /** Anota una página vista o un clic de contacto (best-effort, nunca lanza). */
  async record(
    slug: string,
    input: WebEventInput,
    userAgent: string | undefined,
    ip?: string,
  ): Promise<void> {
    if (isBotUserAgent(userAgent)) return;
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: { id: true, deletedAt: true, status: true },
    });
    // Un negocio suspendido o dado de baja no mide.
    if (
      !tenant ||
      tenant.deletedAt ||
      tenant.status === 'suspended' ||
      tenant.status === 'cancelled'
    ) {
      return;
    }
    const path = normalizeWebPath(input.path, slug);
    // Solo rutas que pueden ser de la web: lo demás es basura o un intento de colarla.
    if (!isValidWebPath(path)) return;
    if (!(await this.allow(tenant.id, ip))) return;
    const window = input.kind === 'page_view' ? PAGE_VIEW_WINDOW_MS : CLICK_WINDOW_MS;
    const recent = await this.admin.webEvent.findFirst({
      where: {
        tenantId: tenant.id,
        visitorId: input.visitorId,
        kind: input.kind,
        path,
        createdAt: { gte: new Date(Date.now() - window) },
      },
      select: { id: true },
    });
    if (recent) return;
    await this.admin.webEvent.create({
      data: {
        tenantId: tenant.id,
        visitorId: input.visitorId,
        kind: input.kind,
        path,
        source: lower(input.source),
        medium: lower(input.medium),
        campaign: lower(input.campaign),
        device: deviceFromUserAgent(userAgent),
      },
    });
  }

  /**
   * Tope de eventos por IP y día y por negocio y día (en Redis). Sin Redis deja
   * pasar: un fallo de infraestructura no debe dejar de medir.
   */
  private async allow(tenantId: string, ip: string | undefined): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const client = await this.queue.client;
      const bump = async (key: string) => {
        const n = await client.incr(key);
        if (n === 1) await client.expire(key, 26 * 3600);
        return n;
      };
      if ((await bump(`wa:tenant:${tenantId}:${day}`)) > EVENTS_PER_TENANT_DAY) return false;
      if (ip) {
        const hashed = createHash('sha256').update(ip).digest('hex').slice(0, 24);
        if ((await bump(`wa:ip:${tenantId}:${hashed}:${day}`)) > EVENTS_PER_IP_DAY) return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `[web-analytics] contador sin Redis: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  /**
   * Informe de los últimos `days` días (7, 30 o 90) contados en la zona del
   * negocio, con hoy incluido, frente al periodo anterior de la misma duración.
   */
  async report(
    tenantId: string,
    daysInput: number,
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<WebAnalyticsDto> {
    const days = (WEB_ANALYTICS_DAYS as readonly number[]).includes(daysInput) ? daysInput : 30;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const tz = tenant?.timezone || 'Europe/Madrid';
    const today = todayInTimezone(tz).toISOString().slice(0, 10);
    const fromDay = shiftDay(today, -(days - 1));
    return this.reportRange(
      tenantId,
      { since: zonedDayStart(fromDay, tz), until: new Date(), fromDay, toDay: today },
      days,
      viewer,
    );
  }

  /**
   * Informe de `[since, until)` frente al periodo anterior de la misma
   * duración (lo usa también el resumen mensual de marketing). Se calcula en
   * la base de datos: no carga los eventos uno a uno.
   */
  async reportRange(
    tenantId: string,
    range: { since: Date; until: Date; fromDay?: string; toDay?: string },
    days: number,
    viewer: MarketingViewer = FULL_MARKETING_VIEWER,
  ): Promise<WebAnalyticsDto> {
    const { since, until } = range;
    const prevSince = new Date(since.getTime() - (until.getTime() - since.getTime()));

    const data = await this.prisma.withTenant(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { timezone: true, createdAt: true },
        });
        const tz = tenant?.timezone || 'Europe/Madrid';
        const inRange = Prisma.sql`tenant_id = ${tenantId}::uuid AND created_at >= ${since} AND created_at < ${until}`;
        const counts = await tx.$queryRaw<
          { source: string | null; medium: string | null; kind: string; n: number }[]
        >`SELECT source, medium, kind, COUNT(*)::int AS n
            FROM web_events WHERE ${inRange}
           GROUP BY 1, 2, 3`;
        const sourceVisitors = await tx.$queryRaw<
          { source: string | null; medium: string | null; n: number }[]
        >`SELECT source, medium, COUNT(DISTINCT visitor_id)::int AS n
            FROM web_events WHERE ${inRange} AND kind = 'page_view'
           GROUP BY 1, 2`;
        const [visitorsRow] = await tx.$queryRaw<{ n: number }[]>`
          SELECT COUNT(DISTINCT visitor_id)::int AS n
            FROM web_events WHERE ${inRange} AND kind = 'page_view'`;
        const dailyRows = await tx.$queryRaw<{ day: string; views: number; visitors: number }[]>`
          SELECT to_char(created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
                 COUNT(*)::int AS views,
                 COUNT(DISTINCT visitor_id)::int AS visitors
            FROM web_events WHERE ${inRange} AND kind = 'page_view'
           GROUP BY 1`;
        const pageRows = await tx.$queryRaw<
          { path: string; views: number; visitors: number; clicks: number }[]
        >`SELECT path,
                 COUNT(*) FILTER (WHERE kind = 'page_view')::int AS views,
                 COUNT(DISTINCT visitor_id) FILTER (WHERE kind = 'page_view')::int AS visitors,
                 COUNT(*) FILTER (WHERE kind <> 'page_view')::int AS clicks
            FROM web_events WHERE ${inRange}
           GROUP BY path
           ORDER BY views DESC
           LIMIT 15`;
        // El dispositivo con el que entró cada visitante (su primera página).
        const deviceRows = await tx.$queryRaw<{ device: string; n: number }[]>`
          SELECT d.device, COUNT(*)::int AS n
            FROM (SELECT DISTINCT ON (visitor_id) visitor_id, device
                    FROM web_events
                   WHERE ${inRange} AND kind = 'page_view' AND device IS NOT NULL
                   ORDER BY visitor_id, created_at) d
           GROUP BY d.device`;
        const [prevRow] = await tx.$queryRaw<{ n: number }[]>`
          SELECT COUNT(DISTINCT visitor_id)::int AS n
            FROM web_events
           WHERE tenant_id = ${tenantId}::uuid AND kind = 'page_view'
             AND created_at >= ${prevSince} AND created_at < ${since}`;
        // Contactos que llegaron por la web: con origen o creados desde la web.
        const leads = await tx.lead.findMany({
          where: {
            deletedAt: null,
            OR: [
              { utmSource: { not: null } },
              { source: { in: ['web', 'widget', 'landing', 'web_chat'] } },
            ],
            // Las reservas del asistente de WhatsApp no son de la web.
            NOT: [{ source: 'whatsapp' }, { utmSource: 'whatsapp', utmMedium: 'asistente' }],
            AND: [
              {
                OR: [
                  { createdAt: { gte: prevSince, lt: until } },
                  { wonAt: { gte: prevSince, lt: until } },
                  { bookedAt: { gte: prevSince, lt: until } },
                ],
              },
            ],
          },
          select: {
            utmSource: true,
            utmMedium: true,
            createdAt: true,
            wonAt: true,
            bookedAt: true,
            convertedContractId: true,
            preferredFacilityId: true,
            metadata: true,
          },
        });
        const channels = await tx.marketingChannel.findMany({
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            utmSourceMatch: true,
            externalCampaignId: true,
            externalUrl: true,
            facilityId: true,
            createdAt: true,
          },
        });
        const fromDay = range.fromDay ?? since.toISOString().slice(0, 10);
        const toDay = range.toDay ?? new Date(until.getTime() - 1).toISOString().slice(0, 10);
        const expenses = await tx.expense.findMany({
          where: {
            marketingChannelId: { not: null },
            expenseDate: { gte: new Date(fromDay), lte: new Date(toDay) },
          },
          select: { marketingChannelId: true, amount: true },
        });
        return {
          tenant,
          tz,
          fromDay,
          toDay,
          counts,
          sourceVisitors,
          visitors: visitorsRow?.n ?? 0,
          dailyRows,
          pageRows,
          deviceRows,
          prevVisitors: prevRow?.n ?? 0,
          leads,
          channels,
          expenses,
        };
      },
      tenantId,
      { timeout: REPORT_TIMEOUT_MS },
    );

    const dayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: data.tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const keyOf = (d: Date) => dayKey.format(d);

    // Embudo por origen: el tráfico de pago va en una fila aparte de la orgánica.
    const bySource = new Map<string, WebAnalyticsSourceDto>();
    const sourceRow = (touch: { source: string | null | undefined; medium?: string | null }) => {
      const k = trafficKey(touch);
      const key = `${k.source}|${k.paid ? 'paid' : 'free'}`;
      let r = bySource.get(key);
      if (!r) {
        r = {
          source: k.source,
          paidTraffic: k.paid,
          ...emptyFunnel(),
          cost: 0,
          costPerBooking: null,
        };
        bySource.set(key, r);
      }
      return r;
    };

    const totals = { ...emptyFunnel(), cost: 0, pendingSignature: 0, signedUnpaid: 0 };
    for (const c of data.counts) {
      const src = sourceRow(c);
      if (c.kind === 'page_view') {
        src.pageViews += c.n;
        totals.pageViews += c.n;
      } else if (c.kind in CLICK_FIELD) {
        const field = CLICK_FIELD[c.kind as keyof typeof CLICK_FIELD];
        src[field] += c.n;
        totals[field] += c.n;
      }
    }
    // Visitantes por origen (un mismo visitante con dos orígenes cuenta en los dos).
    for (const v of data.sourceVisitors) sourceRow(v).visitors += v.n;
    totals.visitors = data.visitors;

    const daily = new Map<string, { visitors: number; pageViews: number; contacts: number }>();
    for (const d of dayRange(data.fromDay, data.toDay)) {
      daily.set(d, { visitors: 0, pageViews: 0, contacts: 0 });
    }
    for (const r of data.dailyRows) {
      const d = daily.get(r.day);
      if (d) {
        d.visitors = r.visitors;
        d.pageViews = r.views;
      }
    }

    // Contactos y contratos por origen (con el primer pago).
    let prevContacts = 0;
    let prevBookings = 0;
    const converted: { cid: string; touch: { source: string | null; medium: string | null } }[] =
      [];
    for (const l of data.leads) {
      // Con alcance por local: los contactos de sus locales (y los que no eligieron ninguno).
      if (!inViewerScope(viewer, l.preferredFacilityId)) continue;
      const touch = { source: l.utmSource, medium: l.utmMedium };
      if (l.createdAt >= since && l.createdAt < until) {
        sourceRow(touch).contacts += 1;
        totals.contacts += 1;
        const d = daily.get(keyOf(l.createdAt));
        if (d) d.contacts += 1;
      } else if (l.createdAt >= prevSince && l.createdAt < since) {
        prevContacts += 1;
      }
      // La reserva online cuenta el día que se hizo y para el origen de la visita
      // en la que reservó, como las visitas: el contacto puede haber llegado
      // antes por otro sitio. Un contacto ganado en la oficina no es una
      // reserva online.
      const bookedAt = l.bookedAt;
      if (l.convertedContractId && bookedAt && bookedAt < until) {
        const bookingTouch = bookingUtmOf(l.metadata);
        if (bookedAt >= since) {
          converted.push({ cid: l.convertedContractId, touch: bookingTouch ?? touch });
        } else if (bookedAt >= prevSince) prevBookings += 1;
      }
    }
    const firstPayments = await this.firstPayments(tenantId, [
      ...new Set(converted.map((c) => c.cid)),
    ]);
    const seen = new Set<string>();
    for (const { cid, touch } of converted) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      const fp = firstPayments.get(cid);
      // Con alcance por local: solo las reservas de sus locales.
      if (fp && !inViewerScope(viewer, fp.facilityId)) continue;
      const r = sourceRow(touch);
      r.bookings += 1;
      totals.bookings += 1;
      if (fp?.signed) {
        r.signed += 1;
        totals.signed += 1;
      }
      if (fp?.paid) {
        r.paid += 1;
        totals.paid += 1;
      }
      // Lo pendiente, solo de las que siguen en pie (una caducada ya no se firma ni se paga).
      if (fp?.live && !fp.signed) totals.pendingSignature += 1;
      if (fp?.live && fp.signed && !fp.paid) totals.signedUnpaid += 1;
      if (fp && viewer.revenue) {
        r.revenue += fp.revenue;
        totals.revenue += fp.revenue;
      }
    }

    // Gasto de cada canal en la fila de su origen (los de anuncios, en la de pago).
    // También el de un canal ya borrado: el dinero se gastó.
    const channelById = new Map(data.channels.map((c) => [c.id, c]));
    for (const e of viewer.cost ? data.expenses : []) {
      const channel = channelById.get(e.marketingChannelId!);
      const source = channel ? channelReportSource(channel) : null;
      if (!channel || !source || !inViewerScope(viewer, channel.facilityId)) continue;
      const amount = Number(e.amount);
      const row = sourceRow({ source, medium: isAdChannel(channel) ? 'cpc' : null });
      row.cost += amount;
      totals.cost += amount;
    }

    const sources: WebAnalyticsSourceDto[] = [...bySource.values()]
      .map((r) => ({
        ...r,
        revenue: round2(r.revenue),
        cost: round2(r.cost),
        costPerBooking: r.bookings > 0 && r.cost > 0 ? round2(r.cost / r.bookings) : null,
      }))
      .filter((r) => r.pageViews + r.contacts + r.bookings + r.cost + r.calls + r.whatsapp > 0)
      .sort((a, b) => b.visitors - a.visitors || b.contacts - a.contacts);

    // El periodo anterior solo es comparable si el negocio y la medición ya existían.
    const measuredFrom = Math.max(
      data.tenant?.createdAt.getTime() ?? 0,
      zonedDayStart(WEB_ANALYTICS_START, data.tz).getTime(),
    );
    const pages: WebAnalyticsPageDto[] = data.pageRows.map((p) => ({
      path: p.path,
      pageViews: p.views,
      visitors: p.visitors,
      contactClicks: p.clicks,
    }));
    const deviceCount = new Map(data.deviceRows.map((d) => [d.device, d.n]));

    return {
      days,
      from: data.fromDay,
      to: data.toDay,
      totals: { ...totals, revenue: round2(totals.revenue), cost: round2(totals.cost) },
      previous: { visitors: data.prevVisitors, contacts: prevContacts, bookings: prevBookings },
      previousComplete: prevSince.getTime() >= measuredFrom,
      money: { revenue: viewer.revenue, cost: viewer.cost },
      daily: [...daily.entries()].map(([date, d]) => ({ date, ...d })),
      sources,
      pages,
      devices: (['mobile', 'desktop', 'tablet'] as const)
        .map((device) => ({ device, visitors: deviceCount.get(device) ?? 0 }))
        .filter((d) => d.visitors > 0),
    };
  }

  /**
   * Primer pago de cada contrato reservado: firmado, la primera factura que
   * sigue en pie pagada y lo cobrado de verdad en ella (sin IVA, sin
   * compensaciones con abonos ni retención y descontando las devoluciones).
   */
  private async firstPayments(
    tenantId: string,
    contractIds: string[],
  ): Promise<Map<string, FirstPayment>> {
    const out = new Map<string, FirstPayment>();
    if (contractIds.length === 0) return out;
    return this.prisma.withTenant(async (tx) => {
      const contracts = await tx.contract.findMany({
        where: { id: { in: contractIds } },
        select: {
          id: true,
          signedAt: true,
          status: true,
          deletedAt: true,
          unit: { select: { facilityId: true } },
        },
      });
      // La primera factura que sigue en pie (una anulada y rehecha no cuenta).
      const invoices = await tx.invoice.findMany({
        where: {
          contractId: { in: contractIds },
          kind: 'invoice',
          deletedAt: null,
          status: { notIn: ['draft', 'cancelled', 'rectified'] },
        },
        select: { id: true, contractId: true, status: true, subtotal: true, total: true },
        orderBy: { createdAt: 'asc' },
      });
      const first = new Map<string, (typeof invoices)[number]>();
      for (const inv of invoices) {
        if (inv.contractId && !first.has(inv.contractId)) first.set(inv.contractId, inv);
      }
      const payments = await tx.payment.findMany({
        where: {
          invoiceId: { in: [...first.values()].map((i) => i.id) },
          status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
          methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
        },
        select: { invoiceId: true, amount: true, refundedAmount: true },
      });
      const cashBy = new Map<string, number>();
      for (const p of payments) {
        const cash = Number(p.amount) - Number(p.refundedAmount);
        cashBy.set(p.invoiceId!, (cashBy.get(p.invoiceId!) ?? 0) + cash);
      }
      for (const c of contracts) {
        const inv = first.get(c.id);
        const total = inv ? Number(inv.total) : 0;
        const cash = inv ? (cashBy.get(inv.id) ?? 0) : 0;
        // Sin IVA: la parte de la base en lo cobrado.
        const revenue = inv && total > 0 ? (cash * Number(inv.subtotal)) / total : cash;
        out.set(c.id, {
          signed: !!c.signedAt,
          paid: inv?.status === 'paid',
          revenue: Math.max(0, revenue),
          facilityId: c.unit?.facilityId ?? null,
          live: !c.deletedAt && c.status !== 'cancelled' && c.status !== 'ended',
        });
      }
      return out;
    }, tenantId);
  }
}

/** Lo que pasó con una reserva: firmada, primer pago cobrado y si sigue en pie. */
interface FirstPayment {
  signed: boolean;
  paid: boolean;
  revenue: number;
  facilityId: string | null;
  /** No está cancelada (una reserva caducada se cancela) ni terminada. */
  live: boolean;
}

/** Origen de la visita en la que se hizo la reserva (`metadata.bookingUtm`), si lo hay. */
function bookingUtmOf(metadata: unknown): { source: string | null; medium: string | null } | null {
  const utm = (metadata as { bookingUtm?: { source?: unknown; medium?: unknown } } | null)
    ?.bookingUtm;
  if (!utm || typeof utm.source !== 'string' || !utm.source) return null;
  return { source: utm.source, medium: typeof utm.medium === 'string' ? utm.medium : null };
}
