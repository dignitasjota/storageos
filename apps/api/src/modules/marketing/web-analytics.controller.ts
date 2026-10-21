import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WebEventSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { WebAnalyticsService } from './web-analytics.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { WebAnalyticsDto } from '@storageos/shared';

class WebEventDto extends createZodDto(WebEventSchema) {}

/** Página vista o clic de contacto en la web pública del tenant. */
@Public()
@Controller({ path: 'public/landing', version: VERSION_NEUTRAL })
export class WebAnalyticsPublicController {
  constructor(private readonly analytics: WebAnalyticsService) {}

  @Post(':slug/events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async event(
    @Param('slug') slug: string,
    @Body() body: WebEventDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.analytics.record(slug, body, userAgent);
  }
}

/** Informe de visitas y orígenes de la web (Marketing → Visitas de la web). */
@Controller('marketing/web-analytics')
export class WebAnalyticsController {
  constructor(private readonly analytics: WebAnalyticsService) {}

  @RequirePermission('marketing:read')
  @Get()
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<WebAnalyticsDto> {
    return this.analytics.report(user.tenantId, Number(days) || 30);
  }
}
