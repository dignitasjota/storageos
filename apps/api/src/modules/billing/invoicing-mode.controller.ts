import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { type InvoicingModeDto, UpdateInvoicingModeSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { InvoicingModeService } from './invoicing-mode.service';

import type { Request } from 'express';

class UpdateInvoicingModeDto extends createZodDto(UpdateInvoicingModeSchema) {}

/** Dónde se emiten las facturas del tenant (la app con Veri*Factu, u Holded). */
@Controller('settings/invoicing-mode')
export class InvoicingModeController {
  constructor(private readonly modes: InvoicingModeService) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<InvoicingModeDto> {
    return this.modes.get(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Put()
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateInvoicingModeDto,
    @Req() req: Request,
  ): Promise<InvoicingModeDto> {
    const ua = req.header('user-agent');
    return this.modes.set({
      tenantId: user.tenantId,
      userId: user.sub,
      mode: body.mode,
      meta: { ...(ua ? { userAgent: ua } : {}), ...(req.ip ? { ipAddress: req.ip } : {}) },
    });
  }
}
