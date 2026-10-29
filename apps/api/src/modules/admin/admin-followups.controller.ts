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
  Query,
  UseGuards,
} from '@nestjs/common';
import { type TenantFollowupDto, UpdateTenantFollowupSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminTenantFollowupsService } from './admin-tenant-followups.service';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';

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

  /** Pendientes de todos los tenants, por fecha de recordatorio (`?mine=1`: los míos). */
  @Get()
  async pending(
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
    @Query('mine') mine?: string,
  ): Promise<TenantFollowupDto[]> {
    return this.followups.listPending(mine === '1' ? admin.sub : null);
  }

  /** Marca como hecho o reabre, pospone o cambia quién se encarga. */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTenantFollowupDto,
  ): Promise<TenantFollowupDto> {
    return this.followups.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.followups.remove(id);
  }
}
