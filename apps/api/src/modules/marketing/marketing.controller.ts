import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateMarketingChannelSchema,
  SyncAdSpendSchema,
  UpdateMarketingChannelSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AdSpendSyncService } from './ad-platforms/ad-spend-sync.service';
import { MarketingChannelsService } from './marketing-channels.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  MarketingChannelDto,
  MarketingPerformanceDto,
  SyncAdSpendResultDto,
} from '@storageos/shared';

class CreateMarketingChannelDto extends createZodDto(CreateMarketingChannelSchema) {}
class UpdateMarketingChannelDto extends createZodDto(UpdateMarketingChannelSchema) {}
class SyncAdSpendDto extends createZodDto(SyncAdSpendSchema) {}

@Controller('marketing/channels')
export class MarketingController {
  constructor(
    private readonly channels: MarketingChannelsService,
    private readonly adSpendSync: AdSpendSyncService,
  ) {}

  @RequirePermission('marketing:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
  ): Promise<MarketingChannelDto[]> {
    return this.channels.list(user.tenantId, status);
  }

  /**
   * Rendimiento por canal: coste ↔ leads ↔ conversión ↔ MRR. Declarado antes
   * de `:id` para que ese param dinámico no capture «performance».
   */
  @RequirePermission('marketing:read')
  @Get('performance')
  performance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<MarketingPerformanceDto> {
    return this.channels.getPerformance(user.tenantId, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  @RequirePermission('marketing:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateMarketingChannelDto,
  ): Promise<MarketingChannelDto> {
    return this.channels.create(user.tenantId, body);
  }

  @RequirePermission('marketing:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateMarketingChannelDto,
  ): Promise<MarketingChannelDto> {
    return this.channels.update(user.tenantId, id, body);
  }

  @RequirePermission('marketing:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.channels.remove(user.tenantId, id);
  }

  /** Sincroniza a mano el gasto (Google Ads/Meta Ads) de un canal vinculado a una campaña externa. */
  @RequirePermission('marketing:manage')
  @Post(':id/sync-ad-spend')
  @HttpCode(HttpStatus.OK)
  syncAdSpend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SyncAdSpendDto,
  ): Promise<SyncAdSpendResultDto> {
    return this.adSpendSync.syncChannel(user.tenantId, id, body.from, body.to);
  }
}
