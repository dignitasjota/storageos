import { Controller, Get, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';

import { CampaignInsightsService } from './campaign-insights.service';

import type { Env } from '../../config/env.schema';
import type { Response } from 'express';

/**
 * Enlace con seguimiento de una campaña: cuenta el clic y redirige al enlace
 * original. Un token inválido lleva a la web de la plataforma.
 */
@Public()
@Controller('public/campaign-click')
export class CampaignClickPublicController {
  constructor(
    private readonly insights: CampaignInsightsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async click(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const url = await this.insights.recordClick(token).catch(() => null);
    res.redirect(302, url ?? this.config.get('WEB_BASE_URL', { infer: true }));
  }
}
