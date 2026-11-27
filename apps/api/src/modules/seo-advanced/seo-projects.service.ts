import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SEO_DEFAULT_FREQUENCIES,
  SEO_DEFAULT_WEIGHTS,
  SEO_GSC_DELAY_DAYS,
  SEO_TENANT_LIMITS,
  daysBetween,
  seoDomainOfProperty,
  seoPeriodRange,
  summarizeSeoSite,
  type CreateSeoDomainInput,
  type CreateSeoProjectInput,
  type CreateTenantSeoProjectInput,
  type SeoConnectionStatus,
  type SeoDomainRole,
  type SeoDomainVerification,
  type SeoFrequencies,
  type SeoGscPropertiesDto,
  type SeoProjectDomainDto,
  type SeoProjectDto,
  type SeoProjectStatus,
  type SeoStrategy,
  type SeoSummaryDto,
  type SeoSyncRunDto,
  type SeoSyncKind,
  type SeoSyncStatus,
  type SeoTenantProjectRowDto,
  type SeoWeights,
  type SeoWorkspaceDto,
  type UpdateSeoDomainInput,
  type UpdateSeoProjectInput,
} from '@storageos/shared';

import { googleUnavailable, isGoogleTransient } from '../../common/google/google-service-account';
import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { SearchConsoleClient } from '../search-console/search-console.client';

import { SeoDomainOwnershipService } from './seo-domain-ownership.service';
import { SeoGscSyncService } from './seo-gsc-sync.service';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';

/** Dueño de un proyecto: el id del tenant o `null` (la plataforma). */
export type SeoOwner = string | null;

