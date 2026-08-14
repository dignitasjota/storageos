import { Controller, Get, Param, VERSION_NEUTRAL } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';

import { MarketingChannelsService } from './marketing-channels.service';

import type { MarketingShortLinkResolveDto } from '@storageos/shared';

/**
 * Enlace corto público de campaña (`/g/<code>`, impreso en carteles/flyers).
 * `VERSION_NEUTRAL` para una URL estable — se imprime en papel, no puede
 * cambiar con las versiones de la API.
 */
@Public()
@Controller({ path: 'public/marketing', version: VERSION_NEUTRAL })
export class MarketingPublicController {
  constructor(private readonly channels: MarketingChannelsService) {}

  @Get('go/:shortCode')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  resolve(@Param('shortCode') shortCode: string): Promise<MarketingShortLinkResolveDto> {
    return this.channels.resolveShortLink(shortCode);
  }
}
