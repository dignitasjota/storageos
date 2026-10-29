import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
  type LegalDocVersionDto,
  UpdateWebLegalSchema,
  type WebLegalSettingsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { GeneralTermsService } from './general-terms.service';
import { WebLegalService } from './web-legal.service';

class UpdateWebLegalDto extends createZodDto(UpdateWebLegalSchema) {}

/** Textos legales de la web pública (Configuración → Textos legales). */
@Controller('settings/tenant/web-legal')
export class WebLegalController {
  constructor(
    private readonly legal: WebLegalService,
    private readonly terms: GeneralTermsService,
  ) {}

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

  /** Versiones de las condiciones generales que han aceptado los inquilinos. */
  @RequirePermission('settings:read')
  @Get('versions')
  versions(@CurrentUser() user: AuthenticatedUser): Promise<LegalDocVersionDto[]> {
    return this.terms.listVersions(user.tenantId);
  }

  /** Texto de una versión aceptada (se abre desde la ficha del contrato). */
  @RequirePermission('contracts:read')
  @Get('versions/:id')
  version(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LegalDocVersionDto> {
    return this.terms.getVersion(user.tenantId, id);
  }
}
