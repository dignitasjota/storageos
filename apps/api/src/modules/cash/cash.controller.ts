import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CloseCashSchema, ReopenCashClosureSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CashService } from './cash.service';

import type { RequestMeta } from '../auth/auth.service';
import type { CashClosureDto, CashDaySummaryDto } from '@storageos/shared';
import type { Request } from 'express';

class CloseCashDto extends createZodDto(CloseCashSchema) {}
class ReopenCashClosureDto extends createZodDto(ReopenCashClosureSchema) {}

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
  constructor(private readonly cash: CashService) {}

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

  @RequirePermission('payments:read')
  @Get('closures')
  closures(@CurrentUser() user: AuthenticatedUser): Promise<CashClosureDto[]> {
    return this.cash.listClosures(user.tenantId, user.facilityScope ?? null);
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
