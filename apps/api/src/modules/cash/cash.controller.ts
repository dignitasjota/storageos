import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { CloseCashSchema } from '@storageos/shared';
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

  /** Resumen de cobros del día por método (arqueo). Default: hoy. */
  @RequirePermission('payments:read')
  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') date?: string,
  ): Promise<CashDaySummaryDto> {
    const day =
      date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    return this.cash.getDaySummary(user.tenantId, day);
  }

  @RequirePermission('payments:read')
  @Get('closures')
  closures(@CurrentUser() user: AuthenticatedUser): Promise<CashClosureDto[]> {
    return this.cash.listClosures(user.tenantId);
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
      meta: extractMeta(req),
    });
  }
}
