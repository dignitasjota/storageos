import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Put, Req } from '@nestjs/common';
import {
  type ContractTemplateDto,
  type TenantAccessSettingsResponse,
  type TenantBillingSettingsResponse,
  type TenantBrandingResponse,
  type TenantFaviconUploadDto,
  type TenantReferralSettingsResponse,
  type TenantReviewsSettingsResponse,
  type TenantProfileResponse,
  type TenantSecuritySettingsResponse,
  RequestTenantFaviconUploadSchema,
  RequestTenantLogoUploadSchema,
  SetTenantFaviconSchema,
  SetTenantLogoSchema,
  UpdateContractTemplateSchema,
  UpdateTenantAccessSettingsSchema,
  UpdateTenantBillingSettingsSchema,
  UpdateTenantBrandingSchema,
  UpdateTenantReferralSettingsSchema,
  UpdateTenantReviewsSettingsSchema,
  UpdateTenantProfileSchema,
  UpdateTenantSecuritySettingsSchema,
  UpdateWebSettingsSchema,
  RequestWebHeroUploadSchema,
  SetWebHeroImageSchema,
  type WebHeroUploadDto,
  type WebSettingsResponse,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ConfigHealthService } from './config-health.service';
import { CustomDomainCheckService } from './custom-domain-check.service';
import { TenantSettingsService } from './tenant-settings.service';

import type { RequestMeta } from '../auth/auth.service';
import type { ConfigHealthItemDto, CustomDomainCheckDto } from '@storageos/shared';
import type { Request } from 'express';

class UpdateTenantProfileDto extends createZodDto(UpdateTenantProfileSchema) {}
class UpdateTenantSecuritySettingsDto extends createZodDto(UpdateTenantSecuritySettingsSchema) {}
class UpdateTenantBillingSettingsDto extends createZodDto(UpdateTenantBillingSettingsSchema) {}
class UpdateTenantReviewsSettingsDto extends createZodDto(UpdateTenantReviewsSettingsSchema) {}
class UpdateTenantReferralSettingsDto extends createZodDto(UpdateTenantReferralSettingsSchema) {}
class UpdateTenantAccessSettingsDto extends createZodDto(UpdateTenantAccessSettingsSchema) {}
class UpdateTenantBrandingDto extends createZodDto(UpdateTenantBrandingSchema) {}
class UpdateContractTemplateDto extends createZodDto(UpdateContractTemplateSchema) {}
class UpdateWebSettingsDto extends createZodDto(UpdateWebSettingsSchema) {}
class RequestTenantFaviconUploadDto extends createZodDto(RequestTenantFaviconUploadSchema) {}
class SetTenantFaviconDto extends createZodDto(SetTenantFaviconSchema) {}
class RequestWebHeroUploadDto extends createZodDto(RequestWebHeroUploadSchema) {}
class SetWebHeroImageDto extends createZodDto(SetWebHeroImageSchema) {}
class RequestTenantLogoUploadDto extends createZodDto(RequestTenantLogoUploadSchema) {}
class SetTenantLogoDto extends createZodDto(SetTenantLogoSchema) {}

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
  constructor(
    private readonly settings: TenantSettingsService,
    private readonly health: ConfigHealthService,
    private readonly domainCheck: CustomDomainCheckService,
  ) {}

  /**
   * Comprueba si el dominio propio ya apunta a la plataforma; si apunta, avisa
   * al equipo de TrasterOS para activarlo (una vez).
   */
  @RequirePermission('settings:manage')
  @Post('domain/check')
  @HttpCode(HttpStatus.OK)
  checkDomain(@CurrentUser() user: AuthenticatedUser): Promise<CustomDomainCheckDto> {
    return this.domainCheck.check(user.tenantId);
  }

  /** Lo que conviene revisar de la configuración (para el inicio de Configuración). */
  @RequirePermission('settings:read')
  @Get('health')
  getHealth(@CurrentUser() user: AuthenticatedUser): Promise<ConfigHealthItemDto[]> {
    return this.health.check(user.tenantId);
  }

  /** Nombre comercial y zona horaria del negocio. */
  @RequirePermission('settings:read')
  @Get('profile')
  async getProfile(@CurrentUser() user: AuthenticatedUser): Promise<TenantProfileResponse> {
    return this.settings.getProfile(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch('profile')
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateTenantProfileDto,
    @Req() req: Request,
  ): Promise<TenantProfileResponse> {
    return this.settings.updateProfile({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

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

  /** URL firmada para subir el favicon de la web pública (PNG o ICO). */
  @RequirePermission('settings:manage')
  @Post('branding/favicon-upload-url')
  @HttpCode(HttpStatus.OK)
  requestFaviconUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RequestTenantFaviconUploadDto,
  ): Promise<TenantFaviconUploadDto> {
    return this.settings.requestFaviconUpload(user.tenantId, body.mimeType);
  }

  /** Fija el favicon subido (o lo quita con `{ key: null }`). */
  @RequirePermission('settings:manage')
  @Put('branding/favicon')
  setFavicon(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetTenantFaviconDto,
    @Req() req: Request,
  ): Promise<TenantBrandingResponse> {
    return this.settings.setFavicon({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      key: body.key,
      meta: extractMeta(req),
    });
  }

  /** URL firmada para subir el logo (PNG o JPG). */
  @RequirePermission('settings:manage')
  @Post('branding/logo-upload-url')
  @HttpCode(HttpStatus.OK)
  requestLogoUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RequestTenantLogoUploadDto,
  ): Promise<TenantFaviconUploadDto> {
    return this.settings.requestLogoUpload(user.tenantId, body.mimeType);
  }

  /** Fija el logo subido (o lo quita con `{ key: null }`). */
  @RequirePermission('settings:manage')
  @Put('branding/logo')
  setLogo(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetTenantLogoDto,
    @Req() req: Request,
  ): Promise<TenantBrandingResponse> {
    return this.settings.setLogo({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      key: body.key,
      meta: extractMeta(req),
    });
  }

  /** Web Premium: plantilla + textos de la web pública. Feature `web_premium`. */
  @RequireFeature('web_premium')
  @RequirePermission('settings:read')
  @Get('web')
  async getWeb(@CurrentUser() user: AuthenticatedUser): Promise<WebSettingsResponse> {
    return this.settings.getWebSettings(user.tenantId);
  }

  @RequireFeature('web_premium')
  @RequirePermission('settings:manage')
  @Patch('web')
  async updateWeb(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateWebSettingsDto,
    @Req() req: Request,
  ): Promise<WebSettingsResponse> {
    return this.settings.updateWebSettings({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  /** URL firmada para subir una foto de la portada (entrada o fondo). */
  @RequireFeature('web_premium')
  @RequirePermission('settings:manage')
  @Post('web/hero-image-upload-url')
  @HttpCode(HttpStatus.OK)
  async requestWebHeroUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RequestWebHeroUploadDto,
  ): Promise<WebHeroUploadDto> {
    return this.settings.requestWebHeroUpload(user.tenantId, body);
  }

  /** Fija la foto subida de la portada (o la quita con `{ slot, key: null }`). */
  @RequireFeature('web_premium')
  @RequirePermission('settings:manage')
  @Put('web/hero-image')
  async setWebHeroImage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetWebHeroImageDto,
    @Req() req: Request,
  ): Promise<WebSettingsResponse> {
    return this.settings.setWebHeroImage({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      input: body,
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
