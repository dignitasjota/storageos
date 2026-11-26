import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type SeoAnnotationProposalDto,
  type SeoAnnotationProposalsDto,
  type SeoSiteChangeDto,
} from '@storageos/shared';

import { isUniqueViolation } from '../../../common/prisma-errors';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoSiteChangesService } from '../plan/seo-site-changes.service';
import { SeoProjectsService, type SeoActor, type SeoOwner } from '../seo-projects.service';

/** Días hacia atrás del registro de actividad que se miran. */
const LOOKBACK_DAYS = 60;
const MAX_PROPOSALS = 50;

interface AuditRow {
  id: string;
  action: string;
  occurredAt: Date;
  entityId: string | null;
  changes: unknown;
}

/** Día y hora de España de un instante. */
export function madridParts(at: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Una entrada del registro de actividad como actuación propuesta (o null si no
 * toca el SEO). Pura: la prueban los tests.
 */
export function proposalFromAudit(row: AuditRow): SeoAnnotationProposalDto | null {
  const c = obj(row.changes);
  const when = madridParts(row.occurredAt);
  const base = { sourceRef: row.id, changeDate: when.date, changeTime: when.time };
  switch (row.action) {
    case 'tenant.web_settings.changed': {
      const seo = 'webSeo' in c;
      const content = 'webHeadline' in c || 'webAbout' in c || 'webContent' in c;
      const template = 'webTemplate' in c;
      if (!seo && !content && !template) return null;
      return {
        ...base,
        type: seo ? 'title_meta' : 'content',
        title: seo
          ? 'Cambio del título o la descripción de la web'
          : template
            ? 'Cambio de la plantilla de la web'
            : 'Cambio de los textos de la web',
        description: seo
          ? 'Editado desde Configuración → Web (SEO de la web).'
          : 'Editado desde Configuración → Web.',
        urls: ['/'],
        origin: 'Registro de actividad: ajustes de la web',
      };
    }
    case 'blog_post.created':
    case 'blog_post.published': {
      const slug = text(c.slug) ?? text(obj(c.seo).slug);
      const title = text(c.title) ?? 'Entrada del blog';
      if (row.action === 'blog_post.created' && c.isPublished !== true) return null;
      return {
        ...base,
        type: 'new_page',
        title: `Entrada publicada: ${title}`,
        description: 'Publicada en el blog.',
        urls: slug ? [`/blog/${slug}`] : [],
        origin: 'Registro de actividad: blog',
      };
    }
    case 'blog_post.seo_changed': {
      const slug = text(obj(c.seo).slug);
      return {
        ...base,
        type: 'title_meta',
        title: `Título o descripción de la entrada: ${text(c.title) ?? 'del blog'}`,
        description: 'Editado el título o la descripción para Google de una entrada del blog.',
        urls: slug ? [`/blog/${slug}`] : [],
        origin: 'Registro de actividad: blog',
      };
    }
    case 'blog_post.slug_changed': {
      const slug = obj(c.slug);
      const to = text(slug.to);
      const from = text(slug.from);
      return {
        ...base,
        type: 'redirect',
        title: `Cambio de dirección de la entrada: ${text(c.title) ?? 'del blog'}`,
        description: from && to ? `De /blog/${from} a /blog/${to}.` : null,
        urls: [from, to].filter((x): x is string => !!x).map((x) => `/blog/${x}`),
        origin: 'Registro de actividad: blog',
      };
    }
    case 'area_page.created':
    case 'area_page.published': {
      if (row.action === 'area_page.created' && c.isPublished !== true) return null;
      return {
        ...base,
        type: 'new_page',
        title: `Página de zona publicada: ${text(c.name) ?? 'zona'}`,
        description: 'Publicada una página de zona.',
        urls: text(c.slug) ? [`/${text(c.slug)}`] : [],
        origin: 'Registro de actividad: páginas de zona',
      };
    }
    case 'area_page.slug_changed': {
      const slug = obj(c.slug);
      const from = text(slug.from);
      const to = text(slug.to);
      return {
        ...base,
        type: 'redirect',
        title: `Cambio de dirección de la página de zona: ${text(c.name) ?? 'zona'}`,
        description: from && to ? `De /${from} a /${to}.` : null,
        urls: [from, to].filter((x): x is string => !!x).map((x) => `/${x}`),
        origin: 'Registro de actividad: páginas de zona',
      };
    }
    default:
      return null;
  }
}

export const AUDIT_ACTIONS_FOR_SEO = [
  'tenant.web_settings.changed',
  'blog_post.created',
  'blog_post.published',
  'blog_post.seo_changed',
  'blog_post.slug_changed',
  'area_page.created',
  'area_page.published',
  'area_page.slug_changed',
];

/**
 * Anotaciones automáticas (mejora 6): lo que el negocio cambia en su web (SEO
 * de la web, blog, páginas de zona) queda en el registro de actividad; aquí se
 * propone como actuación ya rellenada. Nunca se crea nada sin que alguien la
 * confirme, y lo descartado no vuelve a proponerse.
 */
@Injectable()
export class SeoAnnotationsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly changes: SeoSiteChangesService,
  ) {}

  async proposals(
    owner: SeoOwner | undefined,
    projectId: string,
  ): Promise<SeoAnnotationProposalsDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    // El registro de actividad es de los negocios: el proyecto de la plataforma no tiene.
    if (!project.tenantId) return { projectId, items: [] };
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
    const [rows, done, dismissed] = await Promise.all([
      this.admin.auditLog.findMany({
        where: {
          tenantId: project.tenantId,
          action: { in: AUDIT_ACTIONS_FOR_SEO },
          occurredAt: { gte: since },
        },
        orderBy: { occurredAt: 'desc' },
        take: 300,
        select: { id: true, action: true, occurredAt: true, entityId: true, changes: true },
      }),
      this.admin.seoSiteChange.findMany({
        where: { projectId, sourceRef: { not: null } },
        select: { sourceRef: true },
      }),
      this.admin.seoAnnotationDismissal.findMany({
        where: { projectId },
        select: { sourceRef: true },
      }),
    ]);
    const skip = new Set([...done, ...dismissed].map((d) => d.sourceRef));
    const items: SeoAnnotationProposalDto[] = [];
    for (const row of rows) {
      if (skip.has(row.id)) continue;
      const p = proposalFromAudit(row);
      if (p) items.push(p);
      if (items.length >= MAX_PROPOSALS) break;
    }
    return { projectId, items };
  }

  /** Confirma una propuesta: crea la actuación con lo propuesto (se puede editar después). */
  async confirm(
    owner: SeoOwner,
    projectId: string,
    sourceRef: string,
    actor: SeoActor,
  ): Promise<SeoSiteChangeDto> {
    const { items } = await this.proposals(owner, projectId);
    const p = items.find((i) => i.sourceRef === sourceRef);
    if (!p) {
      throw new NotFoundException({
        code: 'seo_annotation_not_found',
        message: 'Esa propuesta ya no está (la confirmaron, la descartaron o es muy antigua).',
      });
    }
    const created = await this.changes.create(
      owner,
      projectId,
      {
        date: p.changeDate,
        time: p.changeTime,
        type: p.type as 'title_meta',
        title: p.title,
        description: p.description,
        urls: p.urls,
        keywords: [],
        notes: `${p.origin}.`,
      },
      actor,
    );
    try {
      await this.admin.seoSiteChange.update({
        where: { id: created.id },
        data: { source: 'auto', sourceRef },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        await this.admin.seoSiteChange.delete({ where: { id: created.id } });
        throw new ConflictException({
          code: 'seo_annotation_exists',
          message: 'Esa propuesta ya se confirmó.',
        });
      }
      throw err;
    }
    return created;
  }

  async dismiss(owner: SeoOwner, projectId: string, sourceRefs: string[]): Promise<void> {
    const project = await this.projects.resolveProject(owner, projectId);
    await this.admin.seoAnnotationDismissal.createMany({
      data: [...new Set(sourceRefs)].map((sourceRef) => ({
        tenantId: project.tenantId,
        projectId,
        sourceRef,
      })),
      skipDuplicates: true,
    });
  }
}
