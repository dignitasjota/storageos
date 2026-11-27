import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import {
  SetWebIndexingSchema,
  type AdminTenantWebIndexingDto,
  type AdminWebIndexingPreviewDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminWebIndexingService } from './admin-web-indexing.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

class SetWebIndexingDto extends createZodDto(SetWebIndexingSchema) {}

/**
 * Indexación en Google de las webs de los tenants. Leer: super admin y soporte
 * (la lista previa es para revisar). Cambiar el modo: solo super admin.
 */
@Public()
@Controller('admin/web-indexing')
@UseGuards(AdminGuard)
export class AdminWebIndexingController {
  constructor(private readonly service: AdminWebIndexingService) {}

  @Get('preview')
  preview(): Promise<AdminWebIndexingPreviewDto> {
    return this.service.preview();
  }

  @Get('tenants/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<AdminTenantWebIndexingDto> {
    return this.service.get(id);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.tenant.web_indexing_changed')
  @Put('tenants/:id')
  set(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SetWebIndexingDto,
  ): Promise<AdminTenantWebIndexingDto> {
    return this.service.set(id, input.mode, {
      superAdminId: admin.sub,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }
}
