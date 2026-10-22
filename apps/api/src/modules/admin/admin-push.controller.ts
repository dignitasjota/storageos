import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  PushSubscribeSchema,
  PushUnsubscribeSchema,
  type SuperAdminPushStatusDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { SuperAdminPushService } from '../push/super-admin-push.service';

import { AdminGuard } from './admin.guard';
import { CurrentSuperAdmin } from './current-super-admin.decorator';

class PushSubscribeDto extends createZodDto(PushSubscribeSchema) {}
class PushUnsubscribeDto extends createZodDto(PushUnsubscribeSchema) {}

/**
 * Avisos push del super admin en su dispositivo (panel admin instalado). Cada
 * super admin lo activa en el suyo; vale también para el rol soporte.
 */
@Public()
@Controller('admin/me/push')
@UseGuards(AdminGuard)
export class AdminPushController {
  constructor(private readonly push: SuperAdminPushService) {}

  /** Clave pública y si este dispositivo (`endpoint`) ya lo tiene activado. */
  @Get()
  async status(
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Query('endpoint') endpoint?: string,
  ): Promise<SuperAdminPushStatusDto> {
    return {
      publicKey: this.push.getPublicKey(),
      subscribed: endpoint ? await this.push.isSubscribed(superAdminId, endpoint) : false,
    };
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async subscribe(
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: PushSubscribeDto,
  ): Promise<void> {
    await this.push.subscribe(superAdminId, body);
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(
    @CurrentSuperAdmin('sub') superAdminId: string,
    @Body() body: PushUnsubscribeDto,
  ): Promise<void> {
    await this.push.unsubscribe(superAdminId, body.endpoint);
  }
}
