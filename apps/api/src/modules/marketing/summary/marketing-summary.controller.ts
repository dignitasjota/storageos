import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, Req } from '@nestjs/common';
import { UpdateMarketingReportSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { marketingViewer } from '../marketing-viewer';

import { MarketingSummaryService } from './marketing-summary.service';

import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { MarketingSummaryDto } from '@storageos/shared';
import type { Request } from 'express';

class UpdateMarketingReportDto extends createZodDto(UpdateMarketingReportSchema) {}

/** Marketing → Resumen y el correo mensual «Tu marketing en <mes>». */
@Controller('marketing/summary')
export class MarketingSummaryController {
  constructor(private readonly summary: MarketingSummaryService) {}

  @RequirePermission('marketing:read')
  @Get()
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ): Promise<MarketingSummaryDto> {
    return this.summary.build(user.tenantId, month || undefined, marketingViewer(user));
  }

  @RequirePermission('marketing:manage')
  @Put('report')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setReport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateMarketingReportDto,
  ): Promise<void> {
    await this.summary.setReportEnabled(user.tenantId, body.enabled);
  }

  /** Envía ya el correo del mes pasado a los propietarios. */
  @RequirePermission('marketing:manage')
  @Post('report/send')
  @HttpCode(HttpStatus.OK)
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ recipients: number; month: string }> {
    return this.summary.send(user.tenantId, {
      userId: user.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
