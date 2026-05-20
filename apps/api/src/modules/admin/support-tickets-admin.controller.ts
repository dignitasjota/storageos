import {
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
  AssignTicketSchema,
  type SupportTicketDto,
  type SupportTicketMessageDto,
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
  ): Promise<SupportTicketDto[]> {
    const parsedStatus =
      status && SupportTicketStatusEnum.safeParse(status).success
        ? (status as SupportTicketStatusValue)
        : undefined;
    return this.tickets.listForAdmin({
      ...(search ? { search } : {}),
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(assignedAdminId !== undefined ? { assignedAdminId } : {}),
    });
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
