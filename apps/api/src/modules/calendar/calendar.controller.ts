import { Controller, Get, Query } from '@nestjs/common';
import { permissionsForRole, type CalendarEventsDto } from '@storageos/shared';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { assertUuid } from '../../common/pagination';

import { CalendarService } from './calendar.service';

/** Calendario operativo del panel del tenant. */
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /**
   * Sin permiso propio: cada tipo de evento sale solo si se puede leer su
   * módulo (tareas, contratos, reservas, vencimientos).
   */
  @Get()
  async events(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<CalendarEventsDto> {
    assertUuid(facilityId);
    return {
      events: await this.calendar.getEvents(user.tenantId, from, to, {
        ...(facilityId ? { facilityId } : {}),
        facilityScope: user.facilityScope ?? null,
        permissions: user.permissions ?? permissionsForRole(user.role),
      }),
    };
  }
}
