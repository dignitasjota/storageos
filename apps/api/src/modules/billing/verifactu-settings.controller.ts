import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { UpdateVerifactuSettingsSchema, type VerifactuSettingsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { VerifactuSettingsService } from './verifactu-settings.service';

import type { Request } from 'express';

class UpdateVerifactuSettingsDto extends createZodDto(UpdateVerifactuSettingsSchema) {}

/** Envío de las facturas a la AEAT (Veri*Factu): lo activa cada negocio. */
@Controller('billing/verifactu')
export class VerifactuSettingsController {
  constructor(private readonly settings: VerifactuSettingsService) {}

  @RequirePermission('invoices:manage')
  @Get('settings')
  get(@CurrentUser() user: AuthenticatedUser): Promise<VerifactuSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Put('settings')
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateVerifactuSettingsDto,
    @Req() req: Request,
  ): Promise<VerifactuSettingsDto> {
    const ua = req.header('user-agent');
    return this.settings.set({
      tenantId: user.tenantId,
      userId: user.sub,
      enabled: body.enabled,
      meta: { ...(ua ? { userAgent: ua } : {}), ...(req.ip ? { ipAddress: req.ip } : {}) },
    });
  }
}
