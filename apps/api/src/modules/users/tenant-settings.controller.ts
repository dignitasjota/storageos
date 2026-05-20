import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import {
  type TenantSecuritySettingsResponse,
  UpdateTenantSecuritySettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { TenantSettingsService } from './tenant-settings.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class UpdateTenantSecuritySettingsDto extends createZodDto(UpdateTenantSecuritySettingsSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Endpoints `/settings/tenant/*` para la configuracion global del tenant.
 *
 * Fase 12A.1: solo expone la politica de 2FA forzoso. Cuando crezca, este
 * controller alojara el resto de switches del panel "Seguridad" del tenant.
 */
@Controller('settings/tenant')
export class TenantSettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Get('security')
  async getSecurity(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TenantSecuritySettingsResponse> {
    return this.settings.getSecurity(user.tenantId);
  }

  /**
   * Activa o desactiva la obligacion de 2FA para owners y managers.
   *
   * Importante: al activar el flag NO se cierran sesiones existentes. Los
   * usuarios sin 2FA que ya estuvieran logueados pueden seguir trabajando
   * con el access token actual; cuando expire y el refresh rote, o cuando
   * vuelvan a hacer login, seran redirigidos al enrolment forzoso.
   */
  @Roles('owner')
  @Patch('security')
  async updateSecurity(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateTenantSecuritySettingsDto,
    @Req() req: Request,
  ): Promise<TenantSecuritySettingsResponse> {
    return this.settings.updateSecurity({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }
}
