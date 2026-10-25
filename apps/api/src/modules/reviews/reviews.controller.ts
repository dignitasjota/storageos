import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  PublishReviewSchema,
  RequestReviewSchema,
  type ReviewDto,
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
class PublishReviewDto extends createZodDto(PublishReviewSchema) {}

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

  /** Publica o retira la valoración como testimonio en la web pública. */
  @RequirePermission('reviews:write')
  @Patch(':id/web')
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PublishReviewDto,
  ): Promise<ReviewDto> {
    return this.reviews.setPublished(user.tenantId, id, body.published);
  }
}
