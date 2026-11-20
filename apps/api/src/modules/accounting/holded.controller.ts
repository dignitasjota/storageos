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
  Req,
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
import { AuditService } from '../auth/audit.service';

import { HoldedSettingsService } from './holded-settings.service';
import { HoldedSyncService } from './holded-sync.service';

import type { Request } from 'express';

class UpdateHoldedSettingsBody extends createZodDto(UpdateHoldedSettingsSchema) {}
class ResolveHoldedReviewBody extends createZodDto(ResolveHoldedReviewSchema) {}

@Controller('settings/holded')
export class HoldedController {
  constructor(
    private readonly settings: HoldedSettingsService,
    private readonly sync: HoldedSyncService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('settings:read')
  @Get()
  async get(@CurrentUser() user: AuthenticatedUser): Promise<HoldedSettingsDto> {
    const [dto, reviewCount, pendingCount] = await Promise.all([
      this.settings.get(user.tenantId),
      this.sync.reviewCount(user.tenantId),
      this.sync.pendingCount(user.tenantId),
    ]);
    return { ...dto, reviewCount, pendingCount };
  }

  @RequirePermission('billing:configure')
  @Put()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateHoldedSettingsBody,
    @Req() req: Request,
  ): Promise<HoldedSettingsDto> {
    const dto = await this.settings.update(user.tenantId, body);
    // Lo que se ha cambiado, sin la clave (solo si se ha cambiado).
    const { apiKey, ...rest } = body;
    await this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action: 'holded.settings_changed',
      entityType: 'HoldedSettings',
      entityId: user.tenantId,
      changes: { ...rest, ...(apiKey ? { apiKeyChanged: true } : {}) },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    const [reviewCount, pendingCount] = await Promise.all([
      this.sync.reviewCount(user.tenantId),
      this.sync.pendingCount(user.tenantId),
    ]);
    return { ...dto, reviewCount, pendingCount };
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
  backfill(@CurrentUser() user: AuthenticatedUser): Promise<{ synced: number; remaining: number }> {
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
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.sync.resolveInvoiceReview(user.tenantId, id, body);
    await this.auditReview(user, req, 'Invoice', id, body);
    return { ok: true };
  }

  @RequirePermission('invoices:manage')
  @Post('review/payments/:id')
  @HttpCode(HttpStatus.OK)
  async resolvePaymentReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveHoldedReviewBody,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.sync.resolvePaymentReview(user.tenantId, id, body);
    await this.auditReview(user, req, 'Payment', id, body);
    return { ok: true };
  }

  /** Quién dio por resuelto algo «para revisar» y cómo. */
  private async auditReview(
    user: AuthenticatedUser,
    req: Request,
    entityType: 'Invoice' | 'Payment',
    entityId: string,
    body: ResolveHoldedReviewBody,
  ): Promise<void> {
    await this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action: 'holded.review_resolved',
      entityType,
      entityId,
      changes: {
        action: body.action,
        ...(body.holdedDocumentId ? { holdedDocumentId: body.holdedDocumentId } : {}),
      },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }
}
