import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  AddSeoProjectKeywordsSchema,
  CreateSeoSiteChangeSchema,
  CreateSeoTaskSchema,
  normalizeSeoKeyword,
  SEO_SITE_CHANGE_TYPE_LABELS,
  SEO_TASK_TYPE_LABELS,
  type SeoAssistantActionDto,
  type SeoAssistantActionType,
} from '@storageos/shared';
import { z } from 'zod';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoOpportunitiesService } from '../opportunities/seo-opportunities.service';
import { SeoSiteChangesService } from '../plan/seo-site-changes.service';
import { SeoTasksService } from '../plan/seo-tasks.service';
import { type SeoActor, type SeoOwner } from '../seo-projects.service';
import { SeoSistrixDataService } from '../sistrix/seo-sistrix-data.service';

import type { Prisma } from '@storageos/database';

/** Una propuesta sin confirmar caduca a los 7 días: los datos ya pueden no valer. */
const ACTION_TTL_MS = 7 * 86_400_000;
/** Una acción «en curso» más tiempo que esto se cortó a medias. */
const EXECUTING_STALE_MS = 10 * 60_000;

/** Lo que el modelo puede proponer de cada acción (el resto se ignora). */
const TaskPayload = CreateSeoTaskSchema.pick({
  title: true,
  description: true,
  type: true,
  priority: true,
  url: true,
  keywords: true,
  opportunityId: true,
  dueDate: true,
});
const ChangePayload = CreateSeoSiteChangeSchema.pick({
  date: true,
  type: true,
  title: true,
  description: true,
  urls: true,
  keywords: true,
  opportunityId: true,
});
const OpportunityPayload = z.object({ opportunityId: z.string().uuid() });
const FollowPayload = z.object({
  keyword: z.string().trim().min(2).max(120),
  groupName: z.string().trim().max(80).nullable().optional(),
  priority: z.number().int().min(1).max(3).optional(),
});

/** Herramienta de propuesta → tipo de acción. */
export const SEO_PROPOSAL_TOOLS: Record<string, SeoAssistantActionType> = {
  seo_propose_task: 'create_task',
  seo_propose_change: 'register_change',
  seo_propose_opportunity: 'opportunity_in_progress',
  seo_propose_follow_keyword: 'follow_keyword',
};

/** Quién propone o confirma, y en qué proyecto. */
export interface SeoActionScope {
  /** Dueño del proyecto para escribir: el tenant o `null` (la plataforma). */
  owner: SeoOwner;
  projectId: string;
  tenantId: string | null;
  actor: SeoActor;
}

type Row = Prisma.SeoAiActionGetPayload<object>;
type Prepared =
  | { ok: true; payload: Record<string, unknown>; summary: string }
  | { ok: false; error: string };

/**
 * Acciones que el asistente de SEO PROPONE y la persona confirma: crear una
 * tarea SEO, registrar una actuación, poner una oportunidad en curso o seguir
 * una palabra. El modelo solo propone (se valida y se guarda `proposed`); se
 * ejecuta al confirmar, con los servicios de siempre (las mismas reglas que
 * desde la pantalla). Quien llama comprueba antes que puede cambiar el proyecto.
 */
