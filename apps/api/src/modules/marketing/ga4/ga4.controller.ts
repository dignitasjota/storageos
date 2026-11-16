import { Body, Controller, Delete, Get, Post, Put, Query, Req } from '@nestjs/common';
import { ConnectGa4Schema, type Ga4ReportDto, type Ga4SettingsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { AuditService } from '../../auth/audit.service';

import { Ga4Service } from './ga4.service';

import type { Request } from 'express';

class ConnectGa4Dto extends createZodDto(ConnectGa4Schema) {}

/** Google Analytics 4 de la web del tenant. Dentro de Web Premium. */
// Ver la conexión y desconectar no piden Web Premium: sin el extra se puede
// borrar lo guardado (el token de Meta, por ejemplo).

@Controller('marketing/ga4')
export class Ga4Controller {
  constructor(
    private readonly ga4: Ga4Service,
    private readonly audit: AuditService,
  ) {}

  /** Constancia de quién conecta o quita la cuenta (sin credenciales). */
  private trace(
    user: AuthenticatedUser,
    req: Request,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action,
      entityType: 'Tenant',
      entityId: user.tenantId,
      changes: changes as never,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @RequirePermission('marketing:read')
  @Get()
  settings(@CurrentUser() user: AuthenticatedUser): Promise<Ga4SettingsDto> {
    return this.ga4.settings(user.tenantId);
  }

  @RequirePermission('marketing:manage')
  @RequireFeature('web_premium')
  @Put()
  async connect(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Body() body: ConnectGa4Dto,
  ): Promise<Ga4SettingsDto> {
    const result = await this.ga4.connect(user.tenantId, body.propertyId);
    await this.trace(user, req, 'marketing.ga4_connected', { propertyId: body.propertyId });
    return result;
  }

  @RequirePermission('marketing:manage')
  @Delete()
  async disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<Ga4SettingsDto> {
    const result = await this.ga4.disconnect(user.tenantId);
    await this.trace(user, req, 'marketing.ga4_disconnected', {});
    return result;
  }

  /** Descarga ya los últimos días (sin esperar al cron). */
  @RequirePermission('marketing:manage')
  @RequireFeature('web_premium')
  @Post('sync')
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<Ga4SettingsDto> {
    await this.ga4.sync(user.tenantId);
    return this.ga4.settings(user.tenantId);
  }

  @RequirePermission('marketing:read')
  @RequireFeature('web_premium')
  @Get('report')
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<Ga4ReportDto> {
    return this.ga4.report(user.tenantId, Number(days) || 30);
  }
}
