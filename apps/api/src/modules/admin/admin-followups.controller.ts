import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { type TenantFollowupDto, UpdateTenantFollowupSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminGuard } from './admin.guard';

class UpdateTenantFollowupDto extends createZodDto(UpdateTenantFollowupSchema) {}

/**
 * Bandeja global de seguimientos pendientes + acciones por seguimiento. Los
 * de un tenant concreto se crean/listan desde `AdminTenantsController`
 * (`/admin/tenants/:id/followups`).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/followups')
export class AdminFollowupsController {
  constructor(private readonly followups: AdminTenantFollowupsService) {}

  /** Pendientes de todos los tenants, por fecha de recordatorio. */
  @Get()
  async pending(): Promise<TenantFollowupDto[]> {
    return this.followups.listPending();
  }

  /** Marca como hecho o reabre. */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTenantFollowupDto,
  ): Promise<TenantFollowupDto> {
    return this.followups.setStatus(id, body.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.followups.remove(id);
  }
}
