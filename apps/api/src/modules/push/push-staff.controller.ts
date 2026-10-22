import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  PushSubscribeSchema,
  PushUnsubscribeSchema,
  type StaffPushStatusDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { PushService } from './push.service';

class PushSubscribeDto extends createZodDto(PushSubscribeSchema) {}
class PushUnsubscribeDto extends createZodDto(PushUnsubscribeSchema) {}

/**
 * Push en el móvil del equipo (PWA del panel). Cada usuario lo activa en su
 * dispositivo; no hace falta permiso especial.
 */
@Controller('me/push')
export class PushStaffController {
  constructor(private readonly push: PushService) {}

  /** Clave pública y si este dispositivo (`endpoint`) ya lo tiene activado. */
  @Get()
  async status(
    @CurrentUser() user: AuthenticatedUser,
    @Query('endpoint') endpoint?: string,
  ): Promise<StaffPushStatusDto> {
    return {
      publicKey: this.push.getPublicKey(),
      subscribed: endpoint
        ? await this.push.isUserSubscribed(user.tenantId, user.sub, endpoint)
        : false,
    };
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PushSubscribeDto,
  ): Promise<void> {
    await this.push.subscribeUser(user.tenantId, user.sub, body);
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PushUnsubscribeDto,
  ): Promise<void> {
    await this.push.unsubscribeUser(user.tenantId, user.sub, body.endpoint);
  }
}
