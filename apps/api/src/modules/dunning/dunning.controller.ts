import { BadRequestException, Body, Controller, Get, Put, Query, Req } from '@nestjs/common';
import { DunningSettingsSchema, type DunningSettingsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { invoiceFacilityWhere } from '../../common/facility-scope';
import { PrismaService } from '../database/prisma.service';

import { DunningSettingsService } from './dunning-settings.service';

import type { DunningActionDto } from '@storageos/shared';
import type { Request } from 'express';

class DunningSettingsBody extends createZodDto(DunningSettingsSchema) {}

const STATUSES = ['scheduled', 'executed', 'failed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

@Controller('dunning')
export class DunningController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: DunningSettingsService,
  ) {}

  /** El escalado de impagos: días de cada paso, recargo, corte y aviso legal. */
  @RequirePermission('settings:read')
  @Get('settings')
  getSettings(@CurrentUser() user: AuthenticatedUser): Promise<DunningSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  /**
   * Toca el recargo (configuración de la facturación) y el corte del acceso
   * (ajustes): hacen falta los dos permisos.
   */
  @RequirePermission('settings:manage', 'billing:configure')
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DunningSettingsBody,
    @Req() req: Request,
  ): Promise<DunningSettingsDto> {
    return this.settings.update(user.tenantId, user.sub, body, {
      ...(req.ip ? { ipAddress: req.ip } : {}),
      ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
    });
  }

  @RequirePermission('invoices:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
  ): Promise<DunningActionDto[]> {
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
    }
    // Solo los avisos de facturas de los locales del usuario.
    const invoice = invoiceFacilityWhere(user.facilityScope ?? null) ?? {};
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.dunningAction.findMany({
          where: {
            ...(status ? { status: status as Status } : {}),
            ...(Object.keys(invoice).length ? { invoice } : {}),
          },
          orderBy: { scheduledFor: 'desc' },
          include: { invoice: { select: { invoiceNumber: true } } },
          take: 200,
        }),
      user.tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoice.invoiceNumber,
      actionType: r.actionType,
      status: r.status,
      scheduledFor: r.scheduledFor.toISOString(),
      executedAt: r.executedAt ? r.executedAt.toISOString() : null,
      notes: r.notes,
    }));
  }
}
