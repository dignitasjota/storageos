import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ChargeAddonSchema, CreateTodaySnoozeSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminTodayExtrasService } from './admin-today-extras.service';
import { AdminTodayService } from './admin-today.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { AdminTodayDto } from '@storageos/shared';
import type { Request } from 'express';

class ChargeAddonDto extends createZodDto(ChargeAddonSchema) {}
class CreateTodaySnoozeDto extends createZodDto(CreateTodaySnoozeSchema) {}

/**
 * Panel «Hoy» del super admin: acciones pendientes del día (cobros de add-ons,
 * trials por expirar, past_due, seguimientos vencidos). `@Public()` salta el
 * JwtAuthGuard de tenant; solo el super admin (`AdminGuard`).
 */
@Public()
@Controller('admin/today')
@UseGuards(AdminGuard)
export class AdminTodayController {
  constructor(
    private readonly service: AdminTodayService,
    private readonly extras: AdminTodayExtrasService,
  ) {}

  @Get()
  today(): Promise<AdminTodayDto> {
    return this.service.getToday();
  }

  /** Aparta un aviso unos días (también el rol soporte: no cambia nada del tenant). */
  @AdminAudit('admin.today.snoozed')
  @Post('snoozes')
  @HttpCode(HttpStatus.NO_CONTENT)
  async snooze(
    @Body() input: CreateTodaySnoozeDto,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<void> {
    await this.extras.snooze(input, admin.sub);
  }

  @Delete('snoozes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsnooze(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.extras.unsnooze(id);
  }

  @RequireSuperadmin()
  @Post('addon-charges/:tenantAddonId/charge')
  chargeAddon(
    @Param('tenantAddonId', new ParseUUIDPipe()) tenantAddonId: string,
    @Body() body: ChargeAddonDto,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Req() req: Request,
  ): Promise<AdminTodayDto> {
    return this.service.chargeAddon(tenantAddonId, body.provider, {
      superAdminId: admin.sub,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
  }
}
