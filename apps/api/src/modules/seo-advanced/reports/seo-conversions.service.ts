import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import {
  SEO_CONVERSIONS_DAILY_DAYS,
  SEO_CONVERSIONS_RECALC_DAYS,
  SEO_CONVERSION_PAGES_MAX,
  SEO_CONVERSION_MIN_CLICKS,
  SEO_PLATFORM_CONVERSION_TYPES,
  SEO_PRIMARY_CONVERSION_TYPES,
  SEO_TENANT_CONVERSION_TYPES,
  estimateSeoConversionsByQuery,
  normalizeSeoKeyword,
  seoConversionRate,
  seoLandingKey,
  seoPageLandingKey,
  seoConversionRanges,
  seoPeriodCovered,
  shiftDate,
  type SeoConversionPageDto,
  type SeoConversionType,
  type SeoConversionsDto,
  type SeoPageConversionStat,
  type SeoPanelPeriod,
} from '@storageos/shared';

import { todayInTimezone } from '../../../common/format';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';

import { seoProjectEligible } from './seo-eligible';

import type { Env } from '../../../config/env.schema';

const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const today = () => todayInTimezone().toISOString().slice(0, 10);

/** Origen Google orgánico en SQL (lo mismo que `isOrganicGoogleSource`). */
const organic = (source: Prisma.Sql, medium: Prisma.Sql) => Prisma.sql`
  lower(btrim(COALESCE(${source}, ''))) = 'google'
  AND lower(btrim(COALESCE(${medium}, ''))) IN ('', 'organic')`;
/** Día en hora de España de una columna con hora. */
const madridDay = (col: Prisma.Sql) => Prisma.sql`((${col}) AT TIME ZONE 'Europe/Madrid')::date`;

interface ConvRow {
  d: Date;
  landing: string | null;
  n: number;
  revenue: number | null;
}

type ProjectScope = 'tenant' | 'platform' | null;

/**
 * Conversiones del tráfico orgánico de Google (§18.9): reservas online (y su
 * firma y su primer pago), contactos de la web y lista de espera en el negocio;
 * solicitudes del formulario, altas de prueba y altas que pagan en la
 * plataforma. Se guardan por día, tipo y página de entrada en
 * `seo_conversions_daily` (recalcular un rango borra y vuelve a contar ese
 * rango: es idempotente y lo de fuera se conserva).
 */
