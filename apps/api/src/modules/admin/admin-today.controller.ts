import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ChargeAddonSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminTodayService } from './admin-today.service';
import { AdminGuard } from './admin.guard';

import type { AdminTodayDto } from '@storageos/shared';

class ChargeAddonDto extends createZodDto(ChargeAddonSchema) {}

/**
 * Panel «Hoy» del super admin: acciones pendientes del día (cobros de add-ons,
 * trials por expirar, past_due, seguimientos vencidos). `@Public()` salta el
 * JwtAuthGuard de tenant; solo el super admin (`AdminGuard`).
 */
@Public()
@Controller('admin/today')
@UseGuards(AdminGuard)
export class AdminTodayController {
  constructor(private readonly service: AdminTodayService) {}

  @Get()
  today(): Promise<AdminTodayDto> {
    return this.service.getToday();
  }

  @Post('addon-charges/:tenantAddonId/charge')
  chargeAddon(
    @Param('tenantAddonId', new ParseUUIDPipe()) tenantAddonId: string,
    @Body() body: ChargeAddonDto,
  ): Promise<AdminTodayDto> {
    return this.service.chargeAddon(tenantAddonId, body.provider);
  }
}
