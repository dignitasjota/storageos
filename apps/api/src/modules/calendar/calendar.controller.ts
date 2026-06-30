import { Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { CalendarService } from './calendar.service';

import type { CalendarEventsDto } from '@storageos/shared';

/** Calendario operativo del panel del tenant. */
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  async events(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<CalendarEventsDto> {
    return { events: await this.calendar.getEvents(user.tenantId, from, to) };
  }
}
