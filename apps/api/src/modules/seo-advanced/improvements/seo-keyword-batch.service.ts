import { ConflictException, Injectable } from '@nestjs/common';
import { type BatchUpdateSeoKeywordsInput, type SeoBatchResultDto } from '@storageos/shared';

import { isUniqueViolation } from '../../../common/prisma-errors';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoDiagnosticsService } from '../diagnostics/seo-diagnostics.service';
import { SeoProjectsService, type SeoOwner } from '../seo-projects.service';

/**
 * Palabras en lote (mejora 10): poner grupo, prioridad, intención y URL
 * objetivo a varias a la vez, aceptar de un golpe las URL que propone Google
 * y renombrar un grupo. Cada operación va filtrada por el proyecto.
 */
@Injectable()
export class SeoKeywordBatchService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly projects: SeoProjectsService,
    private readonly diagnostics: SeoDiagnosticsService,
  ) {}

  async update(
    owner: SeoOwner,
    projectId: string,
    input: BatchUpdateSeoKeywordsInput,
  ): Promise<SeoBatchResultDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const res = await this.admin.seoProjectKeyword.updateMany({
      where: { projectId, id: { in: input.ids } },
      data: {
        ...(input.groupName !== undefined ? { groupName: input.groupName || null } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.intent !== undefined ? { intent: input.intent || null } : {}),
        ...(input.targetUrl !== undefined ? { targetUrl: input.targetUrl || null } : {}),
      },
    });
    // Un grupo nuevo aparece también en la lista de grupos (con su prioridad por defecto).
    if (input.groupName) await this.ensureGroup(project.tenantId, projectId, input.groupName);
    return { updated: res.count };
  }

  /** Pone como URL objetivo la que Google propone en las palabras que no tienen una. */
  async acceptSuggestedUrls(owner: SeoOwner, projectId: string): Promise<SeoBatchResultDto> {
    const data = await this.diagnostics.trackedKeywords(owner, projectId, { days: 90 });
    const todo = data.items.filter(
      (k) => k.isActive && !k.targetUrl && k.targetStatus === 'no_target' && !!k.suggestedUrl,
    );
    let updated = 0;
    for (const k of todo) {
      const res = await this.admin.seoProjectKeyword.updateMany({
        where: { id: k.id, projectId, targetUrl: null },
        data: { targetUrl: k.suggestedUrl },
      });
      updated += res.count;
    }
    return { updated };
  }

  /** Renombra un grupo (y junta con el de ese nombre, si ya existía). */
  async renameGroup(
    owner: SeoOwner,
    projectId: string,
    from: string,
    to: string,
  ): Promise<SeoBatchResultDto> {
    const project = await this.projects.resolveProject(owner, projectId);
    const res = await this.admin.seoProjectKeyword.updateMany({
      where: { projectId, groupName: from },
      data: { groupName: to },
    });
    const old = await this.admin.seoKeywordGroup.findUnique({
      where: { projectId_name: { projectId, name: from } },
    });
    const target = await this.admin.seoKeywordGroup.findUnique({
      where: { projectId_name: { projectId, name: to } },
    });
    if (old && !target) {
      try {
        await this.admin.seoKeywordGroup.update({ where: { id: old.id }, data: { name: to } });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        throw new ConflictException({
          code: 'seo_group_exists',
          message: 'Ya hay un grupo con ese nombre.',
        });
      }
    } else if (old && target) {
      await this.admin.seoKeywordGroup.delete({ where: { id: old.id } });
    } else if (res.count > 0) {
      await this.ensureGroup(project.tenantId, projectId, to);
    }
    return { updated: res.count };
  }

  private async ensureGroup(
    tenantId: string | null,
    projectId: string,
    name: string,
  ): Promise<void> {
    await this.admin.seoKeywordGroup
      .create({ data: { tenantId, projectId, name, source: 'manual' } })
      .catch((err: unknown) => {
        if (!isUniqueViolation(err)) throw err;
      });
  }
}
