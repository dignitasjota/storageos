import {
  BadRequestException,
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

import { AdPerformanceService } from './ad-platforms/ad-performance.service';
import { AdSpendSyncService } from './ad-platforms/ad-spend-sync.service';
import { MarketingChannelsService } from './marketing-channels.service';
import { marketingViewer } from './marketing-viewer';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  AdPerformanceDto,
  MarketingChannelDto,
  MarketingPerformanceDto,
  MarketingUnassignedSourceDto,
  SyncAdSpendResultDto,
} from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CreateMarketingChannelDto extends createZodDto(CreateMarketingChannelSchema) {}
class UpdateMarketingChannelDto extends createZodDto(UpdateMarketingChannelSchema) {}
class SyncAdSpendDto extends createZodDto(SyncAdSpendSchema) {}

@Controller('marketing/channels')
export class MarketingController {
  constructor(
    private readonly channels: MarketingChannelsService,
    private readonly adSpendSync: AdSpendSyncService,
    private readonly adPerformance: AdPerformanceService,
  ) {}

  @RequirePermission('marketing:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<MarketingChannelDto[]> {
    if (facilityId && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.channels.list(user.tenantId, status, marketingViewer(user), facilityId || null);
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
    @Query('model') model?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<MarketingPerformanceDto> {
    if (model && model !== 'first' && model !== 'last') {
      throw new BadRequestException({ code: 'invalid_model', message: 'Modelo no válido' });
    }
    if (facilityId && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.channels.getPerformance(
      user.tenantId,
      {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(model ? { model: model as 'first' | 'last' } : {}),
        ...(facilityId ? { facilityId } : {}),
      },
      marketingViewer(user),
    );
  }

  /** Orígenes con visitas o contactos que no recoge ningún canal (antes de `:id`). */
  @RequirePermission('marketing:read')
  @Get('unassigned-sources')
  unassignedSources(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<MarketingUnassignedSourceDto[]> {
    return this.channels.unassignedSources(
      user.tenantId,
      Number(days) || 90,
      marketingViewer(user),
    );
  }

  /** Rendimiento de las campañas de Google Ads y Meta Ads (antes de `:id`). */
  @RequirePermission('marketing:read')
  @Get('ads-performance')
  adsPerformance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AdPerformanceDto> {
    return this.adPerformance.report(
      user.tenantId,
      { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      marketingViewer(user),
    );
  }

  @RequirePermission('marketing:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateMarketingChannelDto,
  ): Promise<MarketingChannelDto> {
    return this.channels.create(user.tenantId, body, marketingViewer(user));
  }

  @RequirePermission('marketing:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateMarketingChannelDto,
  ): Promise<MarketingChannelDto> {
    return this.channels.update(user.tenantId, id, body, marketingViewer(user));
  }

  @RequirePermission('marketing:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.channels.remove(user.tenantId, id, marketingViewer(user));
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
    return this.adSpendSync.syncChannel(user.tenantId, id, body.from, body.to, {
      viewer: marketingViewer(user),
    });
  }
}
