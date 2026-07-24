import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PublicContactSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { LandingService } from './landing.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  LeadDto,
  PublicFacilityLandingDto,
  PublicLandingDto,
  PublicSitemapDto,
  ResolveDomainDto,
} from '@storageos/shared';
import type { Request } from 'express';

class PublicContactDto extends createZodDto(PublicContactSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Endpoint público de la landing por tenant (`/s/[slug]`). Sin auth ni
 * versión (`VERSION_NEUTRAL`) para una URL estable; throttle por IP.
 */
@Public()
@Controller({ path: 'public/landing', version: VERSION_NEUTRAL })
export class LandingController {
  constructor(private readonly landing: LandingService) {}

  // `sitemap` y `resolve-domain` se declaran antes que `:slug` para que el
  // param no los capture.
  @Get('sitemap')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  sitemap(): Promise<PublicSitemapDto> {
    return this.landing.sitemap();
  }

  /** Resolución dominio propio → tenant, que consume el middleware del web. */
  @Get('resolve-domain')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  resolveDomain(@Query('host') host: string): Promise<ResolveDomainDto> {
    return this.landing.resolveDomain(host ?? '');
  }

  @Get(':slug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  get(@Param('slug') slug: string): Promise<PublicLandingDto> {
    return this.landing.getBySlug(slug);
  }

  /** Formulario de contacto de la web pública → crea un lead (source `web`). */
  @Post(':slug/contact')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  contact(
    @Param('slug') slug: string,
    @Body() body: PublicContactDto,
    @Req() req: Request,
  ): Promise<LeadDto> {
    return this.landing.submitContact(slug, body, extractMeta(req));
  }

  @Get(':slug/:facilitySlug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  facility(
    @Param('slug') slug: string,
    @Param('facilitySlug') facilitySlug: string,
  ): Promise<PublicFacilityLandingDto> {
    return this.landing.getFacilityBySlug(slug, facilitySlug);
  }
}
