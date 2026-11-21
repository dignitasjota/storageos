import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  AddTicketMessageSchema,
  CreateSupportTicketSchema,
  MessageAttachmentUploadSchema,
  RateTicketSchema,
  SetTicketWatchersSchema,
  SupportTicketListFilterEnum,
  UpdateSupportTicketSchema,
  type MessageAttachmentUploadDto,
  type PageDto,
  type SupportTicketDto,
  type SupportTicketMessageDto,
  type SupportTicketWatcherDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { parsePageRequest } from '../../common/pagination';

import { SupportTicketsService } from './support-tickets.service';

import type { Request } from 'express';

class CreateSupportTicketDto extends createZodDto(CreateSupportTicketSchema) {}
class AddTicketMessageDto extends createZodDto(AddTicketMessageSchema) {}
class AttachmentUploadDto extends createZodDto(MessageAttachmentUploadSchema) {}
class RateTicketDto extends createZodDto(RateTicketSchema) {}
class UpdateSupportTicketDto extends createZodDto(UpdateSupportTicketSchema) {}
class SetTicketWatchersDto extends createZodDto(SetTicketWatchersSchema) {}

interface ReqMetaInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

function extractMeta(req: Request): ReqMetaInfo {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

/**
 * Cara tenant del modulo de soporte. Autenticada como tenant user normal
 * (JwtAuthGuard global). Solo expone tickets propios del tenant del JWT.
 */
@Controller('support/tickets')
export class SupportTicketsTenantController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<SupportTicketDto[]> {
    return this.tickets.listForTenant(user.tenantId, user.sub);
  }

  /**
   * La lista por páginas («Cargar más»), con filtros: `status` (open · waiting ·
   * closed), `mine=1` (los que abrí o en los que estoy en copia) y `search`.
   */
  @Get('page')
  async page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('mine') mine?: string,
    @Query('search') search?: string,
  ): Promise<PageDto<SupportTicketDto>> {
    const parsedStatus = status ? SupportTicketListFilterEnum.safeParse(status) : null;
    if (parsedStatus && !parsedStatus.success) {
      throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
    }
    return this.tickets.pageForTenant(user.tenantId, user.sub, parsePageRequest(cursor, limit), {
      status: parsedStatus?.data,
      mine: mine === '1' || mine === 'true',
      search: search ?? undefined,
    });
  }

  /** Nº de tickets con una respuesta de soporte sin leer — badge del menú. */
  @Get('waiting-count')
  async waitingCount(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    return { count: await this.tickets.countWaitingForTenant(user.tenantId, user.sub) };
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SupportTicketDto> {
    return this.tickets.detailForTenant(user.tenantId, id, user.sub, {
      impersonating: Boolean(user.impersonation),
    });
  }

  /** URL firmada para subir un adjunto (imagen o PDF) a un ticket. */
  @Post('attachments/upload-url')
  @HttpCode(HttpStatus.OK)
  uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: AttachmentUploadDto,
  ): Promise<MessageAttachmentUploadDto> {
    return this.tickets.requestAttachmentUpload(user.tenantId, body.mimeType);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateSupportTicketDto,
    @Req() req: Request,
  ): Promise<SupportTicketDto> {
    return this.tickets.createForTenant({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  async addMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AddTicketMessageDto,
    @Req() req: Request,
  ): Promise<SupportTicketMessageDto> {
    return this.tickets.addMessageAsTenant({
      tenantId: user.tenantId,
      userId: user.sub,
      ticketId: id,
      input,
      meta: extractMeta(req),
      impersonating: Boolean(user.impersonation),
    });
  }

  /** Cambiar la prioridad (mientras no esté cerrado). */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateSupportTicketDto,
    @Req() req: Request,
  ): Promise<SupportTicketDto> {
    return this.tickets.updateAsTenant({
      tenantId: user.tenantId,
      userId: user.sub,
      ticketId: id,
      input,
      meta: extractMeta(req),
    });
  }

  /** Reabrir un ticket cerrado (solo durante unos días tras el cierre). */
  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  async reopen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<SupportTicketDto> {
    return this.tickets.reopenAsTenant({
      tenantId: user.tenantId,
      userId: user.sub,
      ticketId: id,
      meta: extractMeta(req),
    });
  }

  /** Compañeros en copia: sustituye la lista. */
  @Put(':id/watchers')
  async setWatchers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SetTicketWatchersDto,
    @Req() req: Request,
  ): Promise<SupportTicketWatcherDto[]> {
    return this.tickets.setWatchersAsTenant({
      tenantId: user.tenantId,
      userId: user.sub,
      ticketId: id,
      userIds: input.userIds,
      meta: extractMeta(req),
    });
  }

  /** Dar el ticket por terminado. */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  async close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<SupportTicketDto> {
    return this.tickets.closeAsTenant({
      tenantId: user.tenantId,
      userId: user.sub,
      ticketId: id,
      meta: extractMeta(req),
    });
  }

  /** Valorar la atención recibida (una vez resuelto o cerrado). */
  @Post(':id/rating')
  @HttpCode(HttpStatus.OK)
  async rate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RateTicketDto,
  ): Promise<SupportTicketDto> {
    return this.tickets.rateAsTenant({
      tenantId: user.tenantId,
      userId: user.sub,
      ticketId: id,
      input,
    });
  }
}
