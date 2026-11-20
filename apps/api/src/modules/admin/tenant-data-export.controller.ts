import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AuditService } from '../auth/audit.service';

import { TenantDataExportService } from './tenant-data-export.service';

import type { TenantDataExportDto } from '@storageos/shared';
import type { Request } from 'express';

/** El propietario descarga todos los datos de su cuenta (portabilidad, baja). */
@Controller('settings/data-export')
export class TenantDataExportController {
  constructor(
    private readonly exporter: TenantDataExportService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Genera el Excel en memoria con todo lo de la cuenta: es caro, así que como
   * mucho dos veces por hora.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('rgpd:manage')
  @Throttle({ default: { limit: 2, ttl: 60 * 60_000 } })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<TenantDataExportDto> {
    const result = await this.exporter.export(user.tenantId);
    await this.audit.write({
      tenantId: user.tenantId,
      userId: user.sub,
      action: 'tenant.data_exported',
      entityType: 'Tenant',
      entityId: user.tenantId,
      changes: { fileBytes: result.fileBytes, counts: result.counts },
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return result;
  }
}
