import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req } from '@nestjs/common';
import {
  type AnniversarySettingsDto,
  type AnniversaryUpdateDto,
  ApplyAnniversaryUpdatesSchema,
  type ApplyAnniversaryUpdatesResultDto,
  UpdateAnniversarySettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AnniversaryUpdatesService } from './anniversary-updates.service';

import type { Request } from 'express';

class UpdateSettingsDto extends createZodDto(UpdateAnniversarySettingsSchema) {}
class ApplyDto extends createZodDto(ApplyAnniversaryUpdatesSchema) {}

/** Actualización anual de la renta en el aniversario de cada contrato. */
@Controller('contract-anniversaries')
export class AnniversaryUpdatesController {
  constructor(private readonly service: AnniversaryUpdatesService) {}

  @RequirePermission('contracts:read')
  @Get('settings')
  getSettings(@CurrentUser() user: AuthenticatedUser): Promise<AnniversarySettingsDto> {
    return this.service.getSettings(user.tenantId);
  }

  @RequirePermission('contracts:manage')
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSettingsDto,
  ): Promise<AnniversarySettingsDto> {
    return this.service.updateSettings({ tenantId: user.tenantId, userId: user.sub, input: body });
  }

  @RequirePermission('contracts:read')
  @Get('due')
  due(@CurrentUser() user: AuthenticatedUser): Promise<AnniversaryUpdateDto[]> {
    return this.service.listDue(user.tenantId, user.facilityScope ?? null);
  }

  @RequirePermission('contracts:manage')
  @Post('apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ApplyDto,
    @Req() req: Request,
  ): Promise<ApplyAnniversaryUpdatesResultDto> {
    const ua = req.header('user-agent');
    return this.service.apply({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: { ...(ua ? { userAgent: ua } : {}), ...(req.ip ? { ipAddress: req.ip } : {}) },
    });
  }
}
