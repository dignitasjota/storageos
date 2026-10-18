import { Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CalendarService } from './calendar.service';

import type { CalendarEventsDto } from '@storageos/shared';

/** Calendario operativo del panel del tenant. */
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @RequirePermission('tasks:read')
  @Get()
  async events(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<CalendarEventsDto> {
    return {
      events: await this.calendar.getEvents(user.tenantId, from, to, {
        ...(facilityId ? { facilityId } : {}),
        facilityScope: user.facilityScope ?? null,
      }),
    };
  }
}
