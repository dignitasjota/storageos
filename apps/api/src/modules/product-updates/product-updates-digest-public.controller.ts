import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';

import { ProductUpdatesDigestService } from './product-updates-digest.service';

import type { ProductUpdatesDigestUnsubscribeDto } from '@storageos/shared';

/**
 * Baja del resumen mensual de novedades desde el enlace del correo (sin
 * sesión): `GET` para la página de confirmación y `POST` para darse de baja
 * (también el «Cancelar suscripción» del cliente de correo, RFC 8058).
 */
@Public()
@Controller('public/product-updates-digest/unsubscribe')
export class ProductUpdatesDigestPublicController {
  constructor(private readonly digest: ProductUpdatesDigestService) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  info(@Param('token') token: string): Promise<ProductUpdatesDigestUnsubscribeDto> {
    return this.digest.unsubscribeInfo(token);
  }

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  unsubscribe(@Param('token') token: string): Promise<ProductUpdatesDigestUnsubscribeDto> {
    return this.digest.unsubscribe(token);
  }
}
