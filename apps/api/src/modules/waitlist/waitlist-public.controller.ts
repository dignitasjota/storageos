import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicJoinWaitlistSchema, type PublicWaitlistOptionsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { WaitlistService } from './waitlist.service';

class PublicJoinWaitlistBody extends createZodDto(PublicJoinWaitlistSchema) {}

/**
 * Alta self-service en la lista de espera desde la web pública (sin sesión).
 * Resuelto por slug del tenant; throttle estricto por IP. Captura demanda que
 * hoy se pierde cuando un visitante no encuentra stock de su tamaño.
 */
@Public()
@Controller('public/waitlist')
export class WaitlistPublicController {
  constructor(private readonly waitlist: WaitlistService) {}

  /** Catálogo (locales + tipos + disponibilidad) para elegir a qué apuntarse. */
  @Get(':slug/options')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  options(@Param('slug') slug: string): Promise<PublicWaitlistOptionsDto> {
    return this.waitlist.publicOptions(slug);
  }

  /** Apunta un contacto a la cola de un (local, tipo). */
  @Post(':slug')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  join(
    @Param('slug') slug: string,
    @Body() body: PublicJoinWaitlistBody,
  ): Promise<{ joined: boolean }> {
    return this.waitlist.joinFromPublic(slug, body);
  }
}
