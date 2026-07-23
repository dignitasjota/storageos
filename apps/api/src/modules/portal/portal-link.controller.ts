import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PortalService } from './portal.service';

import type { PortalMagicLinkDto } from '@storageos/shared';
import type { Request } from 'express';

function meta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

/**
 * Acceso al portal POR EL STAFF (autenticado): magic link de acceso + gestión
 * del acceso por contraseña (enlace de reset + desactivar). Distinto del flujo
 * público `/portal/login/*`.
 */
@Controller('customers/:customerId/portal-link')
export class PortalLinkController {
  constructor(private readonly portal: PortalService) {}

  /** Magic link de acceso (lo reparte a mano). */
  @RequirePermission('customers:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Req() req: Request,
  ): Promise<PortalMagicLinkDto> {
    return this.portal.createMagicLinkForCustomer(user.tenantId, customerId, user.sub, meta(req));
  }

  /** Enlace para que el inquilino (re)establezca su contraseña (lo reparte a mano). */
  @RequirePermission('customers:write')
  @Post('password-reset-link')
  @HttpCode(HttpStatus.CREATED)
  async passwordResetLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Req() req: Request,
  ): Promise<PortalMagicLinkDto> {
    return this.portal.createPasswordResetLinkForCustomer(
      user.tenantId,
      customerId,
      user.sub,
      meta(req),
    );
  }

  /** Desactiva el acceso por contraseña del inquilino (borra el hash). */
  @RequirePermission('customers:write')
  @Delete('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disablePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.portal.disablePortalPassword(user.tenantId, customerId, user.sub, meta(req));
  }
}
