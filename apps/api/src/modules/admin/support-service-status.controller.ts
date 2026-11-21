import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { UpdateServiceStatusSchema, type AdminServiceStatusDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminGuard } from './admin.guard';
import { CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';
import { SupportServiceStatusService } from './support-service-status.service';

class UpdateServiceStatusDto extends createZodDto(UpdateServiceStatusSchema) {}

/** Estado del servicio que se enseña a los negocios en Soporte. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/service-status')
export class SupportServiceStatusAdminController {
  constructor(private readonly status: SupportServiceStatusService) {}

  @Get()
  get(): Promise<AdminServiceStatusDto> {
    return this.status.getForAdmin();
  }

  @Put()
  @RequireSuperadmin()
  @AdminAudit('admin.service_status.updated')
  update(
    @Body() body: UpdateServiceStatusDto,
    @CurrentSuperAdmin('sub') superAdminId: string,
  ): Promise<AdminServiceStatusDto> {
    return this.status.update(body, superAdminId);
  }
}
