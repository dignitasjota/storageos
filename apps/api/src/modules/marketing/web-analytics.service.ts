import { Injectable } from '@nestjs/common';
import {
  WEB_ANALYTICS_DAYS,
  deviceFromUserAgent,
  isBotUserAgent,
  normalizeWebPath,
  type WebAnalyticsDto,
  type WebAnalyticsFunnelDto,
  type WebAnalyticsPageDto,
  type WebAnalyticsSourceDto,
  type WebEventInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

/** Una página vista cuenta una vez por visitante y página cada 30 minutos. */
const PAGE_VIEW_WINDOW_MS = 30 * 60_000;
/** Un clic de contacto repetido en 10 s (doble toque) cuenta una vez. */
const CLICK_WINDOW_MS = 10_000;
const DAY_MS = 86_400_000;

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

/**
 * Analítica propia de la web del tenant: visitas y clics de contacto con su
 * origen, y el embudo hasta el contrato pagado. Sin IP ni datos personales.
 */
@Injectable()
export class WebAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  /** Anota una página vista o un clic de contacto (best-effort, nunca lanza). */
  async record(slug: string, input: WebEventInput, userAgent: string | undefined): Promise<void> {
    if (isBotUserAgent(userAgent)) return;
    const tenant = await this.admin.tenant.findUnique({
      where: { slug },
      select: { id: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) return;
    const path = normalizeWebPath(input.path, slug);
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

  /** Informe de los últimos `days` días (7, 30 o 90) frente al periodo anterior. */
  async report(tenantId: string, daysInput: number): Promise<WebAnalyticsDto> {
    const days = (WEB_ANALYTICS_DAYS as readonly number[]).includes(daysInput) ? daysInput : 30;
    const now = Date.now();
    return this.reportRange(
      tenantId,
      { since: new Date(now - days * DAY_MS), until: new Date(now) },
      days,
    );
  }

  /**
   * Informe de `[since, until)` frente al periodo anterior de la misma
   * duración (lo usa también el resumen mensual de marketing).
   */
  async reportRange(
    tenantId: string,
    range: { since: Date; until: Date; fromDay?: string; toDay?: string },
    days: number,
  ): Promise<WebAnalyticsDto> {
    const { since, until } = range;
    // Días (columnas DATE) del periodo: por defecto, los de UTC.
    const fromDay = range.fromDay ?? since.toISOString().slice(0, 10);
    const toDay = range.toDay ?? new Date(until.getTime() - 1).toISOString().slice(0, 10);
    const now = until.getTime() - 1;
    const prevSince = new Date(since.getTime() - (until.getTime() - since.getTime()));

    const { tenant, events, prevVisitors, leads, channels, expenses } =
      await this.prisma.withTenant(
        async (tx) => ({
          tenant: await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { timezone: true },
          }),
          events: await tx.webEvent.findMany({
            where: { createdAt: { gte: since, lt: until } },
            select: {
              visitorId: true,
              kind: true,
              path: true,
              source: true,
              device: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
          }),
          prevVisitors: await tx.webEvent.groupBy({
            by: ['visitorId'],
            where: { kind: 'page_view', createdAt: { gte: prevSince, lt: since } },
          }),
          // Contactos que llegaron por la web: con origen o creados desde la web.
          leads: await tx.lead.findMany({
            where: {
              deletedAt: null,
              OR: [{ utmSource: { not: null } }, { source: { in: ['web', 'widget', 'landing'] } }],
              AND: [
                {
                  OR: [
                    { createdAt: { gte: prevSince, lt: until } },
                    { wonAt: { gte: prevSince, lt: until } },
                  ],
                },
              ],
            },
            select: {
              utmSource: true,
              createdAt: true,
              wonAt: true,
              convertedContractId: true,
            },
          }),
          channels: await tx.marketingChannel.findMany({
            where: { deletedAt: null, utmSourceMatch: { not: null } },
            select: { id: true, utmSourceMatch: true },
          }),
          expenses: await tx.expense.findMany({
            where: {
              marketingChannelId: { not: null },
              expenseDate: { gte: new Date(fromDay), lte: new Date(toDay) },
            },
            select: { marketingChannelId: true, amount: true },
          }),
        }),
        tenantId,
      );

    const tz = tenant?.timezone || 'Europe/Madrid';
    const dayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const keyOf = (d: Date) => dayKey.format(d);

    // Embudo por origen.
    const bySource = new Map<string, WebAnalyticsSourceDto & { ids: Set<string> }>();
    const sourceRow = (source: string | null | undefined) => {
      const key = source || 'web';
      let r = bySource.get(key);
      if (!r) {
        r = { source: key, ...emptyFunnel(), cost: 0, costPerBooking: null, ids: new Set() };
        bySource.set(key, r);
      }
      return r;
    };

    const visitors = new Set<string>();
    const deviceOf = new Map<string, string>();
    const pages = new Map<string, WebAnalyticsPageDto & { ids: Set<string> }>();
    const daily = new Map<string, { ids: Set<string>; pageViews: number; contacts: number }>();
    for (let t = since.getTime(); t <= now; t += DAY_MS) {
      daily.set(keyOf(new Date(t)), { ids: new Set(), pageViews: 0, contacts: 0 });
    }
    const dayRow = (d: Date) => {
      const k = keyOf(d);
      let r = daily.get(k);
      if (!r) {
        r = { ids: new Set(), pageViews: 0, contacts: 0 };
        daily.set(k, r);
      }
      return r;
    };
    const pageRow = (path: string) => {
      let r = pages.get(path);
      if (!r) {
        r = { path, pageViews: 0, visitors: 0, contactClicks: 0, ids: new Set() };
        pages.set(path, r);
      }
      return r;
    };

    const totals = { ...emptyFunnel(), cost: 0 };
    for (const e of events) {
      const src = sourceRow(e.source);
      if (e.kind === 'page_view') {
        visitors.add(e.visitorId);
        if (e.device && !deviceOf.has(e.visitorId)) deviceOf.set(e.visitorId, e.device);
        src.pageViews += 1;
        src.ids.add(e.visitorId);
        totals.pageViews += 1;
        const p = pageRow(e.path);
        p.pageViews += 1;
        p.ids.add(e.visitorId);
        const d = dayRow(e.createdAt);
        d.pageViews += 1;
        d.ids.add(e.visitorId);
      } else if (e.kind in CLICK_FIELD) {
        const field = CLICK_FIELD[e.kind as keyof typeof CLICK_FIELD];
        src[field] += 1;
        totals[field] += 1;
        pageRow(e.path).contactClicks += 1;
      }
    }
    totals.visitors = visitors.size;

    // Contactos y contratos por origen (con el primer pago).
    let prevContacts = 0;
    let prevBookings = 0;
    const converted: { cid: string; source: string | null }[] = [];
    for (const l of leads) {
      const src = lower(l.utmSource);
      if (l.createdAt >= since) {
        sourceRow(src).contacts += 1;
        totals.contacts += 1;
        dayRow(l.createdAt).contacts += 1;
      } else if (l.createdAt >= prevSince) {
        prevContacts += 1;
      }
      if (l.convertedContractId && l.wonAt) {
        if (l.wonAt >= since) converted.push({ cid: l.convertedContractId, source: src });
        else if (l.wonAt >= prevSince) prevBookings += 1;
      }
    }
    const contractIds = [...new Set(converted.map((c) => c.cid))];
    const [contracts, invoices] = contractIds.length
      ? await this.prisma.withTenant(
          (tx) =>
            Promise.all([
              tx.contract.findMany({
                where: { id: { in: contractIds } },
                select: { id: true, signedAt: true },
              }),
              tx.invoice.findMany({
                where: { contractId: { in: contractIds }, kind: 'invoice', deletedAt: null },
                select: {
                  contractId: true,
                  status: true,
                  amountPaid: true,
                  withholdingAmount: true,
                },
                orderBy: { createdAt: 'asc' },
              }),
            ]),
          tenantId,
        )
      : [[], []];
    const signed = new Set(contracts.filter((c) => c.signedAt).map((c) => c.id));
    const firstInvoice = new Map<string, (typeof invoices)[number]>();
    for (const inv of invoices) {
      if (inv.contractId && !firstInvoice.has(inv.contractId)) {
        firstInvoice.set(inv.contractId, inv);
      }
    }
    const seen = new Set<string>();
    for (const { cid, source } of converted) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      const r = sourceRow(source);
      r.bookings += 1;
      totals.bookings += 1;
      if (signed.has(cid)) {
        r.signed += 1;
        totals.signed += 1;
      }
      const inv = firstInvoice.get(cid);
      if (inv?.status === 'paid') {
        r.paid += 1;
        totals.paid += 1;
      }
      if (inv) {
        const cash = Number(inv.amountPaid) - Number(inv.withholdingAmount);
        r.revenue += cash;
        totals.revenue += cash;
      }
    }

    // Gasto de los canales de marketing con ese origen.
    const sourceOfChannel = new Map(channels.map((c) => [c.id, c.utmSourceMatch!.toLowerCase()]));
    for (const e of expenses) {
      const source = sourceOfChannel.get(e.marketingChannelId!);
      if (!source) continue;
      const amount = Number(e.amount);
      sourceRow(source).cost += amount;
      totals.cost += amount;
    }

    const sources: WebAnalyticsSourceDto[] = [...bySource.values()]
      .map(({ ids, ...r }) => ({
        ...r,
        visitors: ids.size,
        revenue: round2(r.revenue),
        cost: round2(r.cost),
        costPerBooking: r.bookings > 0 && r.cost > 0 ? round2(r.cost / r.bookings) : null,
      }))
      .filter((r) => r.pageViews + r.contacts + r.bookings + r.cost + r.calls + r.whatsapp > 0)
      .sort((a, b) => b.visitors - a.visitors || b.contacts - a.contacts);

    const deviceCount = new Map<string, number>();
    for (const d of deviceOf.values()) deviceCount.set(d, (deviceCount.get(d) ?? 0) + 1);

    return {
      days,
      from: keyOf(since),
      to: keyOf(new Date(now)),
      totals: { ...totals, revenue: round2(totals.revenue), cost: round2(totals.cost) },
      previous: { visitors: prevVisitors.length, contacts: prevContacts, bookings: prevBookings },
      daily: [...daily.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, d]) => ({
          date,
          visitors: d.ids.size,
          pageViews: d.pageViews,
          contacts: d.contacts,
        })),
      sources,
      pages: [...pages.values()]
        .map(({ ids, ...p }) => ({ ...p, visitors: ids.size }))
        .sort((a, b) => b.pageViews - a.pageViews)
        .slice(0, 15),
      devices: (['mobile', 'desktop', 'tablet'] as const)
        .map((device) => ({ device, visitors: deviceCount.get(device) ?? 0 }))
        .filter((d) => d.visitors > 0),
    };
  }
}