@Injectable()
export class SeoAssistantActionsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly tasks: SeoTasksService,
    private readonly changes: SeoSiteChangesService,
    private readonly opportunities: SeoOpportunitiesService,
    private readonly sistrixData: SeoSistrixDataService,
  ) {}

  async propose(
    scope: SeoActionScope,
    conversationId: string,
    type: SeoAssistantActionType,
    input: unknown,
  ): Promise<{ ok: true; actionId: string; summary: string } | { ok: false; error: string }> {
    const prepared = await this.prepare(scope, type, input);
    if (!prepared.ok) return prepared;
    const row = await this.admin.seoAiAction.create({
      data: {
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        conversationId,
        userId: scope.actor.userId ?? null,
        superAdminId: scope.actor.superAdminId ?? null,
        type,
        payload: prepared.payload as Prisma.InputJsonValue,
        summary: prepared.summary,
      },
    });
    return { ok: true, actionId: row.id, summary: prepared.summary };
  }

  private async prepare(
    scope: SeoActionScope,
    type: SeoAssistantActionType,
    input: unknown,
  ): Promise<Prepared> {
    if (type === 'create_task') {
      const p = TaskPayload.safeParse(input);
      if (!p.success) return { ok: false, error: 'Datos de la tarea no válidos' };
      if (p.data.opportunityId && !(await this.opportunityExists(scope, p.data.opportunityId))) {
        return { ok: false, error: 'Esa oportunidad no es de este proyecto' };
      }
      const t = p.data;
      return {
        ok: true,
        payload: t,
        summary: `Crear la tarea «${t.title}»${t.type ? ` (${SEO_TASK_TYPE_LABELS[t.type]})` : ''}${
          t.dueDate ? ` para el ${t.dueDate}` : ''
        }`,
      };
    }
    if (type === 'register_change') {
      const p = ChangePayload.safeParse(input);
      if (!p.success) return { ok: false, error: 'Datos de la actuación no válidos' };
      if (p.data.opportunityId && !(await this.opportunityExists(scope, p.data.opportunityId))) {
        return { ok: false, error: 'Esa oportunidad no es de este proyecto' };
      }
      return {
        ok: true,
        payload: p.data,
        summary: `Registrar la actuación «${p.data.title}» (${SEO_SITE_CHANGE_TYPE_LABELS[p.data.type]}) del ${p.data.date}`,
      };
    }
    if (type === 'opportunity_in_progress') {
      const p = OpportunityPayload.safeParse(input);
      if (!p.success) return { ok: false, error: 'Falta la oportunidad' };
      const row = await this.admin.seoOpportunity.findFirst({
        where: { id: p.data.opportunityId, projectId: scope.projectId },
        select: { query: true, status: true },
      });
      if (!row) return { ok: false, error: 'Esa oportunidad no es de este proyecto' };
      if (row.status === 'in_progress')
        return { ok: false, error: 'Esa oportunidad ya está en curso' };
      return {
        ok: true,
        payload: p.data,
        summary: `Poner en curso la oportunidad «${row.query}»`,
      };
    }
    const p = FollowPayload.safeParse(input);
    if (!p.success) return { ok: false, error: 'Falta la palabra' };
    const keyword = normalizeSeoKeyword(p.data.keyword);
    return {
      ok: true,
      payload: {
        keyword,
        ...(p.data.groupName ? { groupName: p.data.groupName } : {}),
        ...(p.data.priority ? { priority: p.data.priority } : {}),
      },
      summary: `Seguir la palabra «${keyword}»${p.data.groupName ? ` en el grupo «${p.data.groupName}»` : ''}`,
    };
  }

  private async opportunityExists(scope: SeoActionScope, id: string): Promise<boolean> {
    return (
      (await this.admin.seoOpportunity.count({ where: { id, projectId: scope.projectId } })) > 0
    );
  }

  /** Enlaza las acciones propuestas en una vuelta con el mensaje que las acompaña. */
  async attachToMessage(actionIds: string[], messageId: string): Promise<void> {
    if (actionIds.length === 0) return;
    await this.admin.seoAiAction.updateMany({
      where: { id: { in: actionIds } },
      data: { messageId },
    });
  }

  async listByConversation(conversationId: string): Promise<Map<string, SeoAssistantActionDto[]>> {
    const rows = await this.admin.seoAiAction.findMany({
      where: { conversationId, messageId: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    const map = new Map<string, SeoAssistantActionDto[]>();
    for (const r of rows) {
      const list = map.get(r.messageId!) ?? [];
      list.push(this.toDto(r));
      map.set(r.messageId!, list);
    }
    return map;
  }

  private async findOwned(scope: SeoActionScope, actionId: string): Promise<Row> {
    const row = await this.admin.seoAiAction.findFirst({
      where: {
        id: actionId,
        projectId: scope.projectId,
        ...(scope.actor.userId
          ? { userId: scope.actor.userId }
          : { superAdminId: scope.actor.superAdminId ?? '' }),
      },
    });
    if (!row) {
      throw new NotFoundException({ code: 'ai_action_not_found', message: 'Acción no encontrada' });
    }
    return row;
  }

  /** Confirma y ejecuta (una sola vez: un doble clic no la repite; una fallida se puede reintentar). */
  async confirm(scope: SeoActionScope, actionId: string): Promise<SeoAssistantActionDto> {
    const action = await this.findOwned(scope, actionId);
    if (scope.owner !== action.tenantId) {
      throw new ForbiddenException({
        code: 'seo_read_only',
        message: 'Este proyecto es de solo lectura para ti.',
      });
    }
    if (action.status === 'proposed' && Date.now() - action.createdAt.getTime() > ACTION_TTL_MS) {
      throw new BadRequestException({
        code: 'ai_action_expired',
        message: 'Esta propuesta es de hace más de 7 días: pídesela otra vez al asistente.',
      });
    }
    const claimed = await this.admin.seoAiAction.updateMany({
      where: { id: action.id, status: { in: ['proposed', 'failed'] } },
      data: { status: 'executing', resolvedAt: new Date() },
    });
    if (claimed.count === 0) return this.toDto(await this.findOwned(scope, action.id));
    let result: { link: string } | { error: string };
    try {
      result = await this.execute(scope, action.type as SeoAssistantActionType, action.payload);
    } catch (err) {
      const response = (err as { response?: { message?: string } }).response;
      result = {
        error:
          response?.message ??
          (err instanceof Error ? err.message : 'No se pudo completar la acción'),
      };
    }
    const failed = 'error' in result;
    const updated = await this.admin.seoAiAction.update({
      where: { id: action.id },
      data: { status: failed ? 'failed' : 'confirmed', result },
    });
    return this.toDto(updated);
  }

  private async execute(
    scope: SeoActionScope,
    type: SeoAssistantActionType,
    payload: unknown,
  ): Promise<{ link: string } | { error: string }> {
    const { owner, projectId, actor } = scope;
    if (type === 'create_task') {
      await this.tasks.create(owner, projectId, TaskPayload.parse(payload), actor);
      // La pestaña del proyecto donde se ve lo hecho.
      return { link: 'plan' };
    }
    if (type === 'register_change') {
      await this.changes.create(owner, projectId, ChangePayload.parse(payload), actor);
      return { link: 'plan' };
    }
    if (type === 'opportunity_in_progress') {
      const { opportunityId } = OpportunityPayload.parse(payload);
      await this.opportunities.update(owner, projectId, opportunityId, { status: 'in_progress' });
      return { link: 'oportunidades' };
    }
    const f = FollowPayload.parse(payload);
    const input = AddSeoProjectKeywordsSchema.parse({
      keywords: [f.keyword],
      ...(f.groupName ? { groupName: f.groupName } : {}),
      ...(f.priority ? { priority: f.priority } : {}),
    });
    await this.sistrixData.addKeywords(owner, projectId, input);
    return { link: 'palabras' };
  }

  async discard(scope: SeoActionScope, actionId: string): Promise<SeoAssistantActionDto> {
    const action = await this.findOwned(scope, actionId);
    await this.admin.seoAiAction.updateMany({
      where: { id: action.id, status: { in: ['proposed', 'failed'] } },
      data: { status: 'discarded', resolvedAt: new Date() },
    });
    return this.toDto(await this.findOwned(scope, action.id));
  }

  toDto(r: Row): SeoAssistantActionDto {
    const result = (r.result ?? {}) as { link?: string; error?: string };
    const base = {
      id: r.id,
      type: r.type as SeoAssistantActionType,
      summary: r.summary,
      details: actionDetails(r.type, (r.payload ?? {}) as Record<string, unknown>),
      createdAt: r.createdAt.toISOString(),
    };
    if (r.status === 'proposed' && Date.now() - r.createdAt.getTime() > ACTION_TTL_MS) {
      return { ...base, status: 'expired', resultLink: null, resultError: null };
    }
    if (
      r.status === 'executing' &&
      (!r.resolvedAt || Date.now() - r.resolvedAt.getTime() > EXECUTING_STALE_MS)
    ) {
      return {
        ...base,
        status: 'failed',
        resultLink: null,
        resultError: 'No se sabe si se completó: compruébalo antes de repetirla.',
      };
    }
    return {
      ...base,
      status: r.status as SeoAssistantActionDto['status'],
      resultLink: result.link ?? null,
      resultError: result.error ?? null,
    };
  }
}

/** Lo que se guardará, para leerlo antes de confirmar. */
function actionDetails(type: string, p: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  if (str(p.description)) parts.push(str(p.description)!);
  if (str(p.url)) parts.push(`URL: ${str(p.url)}`);
  if (Array.isArray(p.urls) && p.urls.length) parts.push(`URL: ${(p.urls as string[]).join(', ')}`);
  if (Array.isArray(p.keywords) && p.keywords.length) {
    parts.push(`Palabras: ${(p.keywords as string[]).join(', ')}`);
  }
  if (type === 'follow_keyword' && str(p.groupName)) parts.push(`Grupo: ${str(p.groupName)}`);
  return parts.length ? parts.join('\n') : null;
}
