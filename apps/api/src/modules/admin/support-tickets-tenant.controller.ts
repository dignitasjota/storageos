import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  AddTicketMessageSchema,
  CreateSupportTicketSchema,
  type SupportTicketDto,
  type SupportTicketMessageDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { SupportTicketsService } from './support-tickets.service';

import type { Request } from 'express';

class CreateSupportTicketDto extends createZodDto(CreateSupportTicketSchema) {}
class AddTicketMessageDto extends createZodDto(AddTicketMessageSchema) {}

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
    return this.tickets.listForTenant(user.tenantId);
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SupportTicketDto> {
    return this.tickets.detailForTenant(user.tenantId, id);
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
    });
  }
}
