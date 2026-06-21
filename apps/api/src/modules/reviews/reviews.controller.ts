import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  RequestReviewSchema,
  ReviewListQuerySchema,
  type ReviewListDto,
  type ReviewStatsDto,
  type RequestReviewResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ReviewsService } from './reviews.service';

class RequestReviewDto extends createZodDto(RequestReviewSchema) {}
class ReviewListQueryDto extends createZodDto(ReviewListQuerySchema) {}

/** Endpoints de staff para las valoraciones (NPS) del tenant. */
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @RequirePermission('reviews:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ReviewListQueryDto,
  ): Promise<ReviewListDto> {
    return this.reviews.list(user.tenantId, query);
  }

  @RequirePermission('reviews:read')
  @Get('stats')
  stats(@CurrentUser() user: AuthenticatedUser): Promise<ReviewStatsDto> {
    return this.reviews.stats(user.tenantId);
  }

  @RequirePermission('reviews:write')
  @Post('request')
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RequestReviewDto,
  ): Promise<RequestReviewResultDto> {
    return this.reviews.request({ tenantId: user.tenantId, input: body });
  }
}
