import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import {
  UpdatePlatformDunningSettingsSchema,
  type DunningRunResultDto,
  type PlatformDunningSettingsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminAudit } from '../admin/admin-audit.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { PlatformDunningService } from './platform-dunning.service';

class UpdateDunningDto extends createZodDto(UpdatePlatformDunningSettingsSchema) {}

/** Dunning del SaaS (cobro de morosos). Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform-dunning')
export class PlatformDunningController {
  constructor(private readonly service: PlatformDunningService) {}

  @Get('settings')
  getSettings(): Promise<PlatformDunningSettingsDto> {
    return this.service.getSettings();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform_dunning.settings_updated')
  @Put('settings')
  updateSettings(@Body() body: UpdateDunningDto): Promise<PlatformDunningSettingsDto> {
    return this.service.updateSettings(body);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform_dunning.run')
  @Post('run')
  run(): Promise<DunningRunResultDto> {
    return this.service.run();
  }
}
