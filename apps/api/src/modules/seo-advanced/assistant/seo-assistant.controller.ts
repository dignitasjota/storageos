import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CreateSeoBriefSchema,
  permissionsForRole,
  SeoAssistantChatSchema,
  SeoBriefToDraftSchema,
  UpdateSeoBriefSchema,
  type CreateSeoBriefInput,
  type SeoAssistantActionDto,
  type SeoAssistantChatResultDto,
  type SeoAssistantConversationDetailDto,
  type SeoAssistantConversationDto,
  type SeoBriefDto,
  type SeoBriefListItemDto,
  type SeoBriefToDraftResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { RequireFeature } from '../../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { AdminGuard } from '../../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../../admin/require-superadmin.decorator';
import { SeoProjectsService } from '../seo-projects.service';

import { type SeoAssistantActor, SeoAssistantService } from './seo-assistant.service';
import { SeoBriefsService } from './seo-briefs.service';

import type { AiReservation } from '../../ai/ai-quota.service';
import type { ChatStreamHooks } from '../../ai/ai.service';
import type { Response } from 'express';

class ChatDto extends createZodDto(SeoAssistantChatSchema) {}
class UpdateBriefDto extends createZodDto(UpdateSeoBriefSchema) {}
class ToDraftDto extends createZodDto(SeoBriefToDraftSchema) {}

/** Las preguntas gastan consultas de IA: 20 por minuto como mucho. */
const CHAT_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * Chat en streaming (Server-Sent Events), como el asistente del panel:
 * `start` (conversación), `text` (trozo), `tool` (herramienta que consulta),
 * `done` (mensaje guardado) y `error`. La consulta se reserva antes de abrir
 * el stream, así que el límite responde con su 429 como siempre.
 */
async function streamChat(
  res: Response,
  reservation: AiReservation | null,
  run: (hooks: ChatStreamHooks) => Promise<SeoAssistantChatResultDto>,
  release: () => Promise<void>,
): Promise<void> {
  res.status(HttpStatus.OK);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event: Record<string, unknown>) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, 15_000);
  try {
    const result = await run({
      onText: (delta) => send({ type: 'text', delta }),
      onTool: (name) => send({ type: 'tool', name }),
      onStart: (conversationId) => send({ type: 'start', conversationId }),
      signal: abort.signal,
    });
    send({ type: 'done', ...result });
  } catch (err) {
    if (reservation) await release();
    const response =
      err instanceof HttpException
        ? (err.getResponse() as { code?: string; message?: string })
        : null;
    send({
      type: 'error',
      code: response?.code ?? 'ai_stream_failed',
      message: response?.message ?? 'No se pudo completar la respuesta.',
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

/** El origen del brief (unión discriminada: se valida a mano, `createZodDto` no la admite). */
function parseCreateBrief(raw: unknown): CreateSeoBriefInput {
  const parsed = CreateSeoBriefSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'validation_failed',
      message: 'Elige de dónde sale el brief: una palabra, una oportunidad, un grupo o una URL.',
    });
  }
  return parsed.data;
}

function tenantActor(user: AuthenticatedUser): SeoAssistantActor {
  const permissions = user.permissions ?? permissionsForRole(user.role);
  return {
    kind: 'tenant',
    tenantId: user.tenantId,
    userId: user.sub,
    canWrite: permissions.includes('settings:manage'),
  };
}

function adminActor(admin: AuthenticatedSuperAdmin): SeoAssistantActor {
  return { kind: 'admin', superAdminId: admin.sub, canWrite: admin.role === 'superadmin' };
}

