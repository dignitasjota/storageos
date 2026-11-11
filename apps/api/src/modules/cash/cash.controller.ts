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
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import {
  CloseCashSchema,
  CreateCashMovementSchema,
  ReopenCashClosureSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CashClosurePdfService } from './cash-closure-pdf.service';
import { CashService } from './cash.service';

import type { RequestMeta } from '../auth/auth.service';
import type { CashClosureDto, CashDaySummaryDto, CashMovementDto } from '@storageos/shared';
import type { Request } from 'express';

class CloseCashDto extends createZodDto(CloseCashSchema) {}
class ReopenCashClosureDto extends createZodDto(ReopenCashClosureSchema) {}
class CreateCashMovementDto extends createZodDto(CreateCashMovementSchema) {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('cash')
export class CashController {
  constructor(
    private readonly cash: CashService,
    private readonly pdf: CashClosurePdfService,
  ) {}

  /** Resumen de cobros del día por método (arqueo). Por defecto, hoy en la zona del negocio. */
  @RequirePermission('payments:read')
  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') date?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<CashDaySummaryDto> {
    if (facilityId && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.cash.getDaySummary(
      user.tenantId,
      date || undefined,
      facilityId || null,
      user.facilityScope ?? null,
    );
  }

  /** Cierres: los 90 últimos o los de un mes (`month`), de todas las cajas o de una. */
  @RequirePermission('payments:read')
  @Get('closures')
  closures(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<CashClosureDto[]> {
    if (facilityId && facilityId !== 'global' && !UUID_RE.test(facilityId)) {
      throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
    }
    return this.cash.listClosures(user.tenantId, user.facilityScope ?? null, {
      ...(month ? { month } : {}),
      ...(facilityId ? { facilityId } : {}),
    });
  }

  /** El cierre en PDF, para imprimirlo y firmarlo. */
  @RequirePermission('payments:read')
  @Get('closures/:id/pdf')
  async closurePdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const { pdf, filename } = await this.pdf.render(user.tenantId, id, user.facilityScope ?? null);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /** Fondo de apertura, entrada de cambio o retirada al banco. */
  @RequirePermission('payments:charge')
  @Post('movements')
  addMovement(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCashMovementDto,
    @Req() req: Request,
  ): Promise<CashMovementDto> {
    return this.cash.addMovement({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('payments:charge')
  @Delete('movements/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMovement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.cash.deleteMovement({
      tenantId: user.tenantId,
      userId: user.sub,
      movementId: id,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  /** Cierra la caja del día (arqueo): registra el efectivo contado + diferencia. */
  @RequirePermission('payments:charge')
  @Post('close')
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CloseCashDto,
    @Req() req: Request,
  ): Promise<CashClosureDto> {
    return this.cash.closeDay({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  /** Reabre un cierre (con motivo) para registrar un movimiento de ese día. */
  @RequirePermission('invoices:manage')
  @Post('closures/:id/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReopenCashClosureDto,
    @Req() req: Request,
  ): Promise<CashClosureDto> {
    return this.cash.reopen({
      tenantId: user.tenantId,
      userId: user.sub,
      closureId: id,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }
}
