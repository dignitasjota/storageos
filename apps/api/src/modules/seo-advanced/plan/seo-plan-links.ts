import { BadRequestException } from '@nestjs/common';
import { normalizeSeoKeyword, type SeoSiteChangeType, type SeoTaskType } from '@storageos/shared';

import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { ProjectRow } from '../seo-projects.service';

/**
 * Lo que motivó una actuación o una tarea (oportunidad, canibalización o
 * hallazgo de indexación): se comprueba que es del mismo proyecto y se saca de
 * ahí lo que no venga rellenado (título, alcance y dominio).
 */
export interface SeoPlanSourceIds {
  opportunityId?: string | null | undefined;
  cannibalizationId?: string | null | undefined;
  indexFindingId?: string | null | undefined;
}

export interface SeoPlanSourceContext {
  title: string;
  urls: string[];
  keywords: string[];
  domainId: string | null;
  /** Tipo propuesto de actuación y de tarea. */
  changeType: SeoSiteChangeType;
  taskType: SeoTaskType;
  /** «Oportunidad: …», para la tarjeta. */
  label: string;
}

export function invalidLink(): BadRequestException {
  return new BadRequestException({
    code: 'seo_link_invalid',
    message: 'Lo que quieres enlazar no es de este proyecto.',
  });
}

/** Dominio del proyecto: el indicado (si es suyo) o el principal. */
export function resolveDomainId(project: ProjectRow, domainId: string | null | undefined) {
  if (domainId) {
    if (!project.domains.some((d) => d.id === domainId)) {
      throw new BadRequestException({
        code: 'seo_domain_invalid',
        message: 'Ese dominio no es de este proyecto.',
      });
    }
    return domainId;
  }
  return (project.domains.find((d) => d.role === 'primary') ?? project.domains[0])?.id ?? null;
}

export async function loadPlanSource(
  admin: PrismaAdminService,
  projectId: string,
  ids: SeoPlanSourceIds,
): Promise<SeoPlanSourceContext | null> {
  // Los tres enlaces tienen que ser del proyecto, no solo el primero (la clave
  // ajena de la base de datos admite un id de otro proyecto).
  await assertPlanLinks(admin, projectId, {
    opportunityId: ids.opportunityId,
    cannibalizationId: ids.cannibalizationId,
    indexFindingId: ids.indexFindingId,
  });
  if (ids.opportunityId) {
    const o = await admin.seoOpportunity.findFirst({
      where: { id: ids.opportunityId, projectId },
    });
    if (!o) throw invalidLink();
    const urls = [o.targetUrl ?? o.page].filter((u): u is string => !!u);
    return {
      title: `Oportunidad: ${o.query}`,
      urls,
      keywords: [normalizeSeoKeyword(o.query)],
      domainId: o.domainId,
      changeType: o.type === 'low_ctr' ? 'title_meta' : 'content',
      taskType: 'content',
      label: `Oportunidad «${o.query}»`,
    };
  }
  if (ids.cannibalizationId) {
    const c = await admin.seoCannibalization.findFirst({
      where: { id: ids.cannibalizationId, projectId },
    });
    if (!c) throw invalidLink();
    const pages = Array.isArray(c.pages) ? (c.pages as { page?: unknown }[]) : [];
    const urls = pages
      .map((p) => (typeof p.page === 'string' ? p.page : null))
      .filter((u): u is string => !!u)
      .slice(0, 10);
    return {
      title: `Canibalización: ${c.query}`,
      urls,
      keywords: [normalizeSeoKeyword(c.query)],
      domainId: c.domainId,
      changeType: 'internal_links',
      taskType: 'content',
      label: `Canibalización «${c.query}»`,
    };
  }
  if (ids.indexFindingId) {
    const f = await admin.seoIndexFinding.findFirst({
      where: { id: ids.indexFindingId, projectId },
    });
    if (!f) throw invalidLink();
    return {
      title: `Indexación: ${f.url}`,
      urls: [f.url],
      keywords: [],
      domainId: f.domainId,
      changeType: f.category === 'redirect_domain' ? 'redirect' : 'noindex',
      taskType: 'technical',
      label: `Página en Google «${f.url}»`,
    };
  }
  return null;
}

/** Comprueba que los enlaces que llegan son del proyecto (sin cargar el contexto). */
export async function assertPlanLinks(
  admin: PrismaAdminService,
  projectId: string,
  ids: SeoPlanSourceIds & { taskId?: string | null; changeId?: string | null },
): Promise<void> {
  const checks: Promise<number>[] = [];
  if (ids.opportunityId)
    checks.push(admin.seoOpportunity.count({ where: { id: ids.opportunityId, projectId } }));
  if (ids.cannibalizationId)
    checks.push(
      admin.seoCannibalization.count({ where: { id: ids.cannibalizationId, projectId } }),
    );
  if (ids.indexFindingId)
    checks.push(admin.seoIndexFinding.count({ where: { id: ids.indexFindingId, projectId } }));
  if (ids.taskId) checks.push(admin.seoTask.count({ where: { id: ids.taskId, projectId } }));
  if (ids.changeId)
    checks.push(admin.seoSiteChange.count({ where: { id: ids.changeId, projectId } }));
  const found = await Promise.all(checks);
  if (found.some((n) => n === 0)) throw invalidLink();
}

/** Nombres de usuarios y super admins por id (para «quién»). */
export async function personNames(
  admin: PrismaAdminService,
  userIds: (string | null)[],
  adminIds: (string | null)[],
): Promise<Map<string, string>> {
  const u = [...new Set(userIds.filter((x): x is string => !!x))];
  const a = [...new Set(adminIds.filter((x): x is string => !!x))];
  const [users, admins] = await Promise.all([
    u.length
      ? admin.user.findMany({ where: { id: { in: u } }, select: { id: true, fullName: true } })
      : Promise.resolve([]),
    a.length
      ? admin.superAdmin.findMany({
          where: { id: { in: a } },
          select: { id: true, fullName: true },
        })
      : Promise.resolve([]),
  ]);
  return new Map([...users, ...admins].map((x) => [x.id, x.fullName]));
}
