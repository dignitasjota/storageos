import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import {
  type PlatformAlertRunResultDto,
  type PlatformAlertSettingsDto,
  UpdatePlatformAlertSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminGuard } from './admin.guard';
import { PlatformAlertsService } from './platform-alerts.service';

class UpdatePlatformAlertSettingsDto extends createZodDto(UpdatePlatformAlertSettingsSchema) {}

/** Config y disparo manual de las alertas proactivas de plataforma. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform-alerts')
export class PlatformAlertsController {
  constructor(private readonly alerts: PlatformAlertsService) {}

  @Get()
  async get(): Promise<PlatformAlertSettingsDto> {
    return this.alerts.getSettings();
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  async update(@Body() input: UpdatePlatformAlertSettingsDto): Promise<PlatformAlertSettingsDto> {
    return this.alerts.updateSettings(input);
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  async run(): Promise<PlatformAlertRunResultDto> {
    return this.alerts.evaluateAndNotify();
  }
}
