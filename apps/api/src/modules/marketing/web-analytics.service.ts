import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  type CreateMarketingAnnotationInput,
  type MarketingAnnotationDto,
  type WebAnalyticsDto,
  type WebAnalyticsFunnelDto,
  type WebAnalyticsPageDto,
  type WebAnalyticsSourceDto,
  type WebDemandDto,
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

/** `YYYY-MM-DD` desplazado `n` días. */
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Día (`YYYY-MM-DD`) de un momento en la zona del negocio. */
function localDayOf(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
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
      select: { id: true, deletedAt: true, status: true, timezone: true },
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
    const now = new Date();
    const tz = tenant.timezone || 'Europe/Madrid';
    const day = localDayOf(now, tz);
    const dayStart = zonedDayStart(day, tz);
    const isStart = input.kind === 'booking_start';
    // La reserva empezada solo cuenta con un local de este negocio.
    const facilityId = isStart ? await this.ownFacility(tenant.id, input.facilityId) : null;
    const unitTypeId =
      isStart && facilityId ? await this.ownUnitType(tenant.id, input.unitTypeId) : null;
    if (isStart && !facilityId) return;

    const window = input.kind === 'page_view' || isStart ? PAGE_VIEW_WINDOW_MS : CLICK_WINDOW_MS;
    const windowStart = new Date(now.getTime() - window);
    // La última vez de hoy (o de la ventana, si empieza ayer): repetida → no cuenta,
    // y si no la hay hoy es un visitante nuevo de esa página.
    const last = await this.admin.webEvent.findFirst({
      where: {
        tenantId: tenant.id,
        visitorId: input.visitorId,
        kind: input.kind,
        ...(isStart ? { facilityId, unitTypeId } : { path }),
        createdAt: { gte: windowStart < dayStart ? windowStart : dayStart },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && last.createdAt >= windowStart) return;
    const firstToday = !last || last.createdAt < dayStart;

    const source = lower(input.source);
    const medium = lower(input.medium);
    const campaign = lower(input.campaign);
    const device = deviceFromUserAgent(userAgent);
    await this.admin.webEvent.create({
      data: {
        tenantId: tenant.id,
        visitorId: input.visitorId,
        kind: input.kind,
        path,
        source,
        medium,
        campaign,
        device,
        facilityId,
        unitTypeId,
      },
    });
    await this.addToTotals(tenant.id, day, {
      visitorId: input.visitorId,
      kind: input.kind,
      path,
      source: source ?? '',
      medium: medium ?? '',
      campaign: campaign ?? '',
      device,
      firstToday,
    });
  }

  /**
   * Suma el evento a las visitas del día (por visitante y origen) y a las de
   * la página. Si falla, el evento ya está guardado: no se pierde.
   */
  private async addToTotals(
    tenantId: string,
    day: string,
    e: {
      visitorId: string;
      kind: WebEventInput['kind'];
      path: string;
      source: string;
      medium: string;
      campaign: string;
      device: string | null;
      firstToday: boolean;
    },
  ): Promise<void> {
    const n = (kind: WebEventInput['kind']) => (e.kind === kind ? 1 : 0);
    try {
      await this.admin.$executeRaw`
        INSERT INTO web_visits (tenant_id, day, visitor_id, source, medium, campaign, device,
                                entry_path, page_views, calls, whatsapp, emails, directions,
                                booking_starts)
        VALUES (${tenantId}::uuid, ${day}::date, ${e.visitorId}, ${e.source}, ${e.medium},
                ${e.campaign}, ${e.device}, ${e.path}, ${n('page_view')}, ${n('call_click')},
                ${n('whatsapp_click')}, ${n('email_click')}, ${n('directions_click')},
                ${n('booking_start')})
        ON CONFLICT (tenant_id, day, visitor_id, source, medium, campaign) DO UPDATE SET
          page_views = web_visits.page_views + EXCLUDED.page_views,
          calls = web_visits.calls + EXCLUDED.calls,
          whatsapp = web_visits.whatsapp + EXCLUDED.whatsapp,
          emails = web_visits.emails + EXCLUDED.emails,
          directions = web_visits.directions + EXCLUDED.directions,
          booking_starts = web_visits.booking_starts + EXCLUDED.booking_starts,
          device = COALESCE(web_visits.device, EXCLUDED.device),
          -- La página de entrada es la primera vista; un clic antes de verla no cuenta.
          entry_path = CASE WHEN web_visits.page_views = 0 AND EXCLUDED.page_views > 0
                            THEN EXCLUDED.entry_path ELSE web_visits.entry_path END`;
      if (e.kind === 'booking_start') return;
      const view = e.kind === 'page_view' ? 1 : 0;
      await this.admin.$executeRaw`
        INSERT INTO web_page_daily (tenant_id, day, path, views, visitors, clicks)
        VALUES (${tenantId}::uuid, ${day}::date, ${e.path}, ${view},
                ${view && e.firstToday ? 1 : 0}, ${1 - view})
        ON CONFLICT (tenant_id, day, path) DO UPDATE SET
          views = web_page_daily.views + EXCLUDED.views,
          visitors = web_page_daily.visitors + EXCLUDED.visitors,
          clicks = web_page_daily.clicks + EXCLUDED.clicks`;
    } catch (err) {
      this.logger.warn(
        `[web-analytics] no se pudo sumar la visita: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async addAnnotation(
    tenantId: string,
    userId: string,
    input: CreateMarketingAnnotationInput,
  ): Promise<MarketingAnnotationDto> {
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.marketingAnnotation.create({
        data: {
          tenantId,
          day: new Date(`${input.day}T00:00:00.000Z`),
          text: input.text,
          createdByUserId: userId,
        },
      });
      return {
        id: row.id,
        day: row.day.toISOString().slice(0, 10),
        text: row.text,
        kind: 'manual',
      };
    }, tenantId);
  }

  async removeAnnotation(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const deleted = await tx.marketingAnnotation.deleteMany({ where: { id } });
      if (deleted.count === 0) {
        throw new NotFoundException({ code: 'annotation_not_found', message: 'La nota no existe' });
      }
    }, tenantId);
  }

  private async ownFacility(tenantId: string, id: string | undefined): Promise<string | null> {
    if (!id) return null;
    const found = await this.admin.facility.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    return found?.id ?? null;
  }

  private async ownUnitType(tenantId: string, id: string | undefined): Promise<string | null> {
    if (!id) return null;
    const found = await this.admin.unitType.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    return found?.id ?? null;
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
        const localDay = (d: Date) => localDayOf(d, tz);
        const fromDay = range.fromDay ?? localDay(since);
        const toDay = range.toDay ?? localDay(new Date(until.getTime() - 1));
        const spanDays = dayRange(fromDay, toDay).length;
        const prevFrom = shiftDay(fromDay, -spanDays);
        const prevTo = shiftDay(fromDay, -1);
        const visits = Prisma.sql`tenant_id = ${tenantId}::uuid
          AND day >= ${fromDay}::date AND day <= ${toDay}::date`;
        const rawRange = Prisma.sql`tenant_id = ${tenantId}::uuid
          AND created_at >= ${since} AND created_at < ${until}`;

        // Visitas ya sumadas: un registro por visitante, día y origen.
        const bySourceRows = await tx.$queryRaw<
          {
            source: string;
            medium: string;
            page_views: number;
            calls: number;
            whatsapp: number;
            emails: number;
            directions: number;
            visitors: number;
          }[]
        >`SELECT source, medium,
                 SUM(page_views)::int AS page_views, SUM(calls)::int AS calls,
                 SUM(whatsapp)::int AS whatsapp, SUM(emails)::int AS emails,
                 SUM(directions)::int AS directions,
                 COUNT(DISTINCT visitor_id) FILTER (WHERE page_views > 0)::int AS visitors
            FROM web_visits WHERE ${visits}
           GROUP BY 1, 2`;
        const [visitorRow] = await tx.$queryRaw<
          { visitors: number; returning: number; started: number }[]
        >`SELECT COUNT(DISTINCT v.visitor_id) FILTER (WHERE v.page_views > 0)::int AS visitors,
                 COUNT(DISTINCT v.visitor_id) FILTER (
                   WHERE v.page_views > 0 AND EXISTS (
                     SELECT 1 FROM web_visits p
                      WHERE p.tenant_id = v.tenant_id AND p.visitor_id = v.visitor_id
                        AND p.day < ${fromDay}::date))::int AS returning,
                 COUNT(DISTINCT v.visitor_id) FILTER (WHERE v.booking_starts > 0)::int AS started
            FROM web_visits v WHERE ${visits}`;
        const dailyRows = await tx.$queryRaw<{ day: string; views: number; visitors: number }[]>`
          SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(page_views)::int AS views,
                 COUNT(DISTINCT visitor_id) FILTER (WHERE page_views > 0)::int AS visitors
            FROM web_visits WHERE ${visits}
           GROUP BY 1`;
        // La página por la que más se entra desde cada origen.
        const entryRows = await tx.$queryRaw<{ source: string; medium: string; path: string }[]>`
          SELECT DISTINCT ON (source, medium) source, medium, entry_path AS path
            FROM (SELECT source, medium, entry_path, COUNT(*) AS n
                    FROM web_visits WHERE ${visits} AND page_views > 0
                   GROUP BY 1, 2, 3) x
           ORDER BY source, medium, n DESC, entry_path`;
        const pageRows = await tx.$queryRaw<
          { path: string; views: number; visitors: number; clicks: number }[]
        >`SELECT path, SUM(views)::int AS views, SUM(visitors)::int AS visitors,
                 SUM(clicks)::int AS clicks
            FROM web_page_daily WHERE ${visits}
           GROUP BY path
           ORDER BY views DESC, path
           LIMIT 15`;
        // El dispositivo con el que entró cada visitante (su primera visita).
        const deviceRows = await tx.$queryRaw<{ device: string; n: number }[]>`
          SELECT d.device, COUNT(*)::int AS n
            FROM (SELECT DISTINCT ON (visitor_id) visitor_id, device
                    FROM web_visits
                   WHERE ${visits} AND page_views > 0 AND device IS NOT NULL
                   ORDER BY visitor_id, day, created_at) d
           GROUP BY d.device`;
        const [prevRow] = await tx.$queryRaw<{ n: number }[]>`
          SELECT COUNT(DISTINCT visitor_id) FILTER (WHERE page_views > 0)::int AS n
            FROM web_visits
           WHERE tenant_id = ${tenantId}::uuid
             AND day >= ${prevFrom}::date AND day <= ${prevTo}::date`;
        // De los eventos solo lo poco que no está sumado: la página de la reserva,
        // las horas de los clics de contacto y las reservas empezadas por local.
        const [bookingPageRow] = await tx.$queryRaw<{ n: number }[]>`
          SELECT COUNT(DISTINCT visitor_id)::int AS n
            FROM web_events
           WHERE ${rawRange} AND kind = 'page_view'
             AND (path = '/reservar' OR path LIKE '/reservar/%')`;
        const hourRows = await tx.$queryRaw<
          { weekday: number; hour: number; calls: number; whatsapp: number }[]
        >`SELECT EXTRACT(DOW FROM created_at AT TIME ZONE ${tz})::int AS weekday,
                 EXTRACT(HOUR FROM created_at AT TIME ZONE ${tz})::int AS hour,
                 COUNT(*) FILTER (WHERE kind = 'call_click')::int AS calls,
                 COUNT(*) FILTER (WHERE kind = 'whatsapp_click')::int AS whatsapp
            FROM web_events
           WHERE ${rawRange} AND kind IN ('call_click', 'whatsapp_click')
           GROUP BY 1, 2`;
        const startRows = await tx.$queryRaw<
          { facility_id: string; unit_type_id: string | null; n: number }[]
        >`SELECT facility_id, unit_type_id, COUNT(*)::int AS n
            FROM web_events
           WHERE ${rawRange} AND kind = 'booking_start' AND facility_id IS NOT NULL
           GROUP BY 1, 2`;
        const facilities = await tx.facility.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true, publicSlug: true },
        });
        const slugPaths = facilities.flatMap((f) =>
          f.publicSlug ? [`/${f.publicSlug}`, `/reservar/${f.publicSlug}`] : [],
        );
        const facilityPageRows = slugPaths.length
          ? await tx.$queryRaw<{ path: string; views: number }[]>`
              SELECT path, SUM(views)::int AS views
                FROM web_page_daily
               WHERE ${visits} AND path = ANY(${slugPaths}::text[])
               GROUP BY 1`
          : [];
        const unitTypes = startRows.some((r) => r.unit_type_id)
          ? await tx.unitType.findMany({
              where: {
                id: { in: startRows.flatMap((r) => (r.unit_type_id ? [r.unit_type_id] : [])) },
              },
              select: { id: true, name: true },
            })
          : [];

        // Anotaciones: las escritas a mano y lo que pasó (canales, promociones,
        // campañas y publicaciones).
        const fromDate = new Date(`${fromDay}T00:00:00.000Z`);
        const toDate = new Date(`${toDay}T00:00:00.000Z`);
        const [notes, newChannels, promos, campaigns, posts] = await Promise.all([
          tx.marketingAnnotation.findMany({
            where: { day: { gte: fromDate, lte: toDate } },
            orderBy: { day: 'asc' },
            select: { id: true, day: true, text: true },
          }),
          tx.marketingChannel.findMany({
            where: { createdAt: { gte: since, lt: until }, deletedAt: null },
            select: { name: true, createdAt: true },
          }),
          tx.promotion.findMany({
            where: { validFrom: { gte: since, lt: until } },
            select: { name: true, validFrom: true },
          }),
          tx.campaign.findMany({
            where: { sentAt: { gte: since, lt: until } },
            select: { name: true, sentAt: true },
          }),
          tx.socialPost.findMany({
            where: { publishedAt: { gte: since, lt: until } },
            select: { network: true, publishedAt: true },
          }),
        ]);

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
        const expenses = await tx.expense.findMany({
          where: {
            marketingChannelId: { not: null },
            expenseDate: { gte: fromDate, lte: toDate },
          },
          select: { marketingChannelId: true, amount: true },
        });
        return {
          tenant,
          tz,
          fromDay,
          toDay,
          bySourceRows,
          visitors: visitorRow?.visitors ?? 0,
          returning: visitorRow?.returning ?? 0,
          started: visitorRow?.started ?? 0,
          dailyRows,
          entryRows,
          pageRows,
          deviceRows,
          prevVisitors: prevRow?.n ?? 0,
          bookingPage: bookingPageRow?.n ?? 0,
          hourRows,
          startRows,
          facilities,
          facilityPageRows,
          unitTypes,
          annotations: { notes, newChannels, promos, campaigns, posts },
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
          entryPath: null,
        };
        bySource.set(key, r);
      }
      return r;
    };

    const totals = { ...emptyFunnel(), cost: 0, pendingSignature: 0, signedUnpaid: 0 };
    for (const c of data.bySourceRows) {
      const src = sourceRow({ source: c.source || null, medium: c.medium || null });
      src.pageViews += c.page_views;
      totals.pageViews += c.page_views;
      for (const [field, n] of [
        ['calls', c.calls],
        ['whatsapp', c.whatsapp],
        ['emails', c.emails],
        ['directions', c.directions],
      ] as const) {
        src[field] += n;
        totals[field] += n;
      }
      // Visitantes por origen (un mismo visitante con dos orígenes cuenta en los dos).
      src.visitors += c.visitors;
    }
    for (const e of data.entryRows) {
      const src = sourceRow({ source: e.source || null, medium: e.medium || null });
      src.entryPath ??= e.path;
    }
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

    // Interés por local y tamaño (solo los locales que ve quien consulta).
    const viewsByPath = new Map(data.facilityPageRows.map((r) => [r.path, r.views]));
    const typeName = new Map(data.unitTypes.map((t) => [t.id, t.name]));
    const demand: WebDemandDto[] = data.facilities
      .filter((f) => inViewerScope(viewer, f.id))
      .map((f) => {
        const starts = data.startRows.filter((r) => r.facility_id === f.id);
        const sizes = new Map<string, number>();
        for (const r of starts) {
          if (r.unit_type_id) sizes.set(r.unit_type_id, (sizes.get(r.unit_type_id) ?? 0) + r.n);
        }
        return {
          facilityId: f.id,
          facilityName: f.name,
          pageViews: f.publicSlug
            ? (viewsByPath.get(`/${f.publicSlug}`) ?? 0) +
              (viewsByPath.get(`/reservar/${f.publicSlug}`) ?? 0)
            : 0,
          bookingStarts: starts.reduce((n, r) => n + r.n, 0),
          sizes: [...sizes.entries()]
            .map(([unitTypeId, n]) => ({
              unitTypeId,
              name: typeName.get(unitTypeId) ?? 'Tamaño',
              bookingStarts: n,
            }))
            .sort((a, b) => b.bookingStarts - a.bookingStarts),
        };
      })
      .filter((d) => d.pageViews + d.bookingStarts > 0)
      .sort((a, b) => b.bookingStarts - a.bookingStarts || b.pageViews - a.pageViews);

    // Anotaciones en la gráfica: las escritas y lo que pasó esos días.
    const a = data.annotations;
    const dayOf = (d: Date) => localDayOf(d, data.tz);
    const postsBy = new Map<string, number>();
    for (const p of a.posts) {
      const key = `${dayOf(p.publishedAt)}|${p.network}`;
      postsBy.set(key, (postsBy.get(key) ?? 0) + 1);
    }
    const annotations: MarketingAnnotationDto[] = [
      ...a.notes.map((n) => ({
        id: n.id,
        day: n.day.toISOString().slice(0, 10),
        text: n.text,
        kind: 'manual' as const,
      })),
      ...a.newChannels.map((c) => ({
        id: null,
        day: dayOf(c.createdAt),
        text: `Canal nuevo: «${c.name}»`,
        kind: 'channel' as const,
      })),
      ...a.promos.map((p) => ({
        id: null,
        day: dayOf(p.validFrom!),
        text: `Empieza la promoción «${p.name}»`,
        kind: 'promotion' as const,
      })),
      ...a.campaigns.map((c) => ({
        id: null,
        day: dayOf(c.sentAt!),
        text: `Campaña enviada: «${c.name}»`,
        kind: 'campaign' as const,
      })),
      ...[...postsBy.entries()].map(([key, n]) => {
        const [day, network] = key.split('|') as [string, string];
        const where = network === 'instagram' ? 'Instagram' : 'Facebook';
        return {
          id: null,
          day,
          text: n === 1 ? `Publicación en ${where}` : `${n} publicaciones en ${where}`,
          kind: 'post' as const,
        };
      }),
    ]
      .sort((x, y) => x.day.localeCompare(y.day))
      .slice(0, 60);

    return {
      days,
      from: data.fromDay,
      to: data.toDay,
      newVisitors: Math.max(0, data.visitors - data.returning),
      returningVisitors: data.returning,
      bookingFunnel: {
        visitors: totals.visitors,
        bookingPage: data.bookingPage,
        started: data.started,
        bookings: totals.bookings,
        signed: totals.signed,
        paid: totals.paid,
      },
      contactHours: data.hourRows,
      demand,
      annotations,
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
