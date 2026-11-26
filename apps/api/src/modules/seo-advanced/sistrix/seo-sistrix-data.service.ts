import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type AddSeoProjectKeywordsInput,
  type CreateSeoCompetitorInput,
  type SeoAiVisibilityRowDto,
  type SeoBacklinksDto,
  type SeoCompetitorDto,
  type SeoDataOriginDto,
  type SeoDomainKeywordHistoryDto,
  type SeoDomainKeywordsDto,
  type SeoKeywordIntent,
  type SeoKeywordSource,
  type SeoOpportunitiesDto,
  type SeoProjectKeywordDto,
  type SeoProviderKey,
  type SeoSerpDto,
  type SeoVisibilitySeriesDto,
  type UpdateSeoCompetitorInput,
  type UpdateSeoProjectKeywordInput,
} from '@storageos/shared';

import { isUniqueViolation } from '../../../common/prisma-errors';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import { type SeoOwnerScope, SeoSistrixService } from './seo-sistrix.service';
import { poolOfProject } from './sistrix-sync.service';

const iso = (d: Date) => d.toISOString();
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function origin(provider: string, fetchedAt: Date, dataDate: Date | null): SeoDataOriginDto {
  return {
    provider: provider as SeoProviderKey,
    fetchedAt: iso(fetchedAt),
    dataDate: dateOnly(dataDate),
  };
}

/**
 * Datos de SISTRIX de un proyecto: competidores, palabras, resultados de
 * Google, oportunidades, enlaces y visibilidad en IA. Lo descargado se lee del
 * fondo del proyecto (plataforma o la clave del tenant), así que un tenant
 * nunca ve lo pedido con la cuenta de la plataforma salvo que el super admin
 * le haya dado esa conexión.
 */
