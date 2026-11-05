import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BulkPortalAccessSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CustomerScopeGuard } from '../../common/customer-scope';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PortalService } from './portal.service';

import type { PortalMagicLinkDto } from '@storageos/shared';
import type { Request } from 'express';

class BulkPortalAccessDto extends createZodDto(BulkPortalAccessSchema) {}

function meta(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return { ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

/** Acceso al portal a varios inquilinos de una vez, sin topar con el límite de peticiones. */
@Controller('customers/bulk')
export class PortalBulkController {
  constructor(private readonly portal: PortalService) {}

  @RequirePermission('customers:write')
  @Post('portal-access')
  @HttpCode(HttpStatus.OK)
  async sendAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: BulkPortalAccessDto,
    @Req() req: Request,
  ): Promise<{ sent: number; failed: number }> {
    const ids = await this.portal.visibleCustomerIds(
      user.tenantId,
      body.customerIds,
      user.facilityScope ?? null,
    );
    let sent = 0;
    for (const customerId of ids) {
      try {
        await this.portal.sendAccessEmail(user.tenantId, customerId, user.sub, meta(req));
        sent += 1;
      } catch {
        /* sin email o bloqueado: sigue con los demás */
      }
    }
    return { sent, failed: body.customerIds.length - sent };
  }
}

/**
 * Acceso al portal POR EL STAFF (autenticado): magic link de acceso + gestión
 * del acceso por contraseña (enlace de reset + desactivar). Distinto del flujo
 * público `/portal/login/*`.
 */
@Controller('customers/:customerId/portal-link')
@UseGuards(CustomerScopeGuard)
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

  /** Envía al inquilino por email su acceso al portal (bienvenida o reenvío). */
  @RequirePermission('customers:write')
  @Post('send-email')
  @HttpCode(HttpStatus.OK)
  async sendEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Req() req: Request,
  ): Promise<{ sentTo: string }> {
    return this.portal.sendAccessEmail(user.tenantId, customerId, user.sub, meta(req));
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

  /** Cierra todas las sesiones vivas del portal del inquilino (en todos sus dispositivos). */
  @RequirePermission('customers:write')
  @Post('revoke-sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.portal.revokePortalSessions(user.tenantId, customerId, user.sub, meta(req));
  }
}
