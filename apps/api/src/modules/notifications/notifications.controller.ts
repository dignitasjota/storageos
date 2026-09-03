import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { NotificationsService } from './notifications.service';

import type { NotificationListDto } from '@storageos/shared';

// Ningún método tenía `@RequirePermission` (ni de clase): cualquier usuario
// autenticado del tenant podía leer/marcar la bandeja sin que el guard
// exigiera nada más que la sesión. `notifications:read` va en TODOS los
// roles base (no cambia el acceso de nadie hoy), pero hace el permiso
// exigible para un rol personalizado que no lo incluya — mismo criterio ya
// aplicado a `AnalyticsController`.
@RequirePermission('notifications:read')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<NotificationListDto> {
    return this.notifications.list(user.tenantId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.notifications.markRead(user.tenantId, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.notifications.markAllRead(user.tenantId);
  }
}
