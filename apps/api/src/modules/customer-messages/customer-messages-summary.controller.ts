import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  BroadcastMessageSchema,
  ConversationStatusEnum,
  InboxChannelEnum,
  UpdateMessageSettingsSchema,
  UpsertCannedResponseSchema,
  type ConversationStatsDto,
  type CustomerCannedResponseDto,
  type InboxPageDto,
  type MessageSettingsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerConversationsService } from './customer-conversations.service';
import { CustomerMessagesService } from './customer-messages.service';

import type { CustomerConversationDto, CustomerUnreadSummaryDto } from '@storageos/shared';

class UpsertCannedResponseDto extends createZodDto(UpsertCannedResponseSchema) {}
class UpdateMessageSettingsDto extends createZodDto(UpdateMessageSettingsSchema) {}
class BroadcastMessageDto extends createZodDto(BroadcastMessageSchema) {}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Resumen de mensajes sin leer del inquilino (a nivel tenant, sin `customerId`):
 * alimenta los badges del menú «Inquilinos», la lista de clientes y la pestaña
 * «Mensajes» de la ficha.
 */
@Controller('customer-messages')
export class CustomerMessagesSummaryController {
  constructor(
    private readonly messages: CustomerMessagesService,
    private readonly threads: CustomerConversationsService,
  ) {}

  @RequirePermission('customers:read')
  @Get('unread-summary')
  async unreadSummary(@CurrentUser() user: AuthenticatedUser): Promise<CustomerUnreadSummaryDto> {
    return this.messages.unreadSummary(user.tenantId, user.sub, user.facilityScope ?? null);
  }

  /** Bandeja «Mensajes»: conversaciones por último mensaje (`?facilityId=` opcional). */
  @RequirePermission('customers:read')
  @Get('conversations')
  async conversations(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<CustomerConversationDto[]> {
    if (facilityId && !/^[0-9a-f-]{36}$/i.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    const scope = user.facilityScope ?? null;
    // Un usuario con locales asignados solo puede filtrar por los suyos.
    if (facilityId && scope && !scope.includes(facilityId)) return [];
    return this.messages.conversations(user.tenantId, user.sub, scope, facilityId ?? null);
  }

  /** Bandeja completa: inquilinos, WhatsApp del negocio y chat de la web, por páginas. */
  @RequirePermission('customers:read')
  @Get('inbox')
  async inbox(
    @CurrentUser() user: AuthenticatedUser,
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('mine') mine?: string,
    @Query('search') search?: string,
    @Query('facilityId') facilityId?: string,
    @Query('cursor') cursor?: string,
  ): Promise<InboxPageDto> {
    const parsedChannel = InboxChannelEnum.safeParse(channel ?? 'all');
    const parsedStatus = status ? ConversationStatusEnum.safeParse(status) : null;
    const at = cursor ? new Date(cursor) : undefined;
    if (
      !parsedChannel.success ||
      (parsedStatus && !parsedStatus.success) ||
      (facilityId && !UUID.test(facilityId)) ||
      (at && Number.isNaN(at.getTime()))
    ) {
      throw new BadRequestException({ code: 'invalid_filter', message: 'Filtro no válido' });
    }
    const scope = user.facilityScope ?? null;
    if (facilityId && scope && !scope.includes(facilityId)) {
      return { items: [], nextCursor: null, counts: { pending: 0, mine: 0, unassigned: 0 } };
    }
    return this.threads.inbox(
      { tenantId: user.tenantId, userId: user.sub, scope, permissions: user.permissions },
      {
        channel: parsedChannel.data,
        status: parsedStatus?.data,
        mine: mine === '1',
        search,
        facilityId,
        cursor: at,
      },
    );
  }

  /** Tiempos de respuesta del equipo. */
  @RequirePermission('customers:read')
  @Get('stats')
  stats(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<ConversationStatsDto> {
    const n = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.threads.stats(user.tenantId, user.facilityScope ?? null, n);
  }

  /** El mismo mensaje a varios inquilinos, cada uno en su conversación. */
  @RequirePermission('customers:write')
  @Post('broadcast')
  @HttpCode(HttpStatus.OK)
  broadcast(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BroadcastMessageDto,
  ): Promise<{ sent: number; skipped: number }> {
    return this.threads.broadcast(user.tenantId, user.sub, user.facilityScope ?? null, body);
  }

  @RequirePermission('customers:read')
  @Get('canned')
  listCanned(@CurrentUser() user: AuthenticatedUser): Promise<CustomerCannedResponseDto[]> {
    return this.threads.listCanned(user.tenantId);
  }

  @RequirePermission('customers:write')
  @Post('canned')
  createCanned(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpsertCannedResponseDto,
  ): Promise<CustomerCannedResponseDto> {
    return this.threads.createCanned(user.tenantId, body);
  }

  @RequirePermission('customers:write')
  @Patch('canned/:id')
  updateCanned(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpsertCannedResponseDto,
  ): Promise<CustomerCannedResponseDto> {
    return this.threads.updateCanned(user.tenantId, id, body);
  }

  @RequirePermission('customers:write')
  @Delete('canned/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCanned(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.threads.deleteCanned(user.tenantId, id);
  }

  /** Horario de atención y respuesta automática. */
  @RequirePermission('settings:read')
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<MessageSettingsDto> {
    return this.threads.settings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateMessageSettingsDto,
  ): Promise<MessageSettingsDto> {
    return this.threads.updateSettings(user.tenantId, body);
  }
}