/**
 * Asistente de SEO del proyecto del tenant (PR 11). Incluido en SEO Avanzado y
 * contando contra la cuota de IA del negocio (o su clave propia). Preguntar,
 * con `ai:use` y `analytics:read`; confirmar acciones, además `settings:manage`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced/assistant')
export class SeoAdvancedAssistantController {
  constructor(private readonly assistant: SeoAssistantService) {}

  @RequirePermission('ai:use', 'analytics:read')
  @Get('conversations')
  list(@CurrentUser() user: AuthenticatedUser): Promise<SeoAssistantConversationDto[]> {
    return this.assistant.listConversations(tenantActor(user));
  }

  @RequirePermission('ai:use', 'analytics:read')
  @Get('conversations/:conversationId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId', ParseUUIDPipe) id: string,
  ): Promise<SeoAssistantConversationDetailDto> {
    return this.assistant.getConversation(tenantActor(user), id);
  }

  @RequirePermission('ai:use', 'analytics:read')
  @Delete('conversations/:conversationId')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.assistant.deleteConversation(tenantActor(user), id);
  }

  @RequirePermission('ai:use', 'analytics:read')
  @Post('chat')
  @HttpCode(200)
  @Throttle(CHAT_THROTTLE)
  chat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ChatDto,
  ): Promise<SeoAssistantChatResultDto> {
    return this.assistant.chat(tenantActor(user), body);
  }

  @RequirePermission('ai:use', 'analytics:read')
  @Post('chat/stream')
  @Throttle(CHAT_THROTTLE)
  async chatStream(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ChatDto,
    @Res() res: Response,
  ): Promise<void> {
    const actor = tenantActor(user);
    // Antes de abrir el stream: el proyecto existe y queda consulta.
    await this.assistant.project(actor);
    const reservation = await this.assistant.reserve(actor);
    await streamChat(
      res,
      reservation,
      (hooks) => this.assistant.chat(actor, body, { hooks, reservation }),
      () => this.assistant.release(reservation),
    );
  }

  @RequirePermission('ai:use', 'settings:manage')
  @Post('actions/:actionId/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actionId', ParseUUIDPipe) id: string,
  ): Promise<SeoAssistantActionDto> {
    return this.assistant.confirmAction(tenantActor(user), id);
  }

  @RequirePermission('ai:use', 'analytics:read')
  @Post('actions/:actionId/discard')
  @HttpCode(200)
  discard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actionId', ParseUUIDPipe) id: string,
  ): Promise<SeoAssistantActionDto> {
    return this.assistant.discardAction(tenantActor(user), id);
  }
}

/**
 * Briefs de contenido del proyecto del tenant. Ver con `analytics:read`;
 * generarlos (gasta una consulta de IA) con `ai:use`; cambiarlos, borrarlos y
 * pasarlos a borrador del blog o a una tarea con `settings:manage`.
 */
@RequireFeature('seo_advanced')
@Controller('seo-advanced/briefs')
export class SeoAdvancedBriefsController {
  constructor(
    private readonly projects: SeoProjectsService,
    private readonly briefs: SeoBriefsService,
  ) {}

  private projectId(user: AuthenticatedUser): Promise<string> {
    return this.projects.tenantProjectId(user.tenantId);
  }

  @RequirePermission('analytics:read')
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<SeoBriefListItemDto[]> {
    return this.briefs.list(user.tenantId, await this.projectId(user));
  }

  @RequirePermission('analytics:read')
  @Get(':briefId')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('briefId', ParseUUIDPipe) id: string,
  ): Promise<SeoBriefDto> {
    return this.briefs.get(user.tenantId, await this.projectId(user), id);
  }

  @RequirePermission('analytics:read')
  @Get(':briefId/markdown')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="brief.md"')
  async markdown(
    @CurrentUser() user: AuthenticatedUser,
    @Param('briefId', ParseUUIDPipe) id: string,
  ): Promise<string> {
    return (await this.briefs.get(user.tenantId, await this.projectId(user), id)).contentMarkdown;
  }

  @RequirePermission('ai:use', 'analytics:read')
  @Post()
  @Throttle(CHAT_THROTTLE)
  async create(@CurrentUser() user: AuthenticatedUser, @Body() raw: unknown): Promise<SeoBriefDto> {
    const body = parseCreateBrief(raw);
    return this.briefs.create(user.tenantId, await this.projectId(user), body, {
      kind: 'tenant',
      tenantId: user.tenantId,
      userId: user.sub,
    });
  }

  @RequirePermission('settings:manage')
  @Patch(':briefId')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('briefId', ParseUUIDPipe) id: string,
    @Body() body: UpdateBriefDto,
  ): Promise<SeoBriefDto> {
    return this.briefs.update(user.tenantId, await this.projectId(user), id, body);
  }

  @RequirePermission('settings:manage')
  @Delete(':briefId')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('briefId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.briefs.remove(user.tenantId, await this.projectId(user), id);
  }

  @RequirePermission('settings:manage')
  @Post(':briefId/draft')
  @HttpCode(200)
  async toDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('briefId', ParseUUIDPipe) id: string,
    @Body() body: ToDraftDto,
  ): Promise<SeoBriefToDraftResultDto> {
    return this.briefs.toDraft(user.tenantId, await this.projectId(user), id, body, {
      userId: user.sub,
    });
  }
}

