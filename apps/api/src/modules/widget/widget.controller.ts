import { Body, Controller, Get, Param, Post, Req, VERSION_NEUTRAL } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WidgetLeadSchema, type WidgetFacilityDto, type LeadDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { WidgetService } from './widget.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class WidgetLeadDto extends createZodDto(WidgetLeadSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Endpoints publicos del widget embebible. Sin auth. Throttle estricto
 * por IP para frenar enumeracion / spam.
 */
// El widget se embebe en sitios externos del cliente final con la URL
// `/public/widget/:slug/...`. Esos embeds ya estan desplegados en sitios
// que no controlamos: lo mantenemos VERSION_NEUTRAL para no romper compat.
@Public()
@Controller({ path: 'public/widget', version: VERSION_NEUTRAL })
export class WidgetController {
  constructor(private readonly service: WidgetService) {}

  @Get(':slug/facilities')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  listFacilities(@Param('slug') slug: string): Promise<WidgetFacilityDto[]> {
    return this.service.listFacilities(slug);
  }

  @Post(':slug/leads')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  submitLead(
    @Param('slug') slug: string,
    @Body() body: WidgetLeadDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.service.submitLead({
      slug,
      input: body,
      meta: extractMeta(req),
    });
  }
}
