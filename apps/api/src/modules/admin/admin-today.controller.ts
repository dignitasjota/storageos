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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ChargeAddonSchema, CreateTodaySnoozeSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminTodayService } from './admin-today.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { AdminTodayCountDto, AdminTodayDto } from '@storageos/shared';
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
  constructor(private readonly service: AdminTodayService) {}

  /** La bandeja entera. `?fresh=1` (la página) no usa la copia de 30 s. */
  @Get()
  today(@Query('fresh') fresh?: string): Promise<AdminTodayDto> {
    return this.service.getToday({ fresh: fresh === '1' || fresh === 'true' });
  }

  /** Solo el número de urgentes, para el contador del menú (copia de 30 s). */
  @Get('count')
  async count(): Promise<AdminTodayCountDto> {
    return { urgentCount: await this.service.getUrgentCount() };
  }

  /** Aparta un aviso unos días (también el rol soporte: no cambia nada del tenant). */
  @AdminAudit('admin.today.snoozed')
  @Post('snoozes')
  @HttpCode(HttpStatus.NO_CONTENT)
  async snooze(
    @Body() input: CreateTodaySnoozeDto,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<void> {
    await this.service.snooze(input, admin.sub);
  }

  @AdminAudit('admin.today.unsnoozed')
  @Delete('snoozes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsnooze(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.unsnooze(id);
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