@Injectable()
export class SeoSistrixDataService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly sistrix: SeoSistrixService,
  ) {}

  private notFound() {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }

  // --------------------------------------------------------- competidores

  async competitors(owner: SeoOwnerScope, projectId: string): Promise<SeoCompetitorDto[]> {
    const p = await this.sistrix.project(owner, projectId);
    const pool = poolOfProject(p);
    const country = p.country.toLowerCase();
    const domains = p.competitors.map((c) => c.domain);
    const [metrics, counts] = await Promise.all([
      this.admin.seoDomainMetric.findMany({
        where: { tenantId: pool, country, domain: { in: domains }, metric: 'visibility' },
        orderBy: { metricDate: 'desc' },
        distinct: ['domain'],
      }),
      this.admin.seoDomainMetric.findMany({
        where: { tenantId: pool, country, domain: { in: domains }, metric: 'keyword_count' },
        orderBy: { metricDate: 'desc' },
        distinct: ['domain'],
      }),
    ]);
    const vis = new Map(metrics.map((m) => [m.domain, m]));
    const kw = new Map(counts.map((m) => [m.domain, Number(m.value)]));
    return p.competitors
      .sort((a, b) => Number(b.isActive) - Number(a.isActive))
      .map((c) => {
        const m = vis.get(c.domain);
        return {
          id: c.id,
          domain: c.domain,
          name: c.name,
          notes: c.notes,
          isActive: c.isActive,
          source: c.source as 'manual' | 'discovered' | 'master',
          createdAt: iso(c.createdAt),
          masterImportedAt: c.masterImport ? iso(c.masterImport.createdAt) : null,
          visibility: m
            ? { ...origin(m.provider, m.fetchedAt, m.metricDate), value: Number(m.value) }
            : null,
          keywordCount: kw.get(c.domain) ?? null,
        };
      });
  }

  private async assertCompetitorRoom(projectId: string, limit: number): Promise<void> {
    const active = await this.admin.seoCompetitor.count({ where: { projectId, isActive: true } });
    if (active >= limit) {
      throw new ConflictException({
        code: 'seo_competitor_limit',
        message: `Puedes seguir ${limit} competidores como mucho. Desactiva alguno antes.`,
      });
    }
  }

  async addCompetitor(owner: string | null, projectId: string, input: CreateSeoCompetitorInput) {
    const p = await this.sistrix.project(owner, projectId);
    if (p.domains.some((d) => d.domain === input.domain)) {
      throw new BadRequestException({
        code: 'seo_competitor_own',
        message: 'Ese dominio es tuyo.',
      });
    }
    await this.assertCompetitorRoom(projectId, this.sistrix.limits(p).competitors);
    const existing = p.competitors.find((c) => c.domain === input.domain);
    if (existing) {
      if (existing.isActive) {
        throw new ConflictException({ code: 'seo_competitor_exists', message: 'Ya lo sigues.' });
      }
      // Uno descubierto pasa a seguirse.
      await this.admin.seoCompetitor.update({
        where: { id: existing.id },
        data: {
          isActive: true,
          name: input.name ?? existing.name,
          notes: input.notes ?? existing.notes,
        },
      });
    } else {
      try {
        await this.admin.seoCompetitor.create({
          data: {
            tenantId: p.tenantId,
            projectId,
            domain: input.domain,
            name: input.name ?? null,
            notes: input.notes ?? null,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({ code: 'seo_competitor_exists', message: 'Ya lo sigues.' });
        }
        throw err;
      }
    }
    return this.competitors(owner, projectId);
  }

  async updateCompetitor(
    owner: string | null,
    projectId: string,
    competitorId: string,
    input: UpdateSeoCompetitorInput,
  ) {
    const p = await this.sistrix.project(owner, projectId);
    const c = p.competitors.find((x) => x.id === competitorId);
    if (!c) throw this.notFound();
    if (input.isActive === true && !c.isActive) {
      await this.assertCompetitorRoom(projectId, this.sistrix.limits(p).competitors);
    }
    await this.admin.seoCompetitor.update({
      where: { id: competitorId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return this.competitors(owner, projectId);
  }

  async removeCompetitor(owner: string | null, projectId: string, competitorId: string) {
    const p = await this.sistrix.project(owner, projectId);
    if (!p.competitors.some((x) => x.id === competitorId)) throw this.notFound();
    await this.admin.seoCompetitor.delete({ where: { id: competitorId } });
    return this.competitors(owner, projectId);
  }

  // ----------------------------------------------------------- visibilidad

  /** Evolución de la visibilidad: tus dominios y tus competidores activos. */
  async visibility(owner: SeoOwnerScope, projectId: string): Promise<SeoVisibilitySeriesDto[]> {
    const p = await this.sistrix.project(owner, projectId);
    const pool = poolOfProject(p);
    const country = p.country.toLowerCase();
    const own = p.domains.map((d) => d.domain);
    const comp = p.competitors.filter((c) => c.isActive).map((c) => c.domain);
    const domains = [...new Set([...own, ...comp])];
    const since = new Date(Date.now() - 400 * 24 * 3600_000);
    const rows = await this.admin.seoDomainMetric.findMany({
      where: {
        tenantId: pool,
        country,
        metric: 'visibility',
        domain: { in: domains },
        metricDate: { gte: since },
      },
      orderBy: [{ metricDate: 'asc' }, { fetchedAt: 'asc' }],
    });
    return domains.map((domain) => {
      const byDate = new Map<string, (typeof rows)[number]>();
      for (const r of rows.filter((x) => x.domain === domain))
        byDate.set(dateOnly(r.metricDate)!, r);
      const points = [...byDate.values()].map((r) => ({
        date: dateOnly(r.metricDate)!,
        value: Number(r.value),
        provider: r.provider as SeoProviderKey,
      }));
      const last = [...byDate.values()].at(-1);
      return {
        domain,
        own: own.includes(domain),
        points,
        latest: last
          ? { ...origin(last.provider, last.fetchedAt, last.metricDate), value: Number(last.value) }
          : null,
      };
    });
  }

  // ------------------------------------------------- palabras de un dominio

  private assertDomain(
    p: { domains: { domain: string }[]; competitors: { domain: string }[] },
    domain: string,
  ) {
    if (
      !p.domains.some((d) => d.domain === domain) &&
      !p.competitors.some((c) => c.domain === domain)
    ) {
      throw new BadRequestException({
        code: 'seo_domain_not_in_project',
        message: 'Ese dominio no es del proyecto ni de sus competidores.',
      });
    }
  }

  async domainKeywords(
    owner: SeoOwnerScope,
    projectId: string,
    domain: string,
  ): Promise<SeoDomainKeywordsDto> {
    const p = await this.sistrix.project(owner, projectId);
    this.assertDomain(p, domain);
    const pool = poolOfProject(p);
    const country = p.country.toLowerCase();
    const samples = await this.admin.seoDomainKeyword.findMany({
      where: { tenantId: pool, domain, country },
      distinct: ['sampleDate'],
      orderBy: { sampleDate: 'desc' },
      select: { sampleDate: true },
      take: 2,
    });
    if (samples.length === 0) return { domain, origin: null, previousDate: null, items: [] };
    const [latest, previous] = samples;
    const [rows, prevRows] = await Promise.all([
      this.admin.seoDomainKeyword.findMany({
        where: { tenantId: pool, domain, country, sampleDate: latest!.sampleDate },
        orderBy: { position: 'asc' },
        take: 500,
      }),
      previous
        ? this.admin.seoDomainKeyword.findMany({
            where: { tenantId: pool, domain, country, sampleDate: previous.sampleDate },
            select: { keyword: true, position: true },
          })
        : Promise.resolve([]),
    ]);
    const prev = new Map(prevRows.map((r) => [r.keyword, r.position]));
    const first = rows[0];
    return {
      domain,
      origin: first ? origin(first.provider, first.fetchedAt, first.sampleDate) : null,
      previousDate: dateOnly(previous?.sampleDate),
      items: rows.map((r) => ({
        keyword: r.keyword,
        position: r.position,
        url: r.url,
        previousPosition: previous ? (prev.get(r.keyword) ?? null) : null,
      })),
    };
  }

  async domainKeywordHistory(
    owner: SeoOwnerScope,
    projectId: string,
    domain: string,
    keyword: string,
  ): Promise<SeoDomainKeywordHistoryDto> {
    const p = await this.sistrix.project(owner, projectId);
    this.assertDomain(p, domain);
    const rows = await this.admin.seoDomainKeyword.findMany({
      where: { tenantId: poolOfProject(p), domain, country: p.country.toLowerCase(), keyword },
      orderBy: { sampleDate: 'asc' },
    });
    return {
      domain,
      keyword,
      points: rows.map((r) => ({
        date: dateOnly(r.sampleDate)!,
        position: r.position,
        url: r.url,
        provider: r.provider as SeoProviderKey,
      })),
    };
  }

  // -------------------------------------------------------------- palabras

  async keywords(owner: SeoOwnerScope, projectId: string): Promise<SeoProjectKeywordDto[]> {
    const p = await this.sistrix.project(owner, projectId);
    const pool = poolOfProject(p);
    const rows = await this.admin.seoProjectKeyword.findMany({
      where: { projectId },
      include: { keyword: true, masterImport: { select: { createdAt: true } } },
      orderBy: [{ isActive: 'desc' }, { priority: 'asc' }, { createdAt: 'asc' }],
    });
    const ids = rows.map((r) => r.keywordId);
    const [metrics, serps] = await Promise.all([
      this.admin.seoKeywordMetric.findMany({
        where: { tenantId: pool, keywordId: { in: ids } },
        orderBy: { fetchedAt: 'desc' },
        distinct: ['keywordId'],
      }),
      this.admin.seoSerpResult.findMany({
        where: { tenantId: pool, keywordId: { in: ids } },
        orderBy: [{ sampleDate: 'desc' }, { position: 'asc' }],
      }),
    ]);
    const own = new Set(p.domains.map((d) => d.domain));
    const comp = new Set(p.competitors.filter((c) => c.isActive).map((c) => c.domain));
    const metricBy = new Map(metrics.map((m) => [m.keywordId, m]));
    const latestSerp = new Map<string, typeof serps>();
    for (const s of serps) {
      const list = latestSerp.get(s.keywordId);
      if (!list) latestSerp.set(s.keywordId, [s]);
      else if (list[0]!.sampleDate.getTime() === s.sampleDate.getTime()) list.push(s);
    }
    return rows.map((r) => {
      const m = metricBy.get(r.keywordId);
      const serp = latestSerp.get(r.keywordId);
      const mine = serp?.find((s) => own.has(s.domain));
      return {
        id: r.id,
        keyword: r.keyword.keyword,
        country: r.keyword.country,
        groupName: r.groupName,
        intent: (r.intent as SeoKeywordIntent | null) ?? null,
        targetUrl: r.targetUrl,
        priority: r.priority,
        notes: r.notes,
        strategyLocked: r.strategyLocked,
        source: r.source as SeoKeywordSource,
        isActive: r.isActive,
        createdAt: iso(r.createdAt),
        masterImportedAt: r.masterImport ? iso(r.masterImport.createdAt) : null,
        metrics: m
          ? {
              ...origin(m.provider, m.fetchedAt, m.dataDate),
              traffic: m.traffic,
              clicks: m.clicks,
              cpc: n(m.cpc),
              competition: m.competition,
              intent: {
                know: m.intentKnow,
                do: m.intentDo,
                visit: m.intentVisit,
                website: m.intentWebsite,
              },
              mobileShare: n(m.mobileShare),
            }
          : null,
        serp: serp?.[0]
          ? {
              ...origin(serp[0].provider, serp[0].fetchedAt, serp[0].sampleDate),
              ownPosition: mine?.position ?? null,
              ownUrl: mine?.url ?? null,
              competitors: serp.filter((s) => comp.has(s.domain)).length,
            }
          : null,
      };
    });
  }

  async addKeywords(owner: string | null, projectId: string, input: AddSeoProjectKeywordsInput) {
    const p = await this.sistrix.project(owner, projectId);
    const limit = this.sistrix.limits(p).keywords;
    const country = p.country.toUpperCase();
    const language = p.language.toLowerCase();
    await this.admin.seoKeyword.createMany({
      data: input.keywords.map((keyword) => ({ keyword, country, language })),
      skipDuplicates: true,
    });
    const catalog = await this.admin.seoKeyword.findMany({
      where: { keyword: { in: input.keywords }, country, language },
      select: { id: true },
    });
    const existing = new Set(
      (
        await this.admin.seoProjectKeyword.findMany({
          where: { projectId, keywordId: { in: catalog.map((c) => c.id) } },
          select: { keywordId: true },
        })
      ).map((r) => r.keywordId),
    );
    const fresh = catalog.filter((c) => !existing.has(c.id));
    const count = await this.admin.seoProjectKeyword.count({ where: { projectId } });
    if (count + fresh.length > limit) {
      throw new ConflictException({
        code: 'seo_keyword_limit',
        message: `Puedes tener ${limit} palabras como mucho (llevas ${count}).`,
      });
    }
    await this.admin.seoProjectKeyword.createMany({
      data: fresh.map((c) => ({
        tenantId: p.tenantId,
        projectId,
        keywordId: c.id,
        groupName: input.groupName ?? null,
        intent: input.intent ?? null,
        priority: input.priority ?? 2,
        source: input.source,
      })),
      skipDuplicates: true,
    });
    return this.keywords(owner, projectId);
  }

  async updateKeyword(
    owner: string | null,
    projectId: string,
    projectKeywordId: string,
    input: UpdateSeoProjectKeywordInput,
  ) {
    await this.sistrix.project(owner, projectId);
    const row = await this.admin.seoProjectKeyword.findFirst({
      where: { id: projectKeywordId, projectId },
    });
    if (!row) throw this.notFound();
    await this.admin.seoProjectKeyword.update({
      where: { id: projectKeywordId },
      data: {
        ...(input.groupName !== undefined ? { groupName: input.groupName } : {}),
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        ...(input.targetUrl !== undefined ? { targetUrl: input.targetUrl } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.strategyLocked !== undefined ? { strategyLocked: input.strategyLocked } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return this.keywords(owner, projectId);
  }

  async removeKeyword(owner: string | null, projectId: string, projectKeywordId: string) {
    await this.sistrix.project(owner, projectId);
    const res = await this.admin.seoProjectKeyword.deleteMany({
      where: { id: projectKeywordId, projectId },
    });
    if (res.count === 0) throw this.notFound();
    return this.keywords(owner, projectId);
  }

  /** Resultados de Google de una palabra del proyecto, marcando los tuyos y los de la competencia. */
  async serp(
    owner: SeoOwnerScope,
    projectId: string,
    projectKeywordId: string,
  ): Promise<SeoSerpDto> {
    const p = await this.sistrix.project(owner, projectId);
    const row = await this.admin.seoProjectKeyword.findFirst({
      where: { id: projectKeywordId, projectId },
      include: { keyword: true },
    });
    if (!row) throw this.notFound();
    const pool = poolOfProject(p);
    const latest = await this.admin.seoSerpResult.findFirst({
      where: { tenantId: pool, keywordId: row.keywordId },
      orderBy: { sampleDate: 'desc' },
    });
    if (!latest) return { keyword: row.keyword.keyword, origin: null, results: [] };
    const results = await this.admin.seoSerpResult.findMany({
      where: {
        tenantId: pool,
        keywordId: row.keywordId,
        sampleDate: latest.sampleDate,
        provider: latest.provider,
      },
      orderBy: { position: 'asc' },
    });
    const own = new Set(p.domains.map((d) => d.domain));
    const comp = new Set(p.competitors.filter((c) => c.isActive).map((c) => c.domain));
    const strip = (d: string) => d.replace(/^www\./, '');
    return {
      keyword: row.keyword.keyword,
      origin: origin(latest.provider, latest.fetchedAt, latest.sampleDate),
      results: results.map((r) => ({
        position: r.position,
        domain: r.domain,
        url: r.url,
        own: own.has(strip(r.domain)),
        competitor: comp.has(strip(r.domain)),
      })),
    };
  }

  // ------------------------------------------ oportunidades, enlaces, IA

  private primary(p: { domains: { domain: string; role: string }[] }): string | null {
    return (p.domains.find((d) => d.role === 'primary') ?? p.domains[0])?.domain ?? null;
  }

  async opportunities(
    owner: SeoOwnerScope,
    projectId: string,
    kind: 'opportunity' | 'idea',
  ): Promise<SeoOpportunitiesDto> {
    const p = await this.sistrix.project(owner, projectId);
    const domain = this.primary(p);
    if (!domain) return { domain: null, kind, origin: null, items: [] };
    const pool = poolOfProject(p);
    const country = p.country.toLowerCase();
    const latest = await this.admin.seoDomainOpportunity.findFirst({
      where: { tenantId: pool, domain, country, kind },
      orderBy: { sampleDate: 'desc' },
    });
    if (!latest) return { domain, kind, origin: null, items: [] };
    const rows = await this.admin.seoDomainOpportunity.findMany({
      where: {
        tenantId: pool,
        domain,
        country,
        kind,
        sampleDate: latest.sampleDate,
        provider: latest.provider,
      },
      orderBy: [{ gain: 'desc' }, { keyword: 'asc' }],
    });
    const inProject = new Set(
      (
        await this.admin.seoProjectKeyword.findMany({
          where: { projectId },
          include: { keyword: { select: { keyword: true } } },
        })
      ).map((k) => k.keyword.keyword),
    );
    return {
      domain,
      kind,
      origin: origin(latest.provider, latest.fetchedAt, latest.sampleDate),
      items: rows.map((r) => ({
        keyword: r.keyword,
        position: r.position,
        url: r.url,
        gain: r.gain,
        competition: r.competition,
        traffic: r.traffic,
        inProject: inProject.has(r.keyword.toLowerCase()),
      })),
    };
  }

  async backlinks(owner: SeoOwnerScope, projectId: string): Promise<SeoBacklinksDto> {
    const p = await this.sistrix.project(owner, projectId);
    const domain = this.primary(p);
    if (!domain) return { domain: null, origin: null, items: [] };
    const pool = poolOfProject(p);
    const latest = await this.admin.seoBacklinkTarget.findFirst({
      where: { tenantId: pool, domain },
      orderBy: { sampleDate: 'desc' },
    });
    if (!latest) return { domain, origin: null, items: [] };
    const rows = await this.admin.seoBacklinkTarget.findMany({
      where: { tenantId: pool, domain, sampleDate: latest.sampleDate, provider: latest.provider },
      orderBy: { domains: 'desc' },
    });
    return {
      domain,
      origin: origin(latest.provider, latest.fetchedAt, latest.sampleDate),
      items: rows.map((r) => ({ url: r.url, links: r.links, domains: r.domains, hosts: r.hosts })),
    };
  }

  async aiVisibility(owner: SeoOwnerScope, projectId: string): Promise<SeoAiVisibilityRowDto[]> {
    const p = await this.sistrix.project(owner, projectId);
    const pool = poolOfProject(p);
    const own = p.domains.map((d) => d.domain);
    const domains = [
      ...new Set([...own, ...p.competitors.filter((c) => c.isActive).map((c) => c.domain)]),
    ];
    const rows = await this.admin.seoAiVisibility.findMany({
      where: {
        tenantId: pool,
        subjectType: 'domain',
        domain: { in: domains },
        country: p.country.toLowerCase(),
      },
      orderBy: { sampleDate: 'desc' },
      distinct: ['domain'],
    });
    return rows.map((r) => ({
      ...origin(r.provider, r.fetchedAt, r.sampleDate),
      domain: r.domain,
      own: own.includes(r.domain),
      promptCount: r.promptCount,
      models: (r.models as { model: string; promptCount: number }[]) ?? [],
    }));
  }
}
