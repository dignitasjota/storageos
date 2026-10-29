import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';

import { BusinessRemindersService } from './business-reminders.service';

import type { Response } from 'express';

/**
 * Calendario de los vencimientos (ICS) para suscribirse desde Google o Apple
 * Calendar. Sin sesión: el enlace lleva un token secreto que se puede cambiar.
 */
@Public()
@Controller('public/reminders-calendar')
export class BusinessRemindersCalendarController {
  constructor(private readonly reminders: BusinessRemindersService) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async feed(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const ics = await this.reminders.icsFeed(token.replace(/\.ics$/i, ''));
    if (!ics)
      throw new NotFoundException({ code: 'calendar_not_found', message: 'Enlace no válido' });
    res
      .status(200)
      .setHeader('Content-Type', 'text/calendar; charset=utf-8')
      .setHeader('Content-Disposition', 'inline; filename="vencimientos.ics"')
      .setHeader('Cache-Control', 'private, max-age=900')
      .send(ics);
  }
}
