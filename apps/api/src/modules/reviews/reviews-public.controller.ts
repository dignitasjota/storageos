import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type PublicReviewContextDto, SubmitReviewSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { ReviewsService } from './reviews.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class SubmitReviewBody extends createZodDto(SubmitReviewSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/** Página pública de valoración (resuelta por token opaco). Sin auth. */
@Public()
@Controller('public/reviews')
export class ReviewsPublicController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  context(@Param('token') token: string): Promise<PublicReviewContextDto> {
    return this.reviews.getByToken(token);
  }

  @Post(':token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(
    @Param('token') token: string,
    @Body() body: SubmitReviewBody,
    @Req() req: Request,
  ): Promise<{ status: 'submitted' }> {
    return this.reviews.submitByToken(token, body, extractMeta(req));
  }
}
