import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  type HoldedReviewItemDto,
  ResolveHoldedReviewSchema,
  type HoldedSeriesListDto,
  type HoldedSettingsDto,
  type HoldedTestResultDto,
  UpdateHoldedSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { HoldedSettingsService } from './holded-settings.service';
import { HoldedSyncService } from './holded-sync.service';

class UpdateHoldedSettingsBody extends createZodDto(UpdateHoldedSettingsSchema) {}
class ResolveHoldedReviewBody extends createZodDto(ResolveHoldedReviewSchema) {}

@Controller('settings/holded')
export class HoldedController {
  constructor(
    private readonly settings: HoldedSettingsService,
    private readonly sync: HoldedSyncService,
  ) {}

  @RequirePermission('settings:read')
  @Get()
  async get(@CurrentUser() user: AuthenticatedUser): Promise<HoldedSettingsDto> {
    const [dto, reviewCount] = await Promise.all([
      this.settings.get(user.tenantId),
      this.sync.reviewCount(user.tenantId),
    ]);
    return { ...dto, reviewCount };
  }

  @RequirePermission('billing:configure')
  @Put()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateHoldedSettingsBody,
  ): Promise<HoldedSettingsDto> {
    const dto = await this.settings.update(user.tenantId, body);
    return { ...dto, reviewCount: await this.sync.reviewCount(user.tenantId) };
  }

  /** Series de facturas y rectificativas de la cuenta de Holded (para elegirlas). */
  @RequirePermission('billing:configure')
  @Get('series')
  series(@CurrentUser() user: AuthenticatedUser): Promise<HoldedSeriesListDto> {
    return this.settings.listSeries(user.tenantId);
  }

  @RequirePermission('invoices:manage')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@CurrentUser() user: AuthenticatedUser): Promise<HoldedTestResultDto> {
    return this.settings.test(user.tenantId);
  }

  @RequirePermission('invoices:manage')
  @Post('backfill')
  backfill(@CurrentUser() user: AuthenticatedUser): Promise<{ synced: number }> {
    return this.sync.backfill(user.tenantId);
  }

  @RequirePermission('invoices:manage')
  @Post('invoices/:id/sync')
  @HttpCode(HttpStatus.OK)
  async syncInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.sync.pushInvoice(user.tenantId, id, true);
    return { ok: true };
  }

  /** Copias sin confirmar y cobros devueltos que hay que mirar en Holded. */
  @RequirePermission('invoices:manage')
  @Get('review')
  review(@CurrentUser() user: AuthenticatedUser): Promise<HoldedReviewItemDto[]> {
    return this.sync.listReview(user.tenantId);
  }

  @RequirePermission('invoices:manage')
  @Post('review/invoices/:id')
  @HttpCode(HttpStatus.OK)
  async resolveInvoiceReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveHoldedReviewBody,
  ): Promise<{ ok: true }> {
    await this.sync.resolveInvoiceReview(user.tenantId, id, body);
    return { ok: true };
  }

  @RequirePermission('invoices:manage')
  @Post('review/payments/:id')
  @HttpCode(HttpStatus.OK)
  async resolvePaymentReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveHoldedReviewBody,
  ): Promise<{ ok: true }> {
    await this.sync.resolvePaymentReview(user.tenantId, id, body);
    return { ok: true };
  }
}
