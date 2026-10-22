import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerMessagesService } from './customer-messages.service';

import type { CustomerConversationDto, CustomerUnreadSummaryDto } from '@storageos/shared';

/**
 * Resumen de mensajes sin leer del inquilino (a nivel tenant, sin `customerId`):
 * alimenta los badges del menú «Inquilinos», la lista de clientes y la pestaña
 * «Mensajes» de la ficha.
 */
@Controller('customer-messages')
export class CustomerMessagesSummaryController {
  constructor(private readonly messages: CustomerMessagesService) {}

  @RequirePermission('customers:read')
  @Get('unread-summary')
  async unreadSummary(@CurrentUser() user: AuthenticatedUser): Promise<CustomerUnreadSummaryDto> {
    return this.messages.unreadSummary(user.tenantId, user.sub);
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
    let facilities: string[] | null = scope;
    if (facilityId) {
      // Un usuario con locales asignados solo puede filtrar por los suyos.
      facilities = scope && !scope.includes(facilityId) ? [] : [facilityId];
    }
    return this.messages.conversations(user.tenantId, user.sub, facilities);
  }
}
