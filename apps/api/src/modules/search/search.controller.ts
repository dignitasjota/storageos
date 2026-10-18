import { Controller, Get, Query } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { SearchService } from './search.service';

import type { SearchResultsDto } from '@storageos/shared';

/** Búsqueda global del panel del tenant. */
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @RequirePermission('customers:read')
  @Get()
  async query(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
  ): Promise<SearchResultsDto> {
    return {
      results: await this.search.search(user.tenantId, q ?? '', user.facilityScope ?? null),
    };
  }
}
