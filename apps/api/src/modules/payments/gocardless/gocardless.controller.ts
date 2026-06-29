import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import {
  type GoCardlessSettingsDto,
  type GoCardlessTestResultDto,
  UpdateGoCardlessSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

import { GoCardlessClient } from './gocardless-client';
import { GoCardlessSettingsService } from './gocardless-settings.service';

class UpdateGoCardlessSettingsBody extends createZodDto(UpdateGoCardlessSettingsSchema) {}

@Controller('settings/gocardless')
export class GoCardlessController {
  constructor(
    private readonly settings: GoCardlessSettingsService,
    private readonly client: GoCardlessClient,
  ) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<GoCardlessSettingsDto> {
    return this.settings.get(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateGoCardlessSettingsBody,
  ): Promise<GoCardlessSettingsDto> {
    return this.settings.update(user.tenantId, body);
  }

  /** Prueba la conexión con el access token guardado (lista los creditors). */
  @RequirePermission('billing:configure')
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async test(@CurrentUser() user: AuthenticatedUser): Promise<GoCardlessTestResultDto> {
    const resolved = await this.settings.getResolved(user.tenantId);
    if (!resolved) {
      return { ok: false, creditorName: null, error: 'no_access_token' };
    }
    return this.client.testConnection(resolved.accessToken, resolved.environment);
  }
}
