import { Controller, Get, Res } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { realtimeChannels, RealtimeService } from './realtime.service';

import type { Response } from 'express';

/** Canal en vivo del panel: mensajes de inquilinos y tickets del negocio. */
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Get('stream')
  async stream(@CurrentUser() user: AuthenticatedUser, @Res() res: Response): Promise<void> {
    const scope = user.facilityScope ?? null;
    await this.realtime.stream(res, [realtimeChannels.tenant(user.tenantId)], (event) => {
      const facilities = event.facilityIds ?? [];
      return !scope || facilities.length === 0 || facilities.some((f) => scope.includes(f));
    });
  }
}
