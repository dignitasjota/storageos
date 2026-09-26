import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AddTicketMessageSchema,
  type AdminSupportTicketsPageDto,
  AssignTicketSchema,
  type SupportTicketDto,
  type SupportTicketMessageDto,
  SupportTicketPriorityEnum,
  type SupportTicketPriorityValue,
  SupportTicketStatusEnum,
  type SupportTicketStatusValue,
  TransitionTicketSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { SupportTicketsService } from './support-tickets.service';

import type { Request } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AddTicketMessageDto extends createZodDto(AddTicketMessageSchema) {}
class TransitionTicketDto extends createZodDto(TransitionTicketSchema) {}
class AssignTicketDto extends createZodDto(AssignTicketSchema) {}

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
 * Cara super admin del modulo de soporte. Ve todos los tickets y los
 * mensajes internos.
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/support/tickets')
export class SupportTicketsAdminController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('tenantId') tenantId?: string,
    @Query('assignedAdminId') assignedAdminId?: string,
    @Query('priority') priority?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AdminSupportTicketsPageDto> {
    const parsedStatus =
      status && SupportTicketStatusEnum.safeParse(status).success
        ? (status as SupportTicketStatusValue)
        : undefined;
    const parsedPriority =
      priority && SupportTicketPriorityEnum.safeParse(priority).success
        ? (priority as SupportTicketPriorityValue)
        : undefined;
    for (const id of [tenantId, cursor]) {
      if (id && !UUID_RE.test(id)) throw new BadRequestException({ code: 'invalid_id' });
    }
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.tickets.listForAdmin(
      {
        ...(search ? { search } : {}),
        ...(parsedStatus ? { status: parsedStatus } : {}),
        ...(parsedPriority ? { priority: parsedPriority } : {}),
        ...(tenantId ? { tenantId } : {}),
        ...(assignedAdminId !== undefined ? { assignedAdminId } : {}),
      },
      {
        ...(cursor ? { cursor } : {}),
        ...(parsedLimit && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
      },
    );
  }

  /** Nº de tickets abiertos esperando respuesta del admin — badge del menú. */
  @Get('open-count')
  async openCount(): Promise<{ count: number }> {
    return { count: await this.tickets.countOpenForAdmin() };
  }

  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<SupportTicketDto> {
    return this.tickets.detailForAdmin(id);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  async addMessage(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AddTicketMessageDto,
    @Req() req: Request,
  ): Promise<SupportTicketMessageDto> {
    return this.tickets.addMessageAsAdmin({
      superAdminId: admin.sub,
      ticketId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  async transition(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: TransitionTicketDto,
    @Req() req: Request,
  ): Promise<SupportTicketDto> {
    return this.tickets.transition({
      superAdminId: admin.sub,
      ticketId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  async assign(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: AssignTicketDto,
    @Req() req: Request,
  ): Promise<SupportTicketDto> {
    return this.tickets.assign({
      superAdminId: admin.sub,
      ticketId: id,
      input,
      meta: extractMeta(req),
    });
  }
}