/**
 * El asistente en el panel admin: cualquier super admin pregunta sobre
 * cualquier proyecto (los de los tenants, solo para leer), con la clave de la
 * plataforma y registrado como uso de la plataforma. Confirmar acciones: el
 * rol superadmin y solo en los proyectos de la plataforma.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id/assistant')
export class AdminSeoAssistantController {
  constructor(private readonly assistant: SeoAssistantService) {}

  @Get('conversations')
  list(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<SeoAssistantConversationDto[]> {
    return this.assistant.listConversations(adminActor(admin), projectId);
  }

  @Get('conversations/:conversationId')
  get(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<SeoAssistantConversationDetailDto> {
    return this.assistant.getConversation(adminActor(admin), id, projectId);
  }

  @Delete('conversations/:conversationId')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<void> {
    await this.assistant.deleteConversation(adminActor(admin), id, projectId);
  }

  @Post('chat')
  @HttpCode(200)
  @Throttle(CHAT_THROTTLE)
  chat(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: ChatDto,
  ): Promise<SeoAssistantChatResultDto> {
    return this.assistant.chat(adminActor(admin), body, { projectId });
  }

  @Post('chat/stream')
  @Throttle(CHAT_THROTTLE)
  async chatStream(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Body() body: ChatDto,
    @Res() res: Response,
  ): Promise<void> {
    const actor = adminActor(admin);
    await this.assistant.project(actor, projectId);
    this.assistant.assertAvailable();
    await streamChat(
      res,
      null,
      (hooks) => this.assistant.chat(actor, body, { projectId, hooks }),
      async () => undefined,
    );
  }

  @Post('actions/:actionId/confirm')
  @RequireSuperadmin()
  @HttpCode(200)
  confirm(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('actionId', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<SeoAssistantActionDto> {
    return this.assistant.confirmAction(adminActor(admin), id, projectId);
  }

  @Post('actions/:actionId/discard')
  @HttpCode(200)
  discard(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('actionId', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<SeoAssistantActionDto> {
    return this.assistant.discardAction(adminActor(admin), id, projectId);
  }
}

/**
 * Briefs en el panel admin. Leer: cualquier super admin (también los de los
 * tenants); generar, cambiar, borrar y pasar a borrador: el rol superadmin y
 * solo en los proyectos de la plataforma (con su clave de IA y su blog).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/seo/projects/:id/briefs')
export class AdminSeoBriefsController {
  constructor(private readonly briefs: SeoBriefsService) {}

  @Get()
  list(@Param('id', ParseUUIDPipe) projectId: string): Promise<SeoBriefListItemDto[]> {
    return this.briefs.list(undefined, projectId);
  }

  @Get(':briefId')
  get(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('briefId', ParseUUIDPipe) id: string,
  ): Promise<SeoBriefDto> {
    return this.briefs.get(undefined, projectId, id);
  }

  @Get(':briefId/markdown')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="brief.md"')
  async markdown(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('briefId', ParseUUIDPipe) id: string,
  ): Promise<string> {
    return (await this.briefs.get(undefined, projectId, id)).contentMarkdown;
  }

  @Post()
  @RequireSuperadmin()
  @Throttle(CHAT_THROTTLE)
  create(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() raw: unknown,
  ): Promise<SeoBriefDto> {
    return this.briefs.create(null, projectId, parseCreateBrief(raw), {
      kind: 'admin',
      superAdminId,
    });
  }

  @Patch(':briefId')
  @RequireSuperadmin()
  update(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('briefId', ParseUUIDPipe) id: string,
    @Body() body: UpdateBriefDto,
  ): Promise<SeoBriefDto> {
    return this.briefs.update(null, projectId, id, body);
  }

  @Delete(':briefId')
  @RequireSuperadmin()
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('briefId', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.briefs.remove(null, projectId, id);
  }

  @Post(':briefId/draft')
  @RequireSuperadmin()
  @HttpCode(200)
  toDraft(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('briefId', ParseUUIDPipe) id: string,
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: ToDraftDto,
  ): Promise<SeoBriefToDraftResultDto> {
    return this.briefs.toDraft(null, projectId, id, body, { superAdminId });
  }
}
