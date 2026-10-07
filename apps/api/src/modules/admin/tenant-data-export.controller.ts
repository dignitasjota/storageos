import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';

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

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('rgpd:manage')
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
