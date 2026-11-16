import { Controller, Get, Param, VERSION_NEUTRAL, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { isInternalHttpRequest } from '../../common/http/internal-request';

import { MarketingChannelsService, type ShortLinkVisitor } from './marketing-channels.service';

import type { Env } from '../../config/env.schema';
import type { MarketingShortLinkResolveDto } from '@storageos/shared';
import type { Request } from 'express';

/**
 * Enlace corto público de campaña (`/g/<code>`, impreso en carteles/flyers).
 * `VERSION_NEUTRAL` para una URL estable — se imprime en papel, no puede
 * cambiar con las versiones de la API.
 */
@Public()
@Controller({ path: 'public/marketing', version: VERSION_NEUTRAL })
export class MarketingPublicController {
  constructor(
    private readonly channels: MarketingChannelsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * `count=0`: no contar el clic (el web lo manda en las peticiones HEAD).
   * Desde el servidor del web (con el token interno) el visitante llega en
   * `x-visitor-ip` / `x-visitor-ua`; si no, es quien hace la petición.
   */
  @Get('go/:shortCode')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  resolve(
    @Req() req: Request,
    @Param('shortCode') shortCode: string,
    @Query('tenant') tenant?: string,
    @Query('count') count?: string,
  ): Promise<MarketingShortLinkResolveDto> {
    const header = (name: string) => {
      const v = req.headers[name];
      return typeof v === 'string' && v ? v.slice(0, 500) : undefined;
    };
    const internal = isInternalHttpRequest(
      req,
      this.config.get('INTERNAL_API_TOKEN', { infer: true }),
    );
    const visitor: ShortLinkVisitor = internal
      ? { ip: header('x-visitor-ip'), userAgent: header('x-visitor-ua') }
      : { ip: req.ip, userAgent: header('user-agent') };
    visitor.count = count !== '0';
    return this.channels.resolveShortLink(shortCode, tenant || undefined, visitor);
  }
}