/** Quién hace la acción (para el historial de descargas). */
export interface SeoActor {
  userId?: string | null;
  superAdminId?: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

const PROJECT_INCLUDE = {
  domains: {
    orderBy: [{ createdAt: 'asc' }],
    include: {
      runs: {
        where: { status: { in: ['queued', 'running'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  },
} satisfies Prisma.SeoProjectInclude;

export type ProjectRow = Prisma.SeoProjectGetPayload<{ include: typeof PROJECT_INCLUDE }>;
type RunRow = Prisma.SeoSyncRunGetPayload<{ include: { domain: { select: { domain: true } } } }>;

/**
 * Proyectos de SEO Avanzado: los de la plataforma (`tenantId` null, panel del
 * super admin) y el de cada tenant con el extra. Las lecturas y escrituras de
 * un tenant van con su contexto (política de filas); las de la plataforma, con
 * la conexión de administración y siempre filtrando `tenantId: null`.
 */
@Injectable()
export class SeoProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly client: SearchConsoleClient,
    private readonly sync: SeoGscSyncService,
    private readonly config: ConfigService<Env, true>,
    private readonly ownership: SeoDomainOwnershipService,
  ) {}

  private db<T>(owner: SeoOwner, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return owner ? this.prisma.withTenant(fn, owner) : this.admin.$transaction(fn);
  }

  // ---------------------------------------------------------------- lectura

  /** Proyectos de un dueño (la plataforma tiene varios; un tenant, uno). */
  async list(owner: SeoOwner): Promise<SeoProjectDto[]> {
    const rows = await this.db(owner, (tx) =>
      tx.seoProject.findMany({
        where: { tenantId: owner },
        include: PROJECT_INCLUDE,
        orderBy: { createdAt: 'asc' },
      }),
    );
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  /** Un proyecto de ese dueño (404 si es de otro). */
  async get(owner: SeoOwner, projectId: string): Promise<SeoProjectDto> {
    return this.toDto(await this.findProject(owner, projectId));
  }

  /** Id del proyecto del tenant (404 si aún no lo ha creado). */
  async tenantProjectId(tenantId: string): Promise<string> {
    const row = await this.db(tenantId, (tx) =>
      tx.seoProject.findFirst({ where: { tenantId }, select: { id: true } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'seo_project_missing',
        message: 'Crea primero el proyecto de tu web.',
      });
    }
    return row.id;
  }

  /** Cualquier proyecto (solo el super admin: los de los tenants, en lectura). */
  async getAny(projectId: string): Promise<SeoProjectDto> {
    const row = await this.admin.seoProject.findUnique({
      where: { id: projectId },
      include: PROJECT_INCLUDE,
    });
    if (!row) throw this.notFound();
    return this.toDto(row);
  }

  /**
   * El proyecto con sus dominios para los paneles e importaciones. `undefined`
   * = el super admin leyendo cualquier proyecto (los de los tenants, solo para
   * ver); con dueño, solo el suyo (404 si es de otro).
   */
  async resolveProject(owner: SeoOwner | undefined, projectId: string): Promise<ProjectRow> {
    if (owner !== undefined) return this.findProject(owner, projectId);
    const row = await this.admin.seoProject.findUnique({
      where: { id: projectId },
      include: PROJECT_INCLUDE,
    });
    if (!row) throw this.notFound();
    return row;
  }

  private async findProject(owner: SeoOwner, projectId: string): Promise<ProjectRow> {
    const row = await this.db(owner, (tx) =>
      tx.seoProject.findFirst({
        where: { id: projectId, tenantId: owner },
        include: PROJECT_INCLUDE,
      }),
    );
    if (!row) throw this.notFound();
    return row;
  }

  /** Lo que ve el tenant: su proyecto (si lo creó) y cómo conectar Google. */
  async workspace(tenantId: string): Promise<SeoWorkspaceDto> {
    const [project] = await this.list(tenantId);
    return {
      project: project ?? null,
      available: this.client.available,
      serviceAccountEmail: this.client.serviceAccountEmail,
      limits: SEO_TENANT_LIMITS,
      suggestedProperty: await this.suggestedProperty(tenantId),
    };
  }

  /** Propiedades a las que la cuenta de servicio tiene acceso (panel admin). */
  async properties(): Promise<SeoGscPropertiesDto> {
    if (!this.client.available) {
      return { available: false, serviceAccountEmail: null, properties: [] };
    }
    let sites: { siteUrl: string; permissionLevel: string }[];
    try {
      sites = await this.client.listSites();
    } catch (err) {
      if (isGoogleTransient(err)) throw googleUnavailable(err);
      throw err;
    }
    const used = await this.admin.seoProjectDomain.findMany({
      where: { gscProperty: { in: sites.map((s) => s.siteUrl), mode: 'insensitive' } },
      select: { gscProperty: true, project: { select: { name: true, tenantId: true } } },
    });
    const tenants = await this.tenantNames(
      used.map((u) => u.project.tenantId).filter((t): t is string => !!t),
    );
    const usedBy = new Map(
      used.map((u) => [
        u.gscProperty.toLowerCase(),
        u.project.tenantId
          ? `${tenants.get(u.project.tenantId)?.name ?? 'Tenant'} (tenant)`
          : u.project.name,
      ]),
    );
    return {
      available: true,
      serviceAccountEmail: this.client.serviceAccountEmail,
      properties: sites.map((s) => ({
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
        domain: seoDomainOfProperty(s.siteUrl),
        usedBy: usedBy.get(s.siteUrl.toLowerCase()) ?? null,
      })),
    };
  }

  /** Proyectos de los tenants (panel admin, solo lectura). */
  async tenantProjects(): Promise<SeoTenantProjectRowDto[]> {
    const rows = await this.admin.seoProject.findMany({
      where: { tenantId: { not: null } },
      include: { domains: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const tenantIds = rows.map((r) => r.tenantId!);
    const tenants = await this.tenantNames(tenantIds);
    const features = await Promise.all(
      tenantIds.map((id) => tenantHasFeature(this.admin, id, 'seo_advanced')),
    );
    return rows.map((r, i) => {
      const t = tenants.get(r.tenantId!);
      const synced = r.domains
        .map((d) => d.lastSyncedAt)
        .filter((d): d is Date => !!d)
        .sort((a, b) => b.getTime() - a.getTime());
      const primary = r.domains.find((d) => d.role === 'primary') ?? r.domains[0];
      return {
        id: r.id,
        tenantId: r.tenantId!,
        tenantName: t?.name ?? '—',
        tenantSlug: t?.slug ?? '',
        name: r.name,
        status: r.status as SeoProjectStatus,
        featureEnabled: features[i] ?? false,
        domains: r.domains.map((d) => ({
          domain: d.domain,
          role: d.role as SeoDomainRole,
          connectionStatus: d.connectionStatus as SeoConnectionStatus,
        })),
        lastSyncedAt: synced[0]?.toISOString() ?? null,
        dataUntil: dateOnly(primary?.dataUntil),
      };
    });
  }

  // -------------------------------------------------------------- proyectos

  async create(
    owner: SeoOwner,
    input: CreateSeoProjectInput | CreateTenantSeoProjectInput,
  ): Promise<SeoProjectDto> {
    let name = input.name;
    if (owner) {
      const existing = await this.db(owner, (tx) =>
        tx.seoProject.findFirst({ where: { tenantId: owner }, select: { id: true } }),
      );
      if (existing) {
        throw new ConflictException({
          code: 'seo_project_exists',
          message: 'Tu negocio ya tiene su proyecto de SEO.',
        });
      }
      name ??= (await this.admin.tenant.findUnique({ where: { id: owner } }))?.name ?? 'Mi web';
    }
    const created = await this.db(owner, (tx) =>
      tx.seoProject.create({
        data: {
          tenantId: owner,
          name: name ?? 'Proyecto',
          country: input.country,
          language: input.language,
          businessType: input.businessType ?? null,
          strategy: input.strategy,
          targetLocation: input.targetLocation ?? null,
          brandTerms: input.brandTerms,
        },
        select: { id: true },
      }),
    );
    // El tenant empieza con la web que ya tiene en TrasterOS como principal.
    if (owner) {
      const property = await this.suggestedProperty(owner);
      if (property && !(await this.propertyTaken(owner, property))) {
        const domain = await this.insertDomain(owner, created.id, property, 'primary');
        // Si la cuenta ya tiene acceso, se conecta y empieza la carga.
        if (this.client.available) {
          await this.check(owner, domain, {}).catch((err: unknown) => {
            if (err instanceof HttpException) return;
            throw err;
          });
        }
      }
    }
    return this.get(owner, created.id);
  }

  async update(
    owner: SeoOwner,
    projectId: string,
    input: UpdateSeoProjectInput,
  ): Promise<SeoProjectDto> {
    await this.findProject(owner, projectId);
    await this.db(owner, (tx) =>
      tx.seoProject.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.language !== undefined ? { language: input.language } : {}),
          ...(input.businessType !== undefined ? { businessType: input.businessType } : {}),
          ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
          ...(input.targetLocation !== undefined ? { targetLocation: input.targetLocation } : {}),
          ...(input.brandTerms !== undefined ? { brandTerms: input.brandTerms } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      }),
    );
    return this.get(owner, projectId);
  }

  /** Borra un proyecto de la plataforma con sus dominios y lo descargado. */
  async remove(owner: SeoOwner, projectId: string): Promise<void> {
    await this.findProject(owner, projectId);
    await this.db(owner, (tx) => tx.seoProject.delete({ where: { id: projectId } }));
  }

  // --------------------------------------------------------------- dominios

  async addDomain(
    owner: SeoOwner,
    projectId: string,
    input: CreateSeoDomainInput,
    actor: SeoActor,
  ): Promise<SeoProjectDto> {
    const project = await this.findProject(owner, projectId);
    const property = input.gscProperty.trim();
    const domain = seoDomainOfProperty(property);
    if (project.domains.some((d) => d.domain === domain)) {
      throw new ConflictException({
        code: 'seo_domain_exists',
        message: `${domain} ya está en este proyecto.`,
      });
    }
    const hasPrimary = project.domains.some((d) => d.role === 'primary');
    const role: SeoDomainRole = input.role ?? (hasPrimary ? 'secondary' : 'primary');
    const own = !owner || (await this.ownProperty(owner, property));
    if (owner && !own) {
      // El principal tiene que ser una web del negocio. Otra web solo entra como
      // secundaria si nuestra cuenta tiene acceso a ella en Search Console.
      if (role === 'primary') {
        throw new BadRequestException({
          code: 'seo_primary_not_yours',
          message: `${await this.notYours(owner, property)} Otra web solo puede ser un dominio secundario.`,
        });
      }
      this.assertRoleAllowed(owner, project.domains, role);
      await this.assertExternalSecondary(owner, projectId, property);
      const created = await this.insertExternalDomain(owner, projectId, property, role);
      // Ya se comprobó el acceso: empieza la carga.
      await this.setConnection(owner, created.id, 'connected', null);
      await this.sync.enqueue(created.id, 'initial', actor);
      return this.get(owner, projectId);
    }
    // El dueño verificado de la web se la quita a quien la tuviera como
    // secundario externo (solo tenía acceso de la cuenta de servicio).
    if (owner) await this.releaseExternalHolders(owner, property);
    if (await this.propertyTaken(owner, property)) {
      throw new ConflictException({
        code: 'seo_property_taken',
        message: 'Esa propiedad ya está conectada en otra cuenta de TrasterOS.',
      });
    }
    this.assertRoleAllowed(owner, project.domains, role);
    const created = await this.insertDomain(owner, projectId, property, role);
    // Se comprueba el acceso al momento (y, si lo hay, empieza la carga). Si
    // Google no responde, queda pendiente y se comprueba luego a mano.
    if (this.client.available) {
      await this.check(owner, created, actor).catch((err: unknown) => {
        if (err instanceof HttpException) return;
        throw err;
      });
    }
    return this.get(owner, projectId);
  }

  async updateDomain(
    owner: SeoOwner,
    projectId: string,
    domainId: string,
    input: UpdateSeoDomainInput,
  ): Promise<SeoProjectDto> {
    const project = await this.findProject(owner, projectId);
    const domain = project.domains.find((d) => d.id === domainId);
    if (!domain) throw this.notFound();
    if (domain.role !== input.role) {
      if (owner && input.role === 'primary' && domain.verification === 'gsc_access') {
        throw new BadRequestException({
          code: 'seo_primary_not_yours',
          message: `${domain.domain} no es una web de tu negocio en TrasterOS: solo puede ser un dominio secundario.`,
        });
      }
      this.assertRoleAllowed(
        owner,
        project.domains.filter((d) => d.id !== domainId),
        input.role,
      );
      await this.db(owner, (tx) =>
        tx.seoProjectDomain.update({ where: { id: domainId }, data: { role: input.role } }),
      );
    }
    return this.get(owner, projectId);
  }

  async removeDomain(owner: SeoOwner, projectId: string, domainId: string): Promise<SeoProjectDto> {
    const project = await this.findProject(owner, projectId);
    if (!project.domains.some((d) => d.id === domainId)) throw this.notFound();
    await this.db(owner, (tx) => tx.seoProjectDomain.delete({ where: { id: domainId } }));
    return this.get(owner, projectId);
  }

  /**
   * Comprueba que la cuenta de servicio tiene acceso a la propiedad. Si lo
   * tiene y el dominio aún no tiene sus 16 meses, empieza la carga inicial.
   */
  async checkDomain(
    owner: SeoOwner,
    projectId: string,
    domainId: string,
    actor: SeoActor,
  ): Promise<SeoProjectDto> {
    const project = await this.findProject(owner, projectId);
    const domain = project.domains.find((d) => d.id === domainId);
    if (!domain) throw this.notFound();
    await this.check(owner, domain, actor);
    return this.get(owner, projectId);
  }

  private async check(
    owner: SeoOwner,
    domain: {
      id: string;
      gscProperty: string;
      initialDoneAt: Date | null;
      role: string;
      verification: string;
      projectId: string;
    },
    actor: SeoActor,
  ): Promise<void> {
    if (!this.client.available) {
      throw new ServiceUnavailableException({
        code: 'search_console_not_configured',
        message: 'La conexión con Search Console no está disponible todavía.',
      });
    }
    // Un dominio que dejó de ser del tenant no se vuelve a conectar. Un
    // secundario externo vuelve a pasar sus condiciones (salvo el acceso, que
    // se mira justo después).
    if (owner && !(await this.ownProperty(owner, domain.gscProperty))) {
      const reason =
        domain.role === 'primary' || domain.verification !== 'gsc_access'
          ? await this.notYours(owner, domain.gscProperty)
          : await this.externalRejection(owner, domain.projectId, domain.gscProperty);
      if (reason) {
        await this.setConnection(owner, domain.id, 'error', reason);
        throw new BadRequestException({ code: 'seo_property_not_yours', message: reason });
      }
    }
    let access = false;
    let error: string | null = null;
    try {
      access = await this.client.hasAccess(domain.gscProperty);
    } catch (err) {
      if (isGoogleTransient(err)) throw googleUnavailable(err);
      error = err instanceof Error ? err.message : String(err);
    }
    const message = access
      ? null
      : (error ??
        `Nuestra cuenta (${this.client.serviceAccountEmail}) no tiene acceso a ${domain.gscProperty}. Añádela como usuario en Search Console → Configuración → Usuarios y permisos y vuelve a comprobarlo.`);
    await this.setConnection(owner, domain.id, access ? 'connected' : 'error', message);
    if (access && !domain.initialDoneAt) {
      await this.sync.enqueue(domain.id, 'initial', actor);
    }
  }

  private async setConnection(
    owner: SeoOwner,
    domainId: string,
    status: SeoConnectionStatus,
    lastError: string | null,
  ): Promise<void> {
    const now = new Date();
    await this.db(owner, (tx) =>
      tx.seoProjectDomain.update({
        where: { id: domainId },
        data: {
          connectionStatus: status,
          lastError,
          checkedAt: now,
          ...(status === 'connected' ? { connectedAt: now } : {}),
        },
      }),
    );
  }

  /** Descarga ya (sin esperar a la de cada día). */
  async syncDomain(
    owner: SeoOwner,
    projectId: string,
    domainId: string,
    actor: SeoActor,
  ): Promise<SeoSyncRunDto> {
    const project = await this.findProject(owner, projectId);
    const domain = project.domains.find((d) => d.id === domainId);
    if (!domain) throw this.notFound();
    if (domain.connectionStatus !== 'connected') {
      throw new BadRequestException({
        code: 'seo_domain_not_connected',
        message: 'Comprueba primero el acceso a Search Console de este dominio.',
      });
    }
    if (project.status !== 'active') {
      throw new BadRequestException({
        code: 'seo_project_paused',
        message: 'El proyecto está en pausa: actívalo para descargar.',
      });
    }
    const run = await this.sync.enqueue(
      domainId,
      domain.initialDoneAt ? 'manual' : 'initial',
      actor,
    );
    return this.runDto(owner, run);
  }

  // -------------------------------------------------------------- descargas

  async runs(owner: SeoOwner | undefined, projectId: string): Promise<SeoSyncRunDto[]> {
    // `undefined` = el super admin leyendo cualquier proyecto.
    if (owner !== undefined) await this.findProject(owner, projectId);
    const rows = await this.admin.seoSyncRun.findMany({
      // Solo las de Search Console (las de SISTRIX tienen su propia lista).
      where: { projectId, dataType: null },
      include: { domain: { select: { domain: true } } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return this.toRunDtos(rows);
  }

  async cancelRun(owner: SeoOwner, runId: string): Promise<SeoSyncRunDto> {
    const run = await this.db(owner, (tx) =>
      tx.seoSyncRun.findFirst({ where: { id: runId, tenantId: owner, dataType: null } }),
    );
    if (!run) throw this.notFound();
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new BadRequestException({
        code: 'seo_run_not_active',
        message: 'Esa descarga ya terminó.',
      });
    }
    await this.sync.cancel(runId);
    return this.runDto(owner, runId);
  }

  private async runDto(owner: SeoOwner, runId: string): Promise<SeoSyncRunDto> {
    const row = await this.admin.seoSyncRun.findFirst({
      where: { id: runId, tenantId: owner },
      include: { domain: { select: { domain: true } } },
    });
    if (!row) throw this.notFound();
    const [dto] = await this.toRunDtos([row]);
    return dto!;
  }

  // ---------------------------------------------------------------- resumen

  /**
   * Totales del periodo y del anterior desde el cruce `site` (los que cuadran
   * con Google), por dispositivo y lo que Google no detalla por búsqueda.
   */
  async summary(
    owner: SeoOwner | undefined,
    projectId: string,
    opts: { days: number; domainId?: string | undefined },
  ): Promise<SeoSummaryDto> {
    const project =
      owner === undefined
        ? await this.admin.seoProject.findUnique({
            where: { id: projectId },
            include: PROJECT_INCLUDE,
          })
        : await this.findProject(owner, projectId);
    if (!project) throw this.notFound();
    const domain = opts.domainId
      ? project.domains.find((d) => d.id === opts.domainId)
      : (project.domains.find((d) => d.role === 'primary') ?? project.domains[0]);
    if (opts.domainId && !domain) throw this.notFound();
    const days = opts.days;
    const delay = domain ? this.delayDays(domain.syncedUntil ?? domain.dataUntil) : null;
    if (!domain) {
      const range = seoPeriodRange(today(), days);
      return {
        projectId,
        domainId: null,
        domain: null,
        days,
        lastDate: null,
        ...range,
        current: { clicks: 0, impressions: 0, ctr: null, position: null },
        previous: null,
        change: null,
        devices: [],
        undetailed: null,
        daily: [],
        delayed: false,
      };
    }
    const bounds = await this.admin.seoGscMetric.aggregate({
      where: { domainId: domain.id, grain: 'site' },
      _min: { date: true },
      _max: { date: true },
    });
    const lastDate = dateOnly(bounds._max.date);
    const range = seoPeriodRange(lastDate ?? today(), days);
    const asRow = (r: { date: Date; clicks: number; impressions: number; position: unknown }) => ({
      date: dateOnly(r.date)!,
      clicks: r.clicks,
      impressions: r.impressions,
      position: Number(r.position),
    });
    const between = (from: string, to: string) => ({
      gte: new Date(`${from}T00:00:00Z`),
      lte: new Date(`${to}T00:00:00Z`),
    });
    const [site, devices, byQuery, detailRows] = await Promise.all([
      this.admin.seoGscMetric.findMany({
        where: { domainId: domain.id, grain: 'site', date: between(range.previousFrom, range.to) },
        select: { date: true, clicks: true, impressions: true, position: true },
      }),
      this.admin.seoGscMetric.findMany({
        where: { domainId: domain.id, grain: 'device', date: between(range.from, range.to) },
        select: { date: true, device: true, clicks: true, impressions: true, position: true },
      }),
      this.admin.seoGscMetric.aggregate({
        where: { domainId: domain.id, grain: 'query', date: between(range.from, range.to) },
        _sum: { clicks: true, impressions: true },
        _count: { _all: true },
      }),
      this.admin.seoGscMetric.findMany({
        where: { domainId: domain.id, grain: 'query', date: between(range.from, range.to) },
        select: { date: true },
        distinct: ['date'],
      }),
    ]);
    const summary = summarizeSeoSite({
      days,
      site: site.map(asRow),
      devices: devices.map((d) => ({ ...asRow(d), device: d.device })),
      queryTotals:
        byQuery._count._all > 0
          ? {
              clicks: byQuery._sum.clicks ?? 0,
              impressions: byQuery._sum.impressions ?? 0,
              ctr: null,
              position: null,
            }
          : null,
      firstDate: dateOnly(bounds._min.date),
      lastDate,
      detailDates: detailRows.map((r) => dateOnly(r.date)!),
    });
    return {
      projectId,
      domainId: domain.id,
      domain: domain.domain,
      days,
      ...summary,
      delayed: delay !== null && delay > SEO_GSC_DELAY_DAYS,
    };
  }

  // ------------------------------------------------------------- auxiliares

  private assertRoleAllowed(
    owner: SeoOwner,
    others: { role: string }[],
    role: SeoDomainRole,
  ): void {
    if (role === 'primary' && others.some((d) => d.role === 'primary')) {
      throw new ConflictException({
        code: 'seo_primary_exists',
        message: 'El proyecto ya tiene un dominio principal. Cambia antes el otro a secundario.',
      });
    }
    if (
      owner &&
      role !== 'primary' &&
      others.filter((d) => d.role !== 'primary').length >= SEO_TENANT_LIMITS.secondaryDomains
    ) {
      throw new ConflictException({
        code: 'seo_domain_limit',
        message: `Puedes tener un dominio principal y ${SEO_TENANT_LIMITS.secondaryDomains} más.`,
      });
    }
  }

  private async insertDomain(
    owner: SeoOwner,
    projectId: string,
    property: string,
    role: SeoDomainRole,
  ) {
    return this.db(owner, (tx) =>
      tx.seoProjectDomain.create({
        data: {
          tenantId: owner,
          projectId,
          domain: seoDomainOfProperty(property),
          role,
          gscProperty: property,
        },
      }),
    );
  }

  /**
   * Un secundario que no es «propio» (§26): la cuenta de servicio tiene acceso
   * a su propiedad, no lo usa ningún otro proyecto (de otro tenant o de la
   * plataforma) y no es un dominio de la plataforma. Lanza el error que toque.
   */
  private async assertExternalSecondary(
    owner: string,
    projectId: string,
    property: string,
  ): Promise<void> {
    const reason = await this.externalRejection(owner, projectId, property);
    if (reason) {
      const platform = this.isPlatformDomain(seoDomainOfProperty(property));
      throw platform
        ? new BadRequestException({ code: 'seo_property_platform', message: reason })
        : new ConflictException({ code: 'seo_property_taken', message: reason });
    }
    if (!this.client.available) {
      throw new ServiceUnavailableException({
        code: 'search_console_not_configured',
        message: 'La conexión con Search Console no está disponible todavía.',
      });
    }
    let access = false;
    try {
      access = await this.client.hasAccess(property);
    } catch (err) {
      if (isGoogleTransient(err)) throw googleUnavailable(err);
      throw err;
    }
    if (!access) {
      throw new BadRequestException({
        code: 'seo_property_no_access',
        message: `${property} no es una web de tu negocio en TrasterOS, así que solo se puede añadir si nuestra cuenta (${this.client.serviceAccountEmail}) tiene acceso a ella en Search Console. Pide a quien la gestione que la añada como usuario en Configuración → Usuarios y permisos y vuelve a intentarlo.`,
      });
    }
  }

  /** Por qué no vale como secundario externo (null si vale, sin mirar el acceso). */
  private async externalRejection(
    owner: string,
    projectId: string,
    property: string,
  ): Promise<string | null> {
    const domain = seoDomainOfProperty(property);
    if (this.isPlatformDomain(domain)) {
      return `${domain} es un dominio de TrasterOS: no se puede añadir como dominio de tu negocio.`;
    }
    if (await this.domainTakenAnywhere(owner, projectId, property)) {
      return `${domain} ya lo usa otra cuenta de TrasterOS. Si es tuyo, escríbenos a soporte.`;
    }
    // La cuenta de servicio es la misma para todos: que tenga acceso no prueba
    // que sea de quien lo pide. Si otro negocio demuestra que es suyo (dominio
    // propio o de correo verificado, o su «SEO local»), no se le ofrece a este.
    if (await this.ownership.belongsToAnotherTenant(owner, domain)) {
      return `${domain} es el dominio verificado de otra cuenta de TrasterOS. Si es tuyo, escríbenos a soporte.`;
    }
    return null;
  }

  /** El dominio (o la misma propiedad) ya está en otro proyecto, de quien sea. */
  private async domainTakenAnywhere(
    owner: string,
    projectId: string,
    property: string,
  ): Promise<boolean> {
    const taken = await this.admin.seoProjectDomain.findFirst({
      where: {
        projectId: { not: projectId },
        OR: [
          { domain: seoDomainOfProperty(property) },
          { gscProperty: { equals: property, mode: 'insensitive' } },
        ],
      },
      select: { tenantId: true },
    });
    return !!taken && taken.tenantId !== owner;
  }

  private isPlatformDomain(domain: string): boolean {
    return this.ownership.isPlatformDomain(domain);
  }

  /**
   * Alta de un secundario externo con un candado por dominio: dos negocios que
   * lo añaden a la vez no se lo quedan los dos.
   */
  private async insertExternalDomain(
    owner: string,
    projectId: string,
    property: string,
    role: SeoDomainRole,
  ) {
    const domain = seoDomainOfProperty(property);
    return this.db(owner, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seo-domain:${domain}`}))`;
      if (await this.domainTakenAnywhere(owner, projectId, property)) {
        throw new ConflictException({
          code: 'seo_property_taken',
          message: `${domain} ya lo usa otra cuenta de TrasterOS. Si es tuyo, escríbenos a soporte.`,
        });
      }
      return tx.seoProjectDomain.create({
        data: {
          tenantId: owner,
          projectId,
          domain,
          role,
          gscProperty: property,
          verification: 'gsc_access',
        },
      });
    });
  }

  /**
   * Quita de los proyectos de otros negocios esta web cuando la tienen solo como
   * secundario externo (`gsc_access`) y quien la añade es su dueño verificado.
   */
  private async releaseExternalHolders(owner: string, property: string): Promise<void> {
    const domain = seoDomainOfProperty(property);
    await this.admin.seoProjectDomain.deleteMany({
      where: {
        verification: 'gsc_access',
        tenantId: { not: null, notIn: [owner] },
        OR: [{ domain }, { gscProperty: { equals: property, mode: 'insensitive' } }],
      },
    });
  }

  /**
   * La propiedad ya está en el proyecto de otro tenant (la misma, o una de
   * dominio del mismo dominio). Las direcciones de la plataforma comparten
   * dominio (`trasteros.pro/s/<slug>/`), así que ahí cuenta la propiedad.
   */
  private async propertyTaken(owner: SeoOwner, property: string): Promise<boolean> {
    if (!owner) return false;
    const isDomainProperty = property.toLowerCase().startsWith('sc-domain:');
    const taken = await this.admin.seoProjectDomain.findFirst({
      where: {
        tenantId: { not: null, notIn: [owner] },
        OR: [
          { gscProperty: { equals: property, mode: 'insensitive' } },
          ...(isDomainProperty
            ? [
                {
                  domain: seoDomainOfProperty(property),
                  gscProperty: { startsWith: 'sc-domain:', mode: 'insensitive' as const },
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    return !!taken;
  }

  private ownProperty(tenantId: string, property: string): Promise<boolean> {
    return this.ownership.ownProperty(tenantId, property);
  }

  private async notYours(tenantId: string, property: string): Promise<string> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    const platform = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    return `${property} no es una web de tu negocio en TrasterOS. Puedes conectar tu dominio propio, el dominio de tu correo verificado o tu dirección en la plataforma (${platform}/s/${tenant?.slug ?? '<tu identificador>'}/).`;
  }

  private async suggestedProperty(tenantId: string): Promise<string | null> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    if (!tenant) return null;
    if (tenant.customDomain && tenant.customDomainVerifiedAt) {
      return `sc-domain:${seoDomainOfProperty(tenant.customDomain)}`;
    }
    const platform = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    return `${platform}/s/${tenant.slug}/`;
  }

  private async tenantNames(ids: string[]) {
    if (ids.length === 0) return new Map<string, { name: string; slug: string }>();
    const rows = await this.admin.tenant.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true, slug: true },
    });
    return new Map(rows.map((t) => [t.id, { name: t.name, slug: t.slug }]));
  }

  private delayDays(dataUntil: Date | null): number | null {
    const until = dateOnly(dataUntil);
    return until ? daysBetween(until, today()) : null;
  }

  private async toDto(row: ProjectRow): Promise<SeoProjectDto> {
    const tenant = row.tenantId ? (await this.tenantNames([row.tenantId])).get(row.tenantId) : null;
    const activeRuns = row.domains.flatMap((d) => d.runs);
    const runDtos = new Map(
      (
        await this.toRunDtos(
          activeRuns.map((r) => ({
            ...r,
            domain: { domain: row.domains.find((d) => d.id === r.domainId)?.domain ?? '' },
          })),
        )
      ).map((r) => [r.id, r]),
    );
    return {
      id: row.id,
      tenantId: row.tenantId,
      tenantName: tenant?.name ?? null,
      tenantSlug: tenant?.slug ?? null,
      name: row.name,
      country: row.country,
      language: row.language,
      businessType: row.businessType,
      strategy: row.strategy as SeoStrategy,
      targetLocation: row.targetLocation,
      brandTerms: row.brandTerms,
      weights: { ...SEO_DEFAULT_WEIGHTS, ...(row.weights as Partial<SeoWeights>) },
      frequencies: {
        ...SEO_DEFAULT_FREQUENCIES,
        ...(row.frequencies as Partial<SeoFrequencies>),
      },
      status: row.status as SeoProjectStatus,
      createdAt: row.createdAt.toISOString(),
      domains: row.domains.map((d): SeoProjectDomainDto => {
        const delay = this.delayDays(d.syncedUntil ?? d.dataUntil);
        const active = d.runs[0];
        return {
          id: d.id,
          domain: d.domain,
          role: d.role as SeoDomainRole,
          gscProperty: d.gscProperty,
          connectionStatus: d.connectionStatus as SeoConnectionStatus,
          lastError: d.lastError,
          checkedAt: d.checkedAt?.toISOString() ?? null,
          connectedAt: d.connectedAt?.toISOString() ?? null,
          lastSyncedAt: d.lastSyncedAt?.toISOString() ?? null,
          dataUntil: dateOnly(d.dataUntil),
          dataDelayDays: delay,
          delayed: delay !== null && delay > SEO_GSC_DELAY_DAYS,
          initialDone: !!d.initialDoneAt,
          verification: d.verification as SeoDomainVerification,
          activeRun: active ? (runDtos.get(active.id) ?? null) : null,
        };
      }),
    };
  }

  private async toRunDtos(rows: RunRow[]): Promise<SeoSyncRunDto[]> {
    const userIds = [
      ...new Set(rows.map((r) => r.createdByUserId).filter((x): x is string => !!x)),
    ];
    const adminIds = [
      ...new Set(rows.map((r) => r.createdBySuperAdminId).filter((x): x is string => !!x)),
    ];
    const [users, admins] = await Promise.all([
      userIds.length > 0
        ? this.admin.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, fullName: true },
          })
        : [],
      adminIds.length > 0
        ? this.admin.superAdmin.findMany({
            where: { id: { in: adminIds } },
            select: { id: true, fullName: true },
          })
        : [],
    ]);
    const names = new Map([...users, ...admins].map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      domainId: r.domainId,
      domain: r.domain?.domain ?? null,
      provider: 'gsc',
      kind: r.kind as SeoSyncKind,
      status: r.status as SeoSyncStatus,
      daysDone: r.daysDone,
      daysTotal: r.daysTotal,
      rangeFrom: dateOnly(r.rangeFrom),
      rangeTo: dateOnly(r.rangeTo),
      rows: r.rows,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      createdBy:
        names.get(r.createdByUserId ?? '') ?? names.get(r.createdBySuperAdminId ?? '') ?? null,
    }));
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: 'seo_not_found', message: 'No existe.' });
  }
}
