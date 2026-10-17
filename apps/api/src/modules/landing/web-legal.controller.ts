import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UpdateWebLegalSchema, type WebLegalSettingsDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { WebLegalService } from './web-legal.service';

class UpdateWebLegalDto extends createZodDto(UpdateWebLegalSchema) {}

/** Textos legales de la web pública (Configuración → Textos legales). */
@Controller('settings/tenant/web-legal')
export class WebLegalController {
  constructor(private readonly legal: WebLegalService) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<WebLegalSettingsDto> {
    return this.legal.getSettings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateWebLegalDto,
  ): Promise<WebLegalSettingsDto> {
    return this.legal.updateSettings({ tenantId: user.tenantId, userId: user.sub, input });
  }
}
