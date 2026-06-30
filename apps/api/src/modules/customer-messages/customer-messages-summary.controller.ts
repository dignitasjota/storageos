import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerMessagesService } from './customer-messages.service';

import type { CustomerUnreadSummaryDto } from '@storageos/shared';

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
    return this.messages.unreadSummary(user.tenantId);
  }
}
