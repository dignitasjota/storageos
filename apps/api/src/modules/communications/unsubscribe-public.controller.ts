import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';

import { UnsubscribeService } from './unsubscribe.service';

import type { UnsubscribeInfoDto } from '@storageos/shared';

/**
 * Baja de comunicaciones comerciales (sin sesión):
 * - `GET` para la página de confirmación;
 * - `POST` para darse de baja, tanto desde esa página como desde el botón
 *   «Cancelar suscripción» del cliente de correo (`List-Unsubscribe-Post`,
 *   RFC 8058), que hace POST directamente a esta URL.
 */
@Public()
@Controller('public/unsubscribe')
export class UnsubscribePublicController {
  constructor(private readonly service: UnsubscribeService) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  info(@Param('token') token: string): Promise<UnsubscribeInfoDto> {
    return this.service.info(token);
  }

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  unsubscribe(@Param('token') token: string): Promise<UnsubscribeInfoDto> {
    return this.service.unsubscribe(token);
  }
}
