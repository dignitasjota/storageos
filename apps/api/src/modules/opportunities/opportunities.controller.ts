import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  OpportunityKindEnum,
  ProposeOpportunitySchema,
  type OpportunitiesDto,
  type OpportunityDraftDto,
  type ProposeOpportunityResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { OpportunitiesService } from './opportunities.service';

class ProposeOpportunityDto extends createZodDto(ProposeOpportunitySchema) {}

/** Qué ofrecer a cada inquilino, la propuesta redactada y su envío. */
@Controller('opportunities')
export class OpportunitiesController {
  constructor(private readonly service: OpportunitiesService) {}

  @Get()
  @RequirePermission('customers:read')
  list(@CurrentUser() user: AuthenticatedUser): Promise<OpportunitiesDto> {
    return this.service.list(user.tenantId, user.facilityScope ?? null);
  }

  @Get('draft')
  @RequirePermission('customers:read')
  draft(
    @CurrentUser() user: AuthenticatedUser,
    @Query('customerId') customerId: string,
    @Query('kind') kind: string,
  ): Promise<OpportunityDraftDto> {
    return this.service.draft(
      user.tenantId,
      customerId,
      OpportunityKindEnum.parse(kind),
      user.facilityScope ?? null,
    );
  }

  @Post('propose')
  @RequirePermission('communications:send')
  propose(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ProposeOpportunityDto,
  ): Promise<ProposeOpportunityResultDto> {
    return this.service.propose(user.tenantId, user.sub, body, user.facilityScope ?? null);
  }
}
