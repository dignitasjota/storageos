import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RecordFeatureInterestSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { FeatureInterestService } from './feature-interest.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

class RecordFeatureInterestDto extends createZodDto(RecordFeatureInterestSchema) {}

/** El panel del tenant avisa de que un usuario entró en una función que no tiene. */
@Controller('feature-interest')
export class FeatureInterestController {
  constructor(private readonly service: FeatureInterestService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  record(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RecordFeatureInterestDto,
  ): Promise<{ recorded: boolean }> {
    return this.service.record({
      tenantId: user.tenantId,
      userId: user.sub,
      feature: body.feature,
      path: body.path,
    });
  }
}