@Injectable()
export class SeoConversionsService {
  private readonly logger = new Logger(SeoConversionsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Dominio de la web de la plataforma (sin `www.`). */
  private platformHost(): string | null {
    try {
      const h = new URL(this.config.get('WEB_BASE_URL', { infer: true })).hostname;
      return h.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  /**
   * Qué cuenta el proyecto: el de un tenant, lo de su negocio; uno de la
   * plataforma, lo de trasteros.pro solo si se marcó o si su dominio es el de
   * la plataforma (otro proyecto de la plataforma no cuenta nada).
   */
  scopeOf(project: {
    tenantId: string | null;
    platformConversions: boolean | null;
    domains: { domain: string }[];
  }): ProjectScope {
    if (project.tenantId) return 'tenant';
    if (project.platformConversions !== null)
      return project.platformConversions ? 'platform' : null;
    const host = this.platformHost();
    if (!host || !host.includes('.')) return null;
    return project.domains.some((d) => d.domain.toLowerCase().replace(/^www\./, '') === host)
      ? 'platform'
      : null;
  }

  // -------------------------------------------------------------- cálculo

  /**
   * Recalcula las conversiones de un proyecto entre dos días (hora de
   * España). Por defecto, los últimos `SEO_CONVERSIONS_DAILY_DAYS`.
   */
  async recompute(
    projectId: string,
    opts: { from?: string; to?: string } = {},
  ): Promise<{ rows: number; from: string; to: string }> {
    const project = await this.admin.seoProject.findUnique({
      where: { id: projectId },
      include: { domains: { select: { id: true, domain: true, role: true } } },
    });
    if (!project) return { rows: 0, from: '', to: '' };
    const to = opts.to ?? today();
    const from = opts.from ?? shiftDate(to, -(SEO_CONVERSIONS_DAILY_DAYS - 1));
    const scope = this.scopeOf(project);
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0] ?? null;
    const rows =
      scope === 'tenant'
        ? await this.tenantRows(project.tenantId!, from, to)
        : scope === 'platform'
          ? await this.platformRows(from, to)
          : [];
    // Un mismo día, tipo y página: se suman (dos caminos pueden dar la misma página).
    const merged = new Map<
      string,
      { date: string; type: SeoConversionType; landing: string; n: number; revenue: number | null }
    >();
    for (const r of rows) {
      const key = `${r.date}|${r.type}|${r.landing}`;
      const cur = merged.get(key);
      if (cur) {
        cur.n += r.n;
        cur.revenue =
          cur.revenue === null && r.revenue === null ? null : (cur.revenue ?? 0) + (r.revenue ?? 0);
      } else merged.set(key, { ...r });
    }
    await this.admin.$transaction(async (tx) => {
      await tx.seoConversionDaily.deleteMany({
        where: {
          projectId,
          date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
      });
      if (merged.size > 0) {
        await tx.seoConversionDaily.createMany({
          data: [...merged.values()].map((r) => ({
            tenantId: project.tenantId,
            projectId,
            domainId: primary?.id ?? null,
            date: new Date(`${r.date}T00:00:00Z`),
            type: r.type,
            landingPath: r.landing,
            count: r.n,
            revenue: r.revenue === null ? null : new Prisma.Decimal(r.revenue.toFixed(2)),
          })),
        });
      }
      await tx.seoProject.update({
        where: { id: projectId },
        data: { conversionsCalculatedAt: new Date() },
      });
    });
    return { rows: merged.size, from, to };
  }

  /** Proyecto de la plataforma: si cuenta las conversiones de trasteros.pro. */
  async setPlatformConversions(projectId: string, value: boolean | null) {
    await this.projects.resolveProject(null, projectId);
    await this.admin.seoProject.update({
      where: { id: projectId },
      data: { platformConversions: value },
    });
    return this.recalc(null, projectId);
  }

  /** «Recalcular»: los últimos `SEO_CONVERSIONS_RECALC_DAYS` días del proyecto. */
  async recalc(owner: SeoOwner, projectId: string) {
    await this.projects.resolveProject(owner, projectId);
    const to = today();
    return this.recompute(projectId, {
      from: shiftDate(to, -(SEO_CONVERSIONS_RECALC_DAYS - 1)),
      to,
    });
  }

  /** Cron diario: todos los proyectos activos (de tenants con el extra y de la plataforma). */
  async recomputeAll(): Promise<{ projects: number; rows: number }> {
    const projects = await this.admin.seoProject.findMany({
      where: { status: 'active' },
      select: { id: true, tenantId: true },
    });
    let rows = 0;
    for (const p of projects) {
      if (!(await seoProjectEligible(this.admin, p.tenantId))) continue;
      try {
        rows += (await this.recompute(p.id)).rows;
      } catch (err) {
        this.logger.warn(`[seo-conversions] ${p.id}: ${(err as Error).message}`);
      }
    }
    return { projects: projects.length, rows };
  }

  private toRows(type: SeoConversionType, rows: ConvRow[]) {
    return rows.map((r) => ({
      date: dateOnly(r.d)!,
      type,
      landing: seoLandingKey(r.landing),
      n: Number(r.n),
      revenue: r.revenue === null || r.revenue === undefined ? null : Number(r.revenue),
    }));
  }

  /** Lo del negocio: contactos, lista de espera y reservas online (con su firma y su pago). */
  private async tenantRows(tenantId: string, from: string, to: string) {
    const inRange = (col: Prisma.Sql) =>
      Prisma.sql`${madridDay(col)} BETWEEN ${from}::date AND ${to}::date`;
    // Origen de la reserva: el de esa visita (`bookingUtm`) o, si no hay, el del contacto.
    const bSource = Prisma.sql`COALESCE(l.metadata->'bookingUtm'->>'source', l.utm_source)`;
    const bMedium = Prisma.sql`CASE WHEN l.metadata->'bookingUtm'->>'source' IS NOT NULL
      THEN l.metadata->'bookingUtm'->>'medium' ELSE l.utm_medium END`;
    const bLanding = Prisma.sql`COALESCE(l.metadata->'bookingUtm'->>'landing', l.landing_path)`;
    const booked = Prisma.sql`
      l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
      AND l.metadata->>'selfBooked' = 'true'
      AND ${organic(bSource, bMedium)}`;

    const [contacts, waitlist, started, signed, paid] = await Promise.all([
      this.admin.$queryRaw<ConvRow[]>(Prisma.sql`
        SELECT ${madridDay(Prisma.sql`l.created_at`)} AS d, l.landing_path AS landing,
               COUNT(*)::int AS n, NULL::float8 AS revenue
        FROM leads l
        WHERE l.tenant_id = ${tenantId}::uuid AND l.deleted_at IS NULL
          AND COALESCE(l.metadata->>'origin', '') <> 'booking'
          AND l.source NOT IN ('manual', 'import')
          AND ${organic(Prisma.sql`l.utm_source`, Prisma.sql`l.utm_medium`)}
          AND ${inRange(Prisma.sql`l.created_at`)}
        GROUP BY 1, 2`),
      this.admin.$queryRaw<ConvRow[]>(Prisma.sql`
        SELECT ${madridDay(Prisma.sql`w.created_at`)} AS d, w.landing_path AS landing,
               COUNT(*)::int AS n, NULL::float8 AS revenue
        FROM waitlist_entries w
        WHERE w.tenant_id = ${tenantId}::uuid
          AND ${organic(Prisma.sql`w.utm_source`, Prisma.sql`w.utm_medium`)}
          AND ${inRange(Prisma.sql`w.created_at`)}
        GROUP BY 1, 2`),
      this.admin.$queryRaw<ConvRow[]>(Prisma.sql`
        SELECT ${madridDay(Prisma.sql`l.booked_at`)} AS d, ${bLanding} AS landing,
               COUNT(*)::int AS n, NULL::float8 AS revenue
        FROM leads l
        WHERE ${booked} AND l.booked_at IS NOT NULL AND ${inRange(Prisma.sql`l.booked_at`)}
        GROUP BY 1, 2`),
      this.admin.$queryRaw<ConvRow[]>(Prisma.sql`
        SELECT ${madridDay(Prisma.sql`c.signed_at`)} AS d, ${bLanding} AS landing,
               COUNT(*)::int AS n, NULL::float8 AS revenue
        FROM leads l JOIN contracts c ON c.id = l.converted_contract_id
        WHERE ${booked} AND c.signed_at IS NOT NULL AND ${inRange(Prisma.sql`c.signed_at`)}
        GROUP BY 1, 2`),
      // El primer pago: la primera factura del contrato, ya pagada (sin el justificante de la fianza).
      this.admin.$queryRaw<ConvRow[]>(Prisma.sql`
        SELECT ${madridDay(Prisma.sql`fi.paid_at`)} AS d, ${bLanding} AS landing,
               COUNT(*)::int AS n, SUM(fi.amount_paid)::float8 AS revenue
        FROM leads l
        JOIN LATERAL (
          SELECT i.status, i.paid_at, i.amount_paid FROM invoices i
          WHERE i.contract_id = l.converted_contract_id AND i.kind = 'invoice'
            AND i.deleted_at IS NULL
          ORDER BY i.created_at ASC, i.id ASC LIMIT 1
        ) fi ON true
        WHERE ${booked} AND fi.status = 'paid' AND fi.paid_at IS NOT NULL
          AND ${inRange(Prisma.sql`fi.paid_at`)}
        GROUP BY 1, 2`),
    ]);
    return [
      ...this.toRows('contact', contacts),
      ...this.toRows('waitlist', waitlist),
      ...this.toRows('booking_started', started),
      ...this.toRows('booking_signed', signed),
      ...this.toRows('booking_paid', paid),
    ];
  }

  /** Lo de trasteros.pro: el formulario, las altas de prueba y las que pasan a pagar. */
  private async platformRows(from: string, to: string) {
    const inRange = (col: Prisma.Sql) =>
      Prisma.sql`${madridDay(col)} BETWEEN ${from}::date AND ${to}::date`;
    const signupOrganic = organic(Prisma.sql`t.signup_utm_source`, Prisma.sql`t.signup_utm_medium`);
    const [demos, signups, paid] = await Promise.all([
      this.admin.$queryRaw<ConvRow[]>(Prisma.sql`
        SELECT ${madridDay(Prisma.sql`m.created_at`)} AS d, m.landing_path AS landing,
               COUNT(*)::int AS n, NULL::float8 AS revenue
        FROM platform_contact_messages m
        WHERE ${organic(Prisma.sql`m.utm_source`, Prisma.sql`m.utm_medium`)}
          AND ${inRange(Prisma.sql`m.created_at`)}
        GROUP BY 1, 2`),
      this.admin.$queryRaw<ConvRow[]>(Prisma.sql`
        SELECT ${madridDay(Prisma.sql`t.created_at`)} AS d, t.signup_landing_path AS landing,
               COUNT(*)::int AS n, NULL::float8 AS revenue
        FROM tenants t
        WHERE ${signupOrganic} AND ${inRange(Prisma.sql`t.created_at`)}
        GROUP BY 1, 2`),
      this.admin.$queryRaw<ConvRow[]>(Prisma.sql`
        SELECT ${madridDay(Prisma.sql`fp.paid_at`)} AS d, t.signup_landing_path AS landing,
               COUNT(*)::int AS n, SUM(fp.amount)::float8 AS revenue
        FROM tenants t
        JOIN LATERAL (
          SELECT p.paid_at, p.amount FROM tenant_subscription_payments p
          WHERE p.tenant_id = t.id AND p.status = 'paid' AND p.paid_at IS NOT NULL
          ORDER BY p.paid_at ASC LIMIT 1
        ) fp ON true
        WHERE ${signupOrganic} AND ${inRange(Prisma.sql`fp.paid_at`)}
        GROUP BY 1, 2`),
    ]);
    return [
      ...this.toRows('demo_request', demos),
      ...this.toRows('signup', signups),
      ...this.toRows('paid_signup', paid),
    ];
  }

  // -------------------------------------------------------------- lectura

  private async siteClicks(domainIds: string[], from: string, to: string): Promise<number> {
    if (domainIds.length === 0) return 0;
    const [r] = await this.admin.$queryRaw<{ c: number | null }[]>(Prisma.sql`
      SELECT SUM(clicks)::float8 AS c FROM seo_gsc_metrics
      WHERE domain_id = ANY(${domainIds}::uuid[]) AND grain = 'site'
        AND date BETWEEN ${from}::date AND ${to}::date`);
    return Number(r?.c ?? 0);
  }

  private async counts(projectId: string, from: string, to: string) {
    return this.admin.$queryRaw<
      { type: string; landing: string; n: number; revenue: number | null }[]
    >(Prisma.sql`
      SELECT type, landing_path AS landing, SUM(count)::int AS n, SUM(revenue)::float8 AS revenue
      FROM seo_conversions_daily
      WHERE project_id = ${projectId}::uuid AND date BETWEEN ${from}::date AND ${to}::date
      GROUP BY type, landing_path`);
  }

  /** La tarjeta «Lo que trae Google» del periodo del panel. */
  async summary(
    owner: SeoOwner | undefined,
    projectId: string,
    q: { period: SeoPanelPeriod; from?: string | undefined; to?: string | undefined },
  ): Promise<SeoConversionsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const scope = this.scopeOf(project);
    const domainIds = project.domains.map((d) => d.id);
    const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0] ?? null;
    const bounds = primary
      ? await this.admin.seoGscMetric.aggregate({
          where: { domainId: primary.id, grain: 'site' },
          _min: { date: true },
          _max: { date: true },
        })
      : null;
    const first = dateOnly(bounds?._min.date);
    const last = dateOnly(bounds?._max.date);
    // Recuentos hasta hoy; la tasa, solo con los días que Google ya ha dado.
    const ranges = seoConversionRanges({
      period: q.period,
      from: q.from ?? null,
      to: q.to ?? null,
      today: today(),
      lastDataDate: last,
    });
    if (!ranges) {
      throw new BadRequestException({
        code: 'seo_invalid_range',
        message: 'Elige las dos fechas del periodo.',
      });
    }
    const rr = ranges.rate;
    const days = async (from: string, to: string) =>
      primary
        ? this.admin.seoGscMetric.count({
            where: {
              domainId: primary.id,
              grain: 'site',
              date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
            },
          })
        : 0;
    const none = Promise.resolve<
      { type: string; landing: string; n: number; revenue: number | null }[]
    >([]);
    const [cur, prev, rateCur, ratePrev, clicks, prevClicks, curDays, prevDays] = await Promise.all(
      [
        this.counts(projectId, ranges.from, ranges.to),
        this.counts(projectId, ranges.previousFrom, ranges.previousTo),
        rr ? this.counts(projectId, rr.from, rr.to) : none,
        rr ? this.counts(projectId, rr.previousFrom, rr.previousTo) : none,
        rr ? this.siteClicks(domainIds, rr.from, rr.to) : Promise.resolve(0),
        rr ? this.siteClicks(domainIds, rr.previousFrom, rr.previousTo) : Promise.resolve(0),
        rr ? days(rr.from, rr.to) : Promise.resolve(0),
        rr ? days(rr.previousFrom, rr.previousTo) : Promise.resolve(0),
      ],
    );
    const complete =
      !!rr &&
      seoPeriodCovered({ firstDate: first, from: rr.from, to: rr.to, daysWithData: curDays });
    const comparable =
      complete &&
      !!rr &&
      seoPeriodCovered({
        firstDate: first,
        from: rr.previousFrom,
        to: rr.previousTo,
        daysWithData: prevDays,
      });

    const typeList =
      scope === 'platform'
        ? SEO_PLATFORM_CONVERSION_TYPES
        : scope === 'tenant'
          ? SEO_TENANT_CONVERSION_TYPES
          : [];
    const sumBy = (rows: typeof cur, type: string) =>
      rows.filter((r) => r.type === type).reduce((s, r) => s + Number(r.n), 0);
    const revenueBy = (rows: typeof cur, type: string) => {
      const list = rows.filter((r) => r.type === type && r.revenue !== null);
      return list.length
        ? Math.round(list.reduce((s, r) => s + Number(r.revenue), 0) * 100) / 100
        : null;
    };
    const isPrimary = (t: string) => SEO_PRIMARY_CONVERSION_TYPES.includes(t as SeoConversionType);
    const primarySum = (rows: typeof cur) =>
      rows.filter((r) => isPrimary(r.type)).reduce((s, r) => s + Number(r.n), 0);
    // Los recuentos se comparan siempre: los mismos días justo antes (no dependen de Google).
    const types = typeList.map((type) => ({
      type,
      count: sumBy(cur, type),
      previous: sumBy(prev, type),
      revenue: type === 'booking_paid' || type === 'paid_signup' ? revenueBy(cur, type) : null,
    }));
    const primaryCount = types.filter((t) => isPrimary(t.type)).reduce((s, t) => s + t.count, 0);
    const primaryPrev = types
      .filter((t) => isPrimary(t.type))
      .reduce((s, t) => s + (t.previous ?? 0), 0);
    const rateCount = primarySum(rateCur);
    const ratePrevCount = primarySum(ratePrev);
    const revenues = types.map((t) => t.revenue).filter((r): r is number => r !== null);

    // Por página de entrada: conversiones hasta hoy; clics y tasa, con los días de Google.
    const pageMap = new Map<string, SeoConversionPageDto>();
    for (const r of cur) {
      if (!typeList.includes(r.type as SeoConversionType)) continue;
      const p = pageMap.get(r.landing) ?? {
        landing: r.landing,
        clicks: 0,
        conversions: 0,
        rate: null,
        byType: {},
      };
      const type = r.type as SeoConversionType;
      p.byType[type] = (p.byType[type] ?? 0) + Number(r.n);
      if (isPrimary(type)) p.conversions += Number(r.n);
      pageMap.set(r.landing, p);
    }
    const rateByPage = new Map<string, number>();
    for (const r of rateCur) {
      if (!isPrimary(r.type)) continue;
      rateByPage.set(r.landing, (rateByPage.get(r.landing) ?? 0) + Number(r.n));
    }
    const pageClicks = rr ? await this.pageClicks(domainIds, rr.from, rr.to) : new Map();
    for (const [key, c] of pageClicks) {
      const p = pageMap.get(key);
      if (p) p.clicks = c;
    }
    const pages = [...pageMap.values()]
      .map((p) => ({
        ...p,
        rate:
          complete && p.landing
            ? seoConversionRate(rateByPage.get(p.landing) ?? 0, p.clicks)
            : null,
      }))
      .sort(
        (a, b) =>
          b.conversions - a.conversions ||
          b.clicks - a.clicks ||
          a.landing.localeCompare(b.landing),
      )
      .slice(0, SEO_CONVERSION_PAGES_MAX);

    // Por búsqueda (estimación): las conversiones hasta hoy, repartidas según los clics de Google.
    const queries = rr
      ? estimateSeoConversionsByQuery(
          pages.map((p) => ({ landingKey: p.landing, conversions: p.conversions })),
          await this.queryPageClicks(
            domainIds,
            rr.from,
            rr.to,
            pages.filter((p) => p.landing && p.conversions > 0).map((p) => p.landing),
          ),
        )
      : [];

    return {
      scope,
      platformConversions: project.tenantId ? null : project.platformConversions,
      from: ranges.from,
      to: ranges.to,
      previousFrom: ranges.previousFrom,
      previousTo: ranges.previousTo,
      rateFrom: rr?.from ?? null,
      rateTo: rr?.to ?? null,
      lastDataDate: last,
      complete,
      comparable,
      types,
      primary: {
        count: primaryCount,
        previous: primaryPrev,
        rateCount,
        clicks,
        previousClicks: comparable ? prevClicks : null,
        rate: complete ? seoConversionRate(rateCount, clicks) : null,
        previousRate: comparable ? seoConversionRate(ratePrevCount, prevClicks) : null,
      },
      revenue: revenues.length ? Math.round(revenues.reduce((s, r) => s + r, 0) * 100) / 100 : null,
      pages,
      queries,
      calculatedAt: project.conversionsCalculatedAt?.toISOString() ?? null,
    };
  }

  /** Clics de Google por página de entrada (todas las del proyecto, por ruta). */
  private async pageClicks(domainIds: string[], from: string, to: string) {
    const out = new Map<string, number>();
    if (domainIds.length === 0) return out;
    const rows = await this.admin.$queryRaw<{ page: string; c: number }[]>(Prisma.sql`
      SELECT page, SUM(clicks)::float8 AS c FROM seo_gsc_metrics
      WHERE domain_id = ANY(${domainIds}::uuid[]) AND grain = 'page'
        AND date BETWEEN ${from}::date AND ${to}::date
      GROUP BY page`);
    for (const r of rows) {
      const key = seoPageLandingKey(r.page);
      out.set(key, (out.get(key) ?? 0) + Number(r.c));
    }
    return out;
  }

  /** Clics por búsqueda y página (cruce `query_page`) de las páginas que convierten. */
  private async queryPageClicks(domainIds: string[], from: string, to: string, keys: string[]) {
    if (domainIds.length === 0 || keys.length === 0) return [];
    const rows = await this.admin.$queryRaw<
      { query: string; page: string; c: number }[]
    >(Prisma.sql`
      SELECT query, page, SUM(clicks)::float8 AS c FROM seo_gsc_metrics
      WHERE domain_id = ANY(${domainIds}::uuid[]) AND grain = 'query_page'
        AND date BETWEEN ${from}::date AND ${to}::date AND clicks > 0
      GROUP BY query, page
      ORDER BY c DESC
      LIMIT 5000`);
    const wanted = new Set(keys);
    return rows
      .map((r) => ({ query: r.query, pageKey: seoPageLandingKey(r.page), clicks: Number(r.c) }))
      .filter((r) => wanted.has(r.pageKey));
  }

  /** Si el proyecto tiene alguna conversión principal en el periodo (barato: antes de pedir páginas). */
  async hasConversions(projectId: string, period: { from: string; to: string }): Promise<boolean> {
    const row = await this.admin.seoConversionDaily.findFirst({
      where: {
        projectId,
        landingPath: { not: '' },
        type: { in: SEO_PRIMARY_CONVERSION_TYPES },
        date: {
          gte: new Date(`${period.from}T00:00:00Z`),
          lte: new Date(`${period.to}T00:00:00Z`),
        },
      },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * Para las oportunidades (factor «La página convierte»): conversiones y
   * clics de la página ganadora de cada búsqueda, en el periodo dado. Solo las
   * páginas con clics suficientes y alguna conversión.
   */
  async pageStatsByQuery(
    projectId: string,
    domainId: string,
    period: { from: string; to: string },
    queryPages: Map<string, string>,
  ): Promise<Record<string, SeoPageConversionStat>> {
    const conv = await this.admin.$queryRaw<{ landing: string; n: number }[]>(Prisma.sql`
      SELECT landing_path AS landing, SUM(count)::int AS n FROM seo_conversions_daily
      WHERE project_id = ${projectId}::uuid AND landing_path <> ''
        AND type = ANY(${SEO_PRIMARY_CONVERSION_TYPES}::text[])
        AND date BETWEEN ${period.from}::date AND ${period.to}::date
      GROUP BY landing_path`);
    if (conv.length === 0) return {};
    const byLanding = new Map(conv.map((c) => [c.landing, Number(c.n)]));
    const clicks = await this.pageClicks([domainId], period.from, period.to);
    const out: Record<string, SeoPageConversionStat> = {};
    for (const [query, page] of queryPages) {
      const key = seoPageLandingKey(page);
      const n = byLanding.get(key);
      const c = clicks.get(key) ?? 0;
      if (n && n > 0 && c >= SEO_CONVERSION_MIN_CLICKS) {
        out[normalizeSeoKeyword(query)] = { conversions: n, clicks: c };
      }
    }
    return out;
  }
}
