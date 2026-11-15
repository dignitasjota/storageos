import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  DismissOpportunitySchema,
  OpportunityKindEnum,
  ProposeBulkSchema,
  ProposeOpportunitySchema,
  type OpportunitiesDto,
  type OpportunityDismissalDto,
  type OpportunityDraftDto,
  type OpportunityInterestedCountDto,
  type OpportunityKind,
  type OpportunityResultsDto,
  type ProposeBulkResultDto,
  type ProposeOpportunityResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerOffersService } from './customer-offers.service';
import { OpportunitiesService } from './opportunities.service';

class ProposeOpportunityDto extends createZodDto(ProposeOpportunitySchema) {}
class ProposeBulkDto extends createZodDto(ProposeBulkSchema) {}
class DismissOpportunityDto extends createZodDto(DismissOpportunitySchema) {}

function parseKind(kind: string | undefined): OpportunityKind {
  const r = OpportunityKindEnum.safeParse(kind);
  if (!r.success) {
    throw new BadRequestException({
      code: 'invalid_kind',
      message: 'Tipo de oportunidad no válido',
    });
  }
  return r.data;
}

/** Qué ofrecer a cada inquilino, la propuesta redactada y su envío. */
@Controller('opportunities')
export class OpportunitiesController {
  constructor(
    private readonly service: OpportunitiesService,
    private readonly offers: CustomerOffersService,
  ) {}

  @Get()
  @RequirePermission('customers:read')
  list(@CurrentUser() user: AuthenticatedUser): Promise<OpportunitiesDto> {
    return this.service.list(user.tenantId, user.facilityScope ?? null);
  }

  /** Inquilinos que han dicho «me interesa» (número del menú). */
  @Get('interested-count')
  @RequirePermission('customers:read')
  async interestedCount(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OpportunityInterestedCountDto> {
    return {
      interested: await this.offers.interestedCount(user.tenantId, user.facilityScope ?? null),
    };
  }

  /** Qué ha pasado con lo propuesto en los últimos días. */
  @Get('results')
  @RequirePermission('customers:read')
  results(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<OpportunityResultsDto> {
    const n = Number(days ?? 90);
    const d = Number.isInteger(n) && n >= 1 && n <= 730 ? n : 90;
    return this.offers.results(user.tenantId, d, user.facilityScope ?? null);
  }

  @Get('dismissed')
  @RequirePermission('customers:read')
  dismissed(@CurrentUser() user: AuthenticatedUser): Promise<OpportunityDismissalDto[]> {
    return this.service.listDismissed(user.tenantId, user.facilityScope ?? null);
  }

  @Get('draft')
  @RequirePermission('customers:read')
  draft(
    @CurrentUser() user: AuthenticatedUser,
    @Query('customerId', new ParseUUIDPipe()) customerId: string,
    @Query('kind') kind: string,
  ): Promise<OpportunityDraftDto> {
    return this.service.draft(
      user.tenantId,
      customerId,
      parseKind(kind),
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

  @Post('propose-bulk')
  @RequirePermission('communications:send')
  proposeBulk(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ProposeBulkDto,
  ): Promise<ProposeBulkResultDto> {
    return this.service.proposeBulk(user.tenantId, user.sub, body, user.facilityScope ?? null);
  }

  @Post('dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('customers:write')
  dismiss(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DismissOpportunityDto,
  ): Promise<void> {
    return this.service.dismiss(user.tenantId, user.sub, body, user.facilityScope ?? null);
  }

  @Delete('dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('customers:write')
  undismiss(
    @CurrentUser() user: AuthenticatedUser,
    @Query('customerId', new ParseUUIDPipe()) customerId: string,
    @Query('kind') kind: string,
  ): Promise<void> {
    return this.service.undismiss(
      user.tenantId,
      customerId,
      parseKind(kind),
      user.facilityScope ?? null,
    );
  }
}
