import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import {
  type ContractTemplateDto,
  type TenantAccessSettingsResponse,
  type TenantBillingSettingsResponse,
  type TenantBrandingResponse,
  type TenantReferralSettingsResponse,
  type TenantReviewsSettingsResponse,
  type TenantSecuritySettingsResponse,
  UpdateContractTemplateSchema,
  UpdateTenantAccessSettingsSchema,
  UpdateTenantBillingSettingsSchema,
  UpdateTenantBrandingSchema,
  UpdateTenantReferralSettingsSchema,
  UpdateTenantReviewsSettingsSchema,
  UpdateTenantSecuritySettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { TenantSettingsService } from './tenant-settings.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class UpdateTenantSecuritySettingsDto extends createZodDto(UpdateTenantSecuritySettingsSchema) {}
class UpdateTenantBillingSettingsDto extends createZodDto(UpdateTenantBillingSettingsSchema) {}
class UpdateTenantReviewsSettingsDto extends createZodDto(UpdateTenantReviewsSettingsSchema) {}
class UpdateTenantReferralSettingsDto extends createZodDto(UpdateTenantReferralSettingsSchema) {}
class UpdateTenantAccessSettingsDto extends createZodDto(UpdateTenantAccessSettingsSchema) {}
class UpdateTenantBrandingDto extends createZodDto(UpdateTenantBrandingSchema) {}
class UpdateContractTemplateDto extends createZodDto(UpdateContractTemplateSchema) {}

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

  @RequirePermission('settings:read')
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
  @RequirePermission('settings:manage')
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

  @RequirePermission('settings:read')
  @Get('billing')
  async getBilling(@CurrentUser() user: AuthenticatedUser): Promise<TenantBillingSettingsResponse> {
    return this.settings.getBilling(user.tenantId);
  }

  /**
   * Activa o desactiva el cobro automatico al emitir factura. Con el flag
   * activo, cada factura emitida encola un cobro al metodo de pago
   * predeterminado del cliente; las facturas sin metodo (o F2 sin
   * destinatario) quedan pendientes sin error.
   */
  @RequirePermission('billing:configure')
  @Patch('billing')
  async updateBilling(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateTenantBillingSettingsDto,
    @Req() req: Request,
  ): Promise<TenantBillingSettingsResponse> {
    return this.settings.updateBilling({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('settings:read')
  @Get('reviews')
  async getReviews(@CurrentUser() user: AuthenticatedUser): Promise<TenantReviewsSettingsResponse> {
    return this.settings.getReviews(user.tenantId);
  }

  /** White-label del portal del inquilino (color de marca + logo). */
  @RequirePermission('settings:read')
  @Get('branding')
  async getBranding(@CurrentUser() user: AuthenticatedUser): Promise<TenantBrandingResponse> {
    return this.settings.getBranding(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch('branding')
  async updateBranding(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateTenantBrandingDto,
    @Req() req: Request,
  ): Promise<TenantBrandingResponse> {
    return this.settings.updateBranding({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  /** Cláusulas del contrato editables por el tenant (plantilla). */
  @RequirePermission('settings:read')
  @Get('contract-template')
  async getContractTemplate(@CurrentUser() user: AuthenticatedUser): Promise<ContractTemplateDto> {
    return this.settings.getContractTemplate(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch('contract-template')
  async updateContractTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateContractTemplateDto,
    @Req() req: Request,
  ): Promise<ContractTemplateDto> {
    return this.settings.updateContractTemplate({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  /** Activa o desactiva la auto-solicitud de valoraciones (NPS) por tenant. */
  @RequirePermission('settings:manage')
  @Patch('reviews')
  async updateReviews(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateTenantReviewsSettingsDto,
    @Req() req: Request,
  ): Promise<TenantReviewsSettingsResponse> {
    return this.settings.updateReviews({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('settings:read')
  @Get('referrals')
  async getReferrals(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TenantReferralSettingsResponse> {
    return this.settings.getReferrals(user.tenantId);
  }

  /** Activa el programa de referidos + recompensa al referidor. */
  @RequirePermission('settings:manage')
  @Patch('referrals')
  async updateReferrals(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateTenantReferralSettingsDto,
    @Req() req: Request,
  ): Promise<TenantReferralSettingsResponse> {
    return this.settings.updateReferrals({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('settings:read')
  @Get('access')
  async getAccess(@CurrentUser() user: AuthenticatedUser): Promise<TenantAccessSettingsResponse> {
    return this.settings.getAccess(user.tenantId);
  }

  /** Máximo de accesos adicionales que un inquilino puede crearse en el portal. */
  @RequirePermission('settings:manage')
  @Patch('access')
  async updateAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateTenantAccessSettingsDto,
    @Req() req: Request,
  ): Promise<TenantAccessSettingsResponse> {
    return this.settings.updateAccess({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }
}
