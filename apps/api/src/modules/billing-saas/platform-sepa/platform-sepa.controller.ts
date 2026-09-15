import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { UpdatePlatformSepaSettingsSchema, type PlatformSepaSettingsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../../common/decorators/public.decorator';
import { AdminGuard } from '../../admin/admin.guard';

import { PlatformSepaSettingsService } from './platform-sepa-settings.service';

class UpdatePlatformSepaSettingsDto extends createZodDto(UpdatePlatformSepaSettingsSchema) {}

/** Config del acreedor SEPA de la plataforma (cuenta de cobro de Jota). Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform-sepa')
export class PlatformSepaController {
  constructor(private readonly settings: PlatformSepaSettingsService) {}

  @Get('settings')
  getSettings(): Promise<PlatformSepaSettingsDto> {
    return this.settings.getSettings();
  }

  @Put('settings')
  updateSettings(@Body() body: UpdatePlatformSepaSettingsDto): Promise<PlatformSepaSettingsDto> {
    return this.settings.updateSettings(body);
  }
}
