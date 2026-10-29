import { randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';
import {
  effectiveFeaturesFromList,
  isDisallowedIp,
  isIpLiteralHostname,
  isWebTemplate,
  parseExternalSiteUrl,
  parseWebContent,
  parseWebSeo,
  parseWebSections,
  resolvePlanFeatures,
  TENANT_FAVICON_MIME_TYPES,
  TENANT_LOGO_MAX_BYTES,
  TENANT_LOGO_MIME_TYPES,
  WEB_HERO_MAX_BYTES,
  WEB_HERO_MIME_TYPES,
} from '@storageos/shared';

import { liveOverrideWhere } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type {
  ContractTemplateDto,
  TenantFaviconUploadDto,
  TenantAccessSettingsResponse,
  TenantBillingSettingsResponse,
  TenantBrandingResponse,
  TenantFeature,
  UpdateContractTemplateInput,
  TenantReferralSettingsResponse,
  TenantReviewsSettingsResponse,
  TenantProfileResponse,
  TenantSecuritySettingsResponse,
  UpdateTenantProfileInput,
  UpdateTenantAccessSettingsInput,
  UpdateTenantBillingSettingsInput,
  UpdateTenantBrandingInput,
  UpdateTenantReferralSettingsInput,
  UpdateTenantReviewsSettingsInput,
  UpdateTenantSecuritySettingsInput,
  UpdateWebSettingsInput,
  RequestWebHeroUploadInput,
  SetWebHeroImageInput,
  WebHeroUploadDto,
  WebSettingsResponse,
} from '@storageos/shared';

@Injectable()
export class TenantSettingsService {
  private readonly logger = new Logger(TenantSettingsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly files: FilesService,
  ) {}

  /**
   * Purga al instante la caché ISR de la web pública del tenant (best-effort).
   * Llama al route handler del web con el secreto compartido. Si no hay secreto
   * o el web no responde, no rompe el guardado (la web se refresca sola en la
   * ventana ISR).
   */
  private async revalidateLanding(slug: string): Promise<void> {
    const secret = this.config.get('REVALIDATE_SECRET', { infer: true });
    if (!secret) return;
    const base = this.config.get('WEB_BASE_URL', { infer: true });
    try {
      await fetch(`${base}/api/revalidate-web`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, secret }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      this.logger.warn(`Revalidación de la web del tenant ${slug} falló: ${String(err)}`);
    }
  }

  async getProfile(tenantId: string): Promise<TenantProfileResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return this.profileDto(tenant);
  }

  private profileDto(t: {
    name: string;
    slug: string;
    timezone: string;
    contactPhone: string | null;
    contactEmail: string | null;
  }): TenantProfileResponse {
    return {
      name: t.name,
      slug: t.slug,
      timezone: t.timezone,
      contactPhone: t.contactPhone,
      contactEmail: t.contactEmail,
    };
  }

  /** Nombre comercial y zona horaria del negocio (los edita el propio tenant). */
  async updateProfile(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantProfileInput;
    meta: RequestMeta;
  }): Promise<TenantProfileResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    if (args.input.name !== undefined && args.input.name !== tenant.name) {
      changes.name = { from: tenant.name, to: args.input.name };
    }
    if (args.input.timezone !== undefined && args.input.timezone !== tenant.timezone) {
      changes.timezone = { from: tenant.timezone, to: args.input.timezone };
    }
    for (const key of ['contactPhone', 'contactEmail'] as const) {
      const raw = args.input[key];
      if (raw === undefined) continue;
      const next = raw === '' ? null : raw;
      if (next !== tenant[key]) changes[key] = { from: tenant[key], to: next };
    }
    if (Object.keys(changes).length === 0) return this.profileDto(tenant);
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: Object.fromEntries(
        Object.entries(changes).map(([k, v]) => [k, v.to]),
      ) as Prisma.TenantUpdateInput,
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.profile_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    if (changes.name || changes.contactPhone || changes.contactEmail) {
      void this.revalidateLanding(updated.slug);
    }
    return this.profileDto(updated);
  }

  async getSecurity(tenantId: string): Promise<TenantSecuritySettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      requireTwoFactorForManagers: tenant.requireTwoFactorForManagers,
    };
  }

  async updateSecurity(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantSecuritySettingsInput;
    meta: RequestMeta;
  }): Promise<TenantSecuritySettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const prev = tenant.requireTwoFactorForManagers;
    const next = args.input.requireTwoFactorForManagers;

    if (prev === next) {
      return { requireTwoFactorForManagers: next };
    }

    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: { requireTwoFactorForManagers: next },
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.security.require_2fa_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { from: prev, to: next },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return { requireTwoFactorForManagers: updated.requireTwoFactorForManagers };
  }

  private billingDto(tenant: {
    autoChargeOnIssue: boolean;
    autoIssueRecurring: boolean;
    lateFeeEnabled: boolean;
    lateFeeType: string;
    lateFeeValue: unknown;
    lateFeeGraceDays: number;
    firstPaymentNextMonthFromDay: number | null;
    autoChargeRetryEnabled: boolean;
    autoChargeRetryMax: number;
    autoChargeRetryIntervalDays: number;
    transferIban: string | null;
    offlineTransferEnabled: boolean;
    offlineCashEnabled: boolean;
    offlineSepaEnabled: boolean;
  }): TenantBillingSettingsResponse {
    return {
      autoChargeOnIssue: tenant.autoChargeOnIssue,
      autoIssueRecurring: tenant.autoIssueRecurring,
      lateFeeEnabled: tenant.lateFeeEnabled,
      lateFeeType: tenant.lateFeeType as 'percentage' | 'fixed',
      lateFeeValue: Number(tenant.lateFeeValue),
      lateFeeGraceDays: tenant.lateFeeGraceDays,
      firstPaymentNextMonthFromDay: tenant.firstPaymentNextMonthFromDay,
      autoChargeRetryEnabled: tenant.autoChargeRetryEnabled,
      autoChargeRetryMax: tenant.autoChargeRetryMax,
      autoChargeRetryIntervalDays: tenant.autoChargeRetryIntervalDays,
      transferIban: tenant.transferIban,
      offlineTransferEnabled: tenant.offlineTransferEnabled,
      offlineCashEnabled: tenant.offlineCashEnabled,
      offlineSepaEnabled: tenant.offlineSepaEnabled,
    };
  }

  async getBilling(tenantId: string): Promise<TenantBillingSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return this.billingDto(tenant);
  }

  async updateBilling(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantBillingSettingsInput;
    meta: RequestMeta;
  }): Promise<TenantBillingSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const { input } = args;
    const data: Record<string, string | number | boolean | null> = {};
    if (input.autoChargeOnIssue !== undefined) data.autoChargeOnIssue = input.autoChargeOnIssue;
    if (input.autoIssueRecurring !== undefined) data.autoIssueRecurring = input.autoIssueRecurring;
    if (input.lateFeeEnabled !== undefined) data.lateFeeEnabled = input.lateFeeEnabled;
    if (input.lateFeeType !== undefined) data.lateFeeType = input.lateFeeType;
    if (input.lateFeeValue !== undefined) data.lateFeeValue = input.lateFeeValue;
    if (input.lateFeeGraceDays !== undefined) data.lateFeeGraceDays = input.lateFeeGraceDays;
    if (input.firstPaymentNextMonthFromDay !== undefined)
      data.firstPaymentNextMonthFromDay = input.firstPaymentNextMonthFromDay;
    if (input.autoChargeRetryEnabled !== undefined)
      data.autoChargeRetryEnabled = input.autoChargeRetryEnabled;
    if (input.autoChargeRetryMax !== undefined) data.autoChargeRetryMax = input.autoChargeRetryMax;
    if (input.autoChargeRetryIntervalDays !== undefined)
      data.autoChargeRetryIntervalDays = input.autoChargeRetryIntervalDays;
    const transferIban = input.transferIban === undefined ? undefined : input.transferIban || null;
    if (input.offlineCashEnabled !== undefined) data.offlineCashEnabled = input.offlineCashEnabled;
    if (input.offlineTransferEnabled !== undefined)
      data.offlineTransferEnabled = input.offlineTransferEnabled;
    if (input.offlineSepaEnabled !== undefined) data.offlineSepaEnabled = input.offlineSepaEnabled;
    // Transferencia sin IBAN: el correo no tendría a dónde enviar el dinero.
    const ibanAfter = transferIban === undefined ? tenant.transferIban : transferIban;
    if (input.offlineTransferEnabled && !ibanAfter) {
      throw new BadRequestException({
        code: 'transfer_iban_required',
        message: 'Para ofrecer el pago por transferencia, guarda antes el IBAN.',
      });
    }
    // Quitar el IBAN apaga también la opción de transferencia.
    if (transferIban === null) data.offlineTransferEnabled = false;
    if (input.offlineSepaEnabled) {
      const sepa = await this.admin.sepaSettings.findUnique({
        where: { tenantId: args.tenantId },
        select: { enabled: true, creditorAddress: true },
      });
      if (!sepa?.enabled || !sepa.creditorAddress) {
        throw new BadRequestException({
          code: 'sepa_not_enabled',
          message:
            'Para ofrecer la domiciliación, activa antes las remesas SEPA con los datos del acreedor y su domicilio.',
        });
      }
    }

    if (Object.keys(data).length === 0 && transferIban === undefined) {
      return this.billingDto(tenant);
    }

    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: { ...data, ...(transferIban !== undefined ? { transferIban } : {}) },
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.billing.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { ...data, ...(transferIban !== undefined ? { transferIban } : {}) },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return this.billingDto(updated);
  }

  async getReviews(tenantId: string): Promise<TenantReviewsSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      reviewsAutoRequest: tenant.reviewsAutoRequest,
      reviewRequestDelayDays: tenant.reviewRequestDelayDays,
      googleReviewUrl: tenant.googleReviewUrl,
    };
  }

  async updateReviews(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantReviewsSettingsInput;
    meta: RequestMeta;
  }): Promise<TenantReviewsSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const { input } = args;
    const data: Record<string, string | number | boolean | null> = {};
    if (input.reviewsAutoRequest !== undefined) data.reviewsAutoRequest = input.reviewsAutoRequest;
    if (input.reviewRequestDelayDays !== undefined)
      data.reviewRequestDelayDays = input.reviewRequestDelayDays;
    if (input.googleReviewUrl !== undefined) data.googleReviewUrl = input.googleReviewUrl || null;

    const updated =
      Object.keys(data).length === 0
        ? tenant
        : await this.admin.tenant.update({ where: { id: args.tenantId }, data });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.reviews.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: data,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return {
      reviewsAutoRequest: updated.reviewsAutoRequest,
      reviewRequestDelayDays: updated.reviewRequestDelayDays,
      googleReviewUrl: updated.googleReviewUrl,
    };
  }

  /** White-label del portal del inquilino (color + logo). */
  async getBranding(tenantId: string): Promise<TenantBrandingResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return this.toBrandingResponse(tenant);
  }

  private toBrandingResponse(tenant: {
    portalBrandColor: string | null;
    webHeaderBranded: boolean;
    portalLogoUrl: string | null;
    portalLogoKey: string | null;
    customDomain: string | null;
    customDomainVerifiedAt: Date | null;
    googleSiteVerification: string | null;
    googleAnalyticsId: string | null;
    webFaviconKey: string | null;
  }): TenantBrandingResponse {
    return {
      portalBrandColor: tenant.portalBrandColor,
      webHeaderBranded: tenant.webHeaderBranded,
      portalLogoUrl: tenant.portalLogoUrl,
      logoUploaded: tenant.portalLogoKey !== null,
      customDomain: tenant.customDomain,
      customDomainVerifiedAt: tenant.customDomainVerifiedAt?.toISOString() ?? null,
      googleSiteVerification: tenant.googleSiteVerification,
      googleAnalyticsId: tenant.googleAnalyticsId,
      faviconUrl: tenant.webFaviconKey
        ? this.files.buildPublicUrl('public', tenant.webFaviconKey)
        : null,
    };
  }

  /** URL firmada para subir el favicon de la web directo al bucket público. */
  async requestFaviconUpload(tenantId: string, mimeType: string): Promise<TenantFaviconUploadDto> {
    const ext = mimeType === 'image/x-icon' ? 'ico' : 'png';
    const key = `${tenantId}/favicon/${randomUUID()}.${ext}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': mimeType } };
  }

  /** Fija (o quita, con `null`) el favicon de la web pública. */
  async setFavicon(args: {
    tenantId: string;
    actorUserId: string;
    key: string | null;
    meta: RequestMeta;
  }): Promise<TenantBrandingResponse> {
    const { key } = args;
    if (key) {
      if (!key.startsWith(`${args.tenantId}/favicon/`) || key.includes('..')) {
        throw new BadRequestException({
          code: 'invalid_favicon_key',
          message: 'Favicon no válido',
        });
      }
      // Los bytes reales (la URL firmada no fija el tipo): PNG o ICO, máx. 512 KB.
      await this.files.assertObjectMimeType('public', key, TENANT_FAVICON_MIME_TYPES, 512 * 1024);
    }
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: { webFaviconKey: key },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: key ? 'tenant.favicon_set' : 'tenant.favicon_removed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { key },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toBrandingResponse(updated);
  }

  /** URL firmada para subir el logo directo al bucket público (PNG o JPG). */
  async requestLogoUpload(tenantId: string, mimeType: string): Promise<TenantFaviconUploadDto> {
    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const key = `${tenantId}/logo/${randomUUID()}.${ext}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': mimeType } };
  }

  /**
   * Fija (o quita, con `null`) el logo subido. Guarda la clave y su URL pública
   * en `portalLogoUrl`, que es lo que leen la web, el portal y los correos.
   */
  async setLogo(args: {
    tenantId: string;
    actorUserId: string;
    key: string | null;
    meta: RequestMeta;
  }): Promise<TenantBrandingResponse> {
    const { key } = args;
    if (key) {
      if (!key.startsWith(`${args.tenantId}/logo/`) || key.includes('..')) {
        throw new BadRequestException({ code: 'invalid_logo_key', message: 'Logo no válido' });
      }
      await this.files.assertObjectMimeType(
        'public',
        key,
        TENANT_LOGO_MIME_TYPES,
        TENANT_LOGO_MAX_BYTES,
      );
    }
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: {
        portalLogoKey: key,
        portalLogoUrl: key ? this.files.buildPublicUrl('public', key) : null,
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: key ? 'tenant.logo_set' : 'tenant.logo_removed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { key },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toBrandingResponse(updated);
  }

  /** ¿El tenant tiene una feature concreta (plan + overrides)? */
  private async hasFeature(tenantId: string, feature: TenantFeature): Promise<boolean> {
    const [subscription, overrides] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { slug: true, tenantFeatures: true } } },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId, ...liveOverrideWhere() },
        select: { feature: true, enabled: true },
      }),
    ]);
    const base = subscription ? resolvePlanFeatures(subscription.plan) : [];
    const features = effectiveFeaturesFromList(
      base,
      overrides as { feature: TenantFeature; enabled: boolean }[],
    );
    return features.includes(feature);
  }

  async updateBranding(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantBrandingInput;
    meta: RequestMeta;
  }): Promise<TenantBrandingResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const { input } = args;
    const data: Prisma.TenantUpdateInput = {};
    if (input.portalBrandColor !== undefined)
      data.portalBrandColor = input.portalBrandColor || null;
    if (input.webHeaderBranded !== undefined) data.webHeaderBranded = input.webHeaderBranded;
    if (input.portalLogoUrl !== undefined && input.portalLogoUrl.trim() !== tenant.portalLogoUrl) {
      // Una dirección pegada sustituye al logo subido.
      const raw = input.portalLogoUrl.trim();
      data.portalLogoKey = null;
      if (raw === '') {
        data.portalLogoUrl = null;
      } else {
        // El logo se sirve al navegador del visitante (sin riesgo), pero
        // TAMBIÉN se usa server-side: `next/og` (Satori) hace un fetch desde
        // el proceso del `web` para generar la imagen Open Graph del
        // tenant — sin esta validación, un tenant podía apuntar su logo a
        // una IP privada/servicio interno (SSRF ciego, disparado por
        // cualquiera que visite la página o por el crawler de una red
        // social al generar la vista previa del enlace). Misma guarda que
        // ya protege `externalSiteUrl`.
        await this.assertSafeExternalUrl(raw, 'portal_logo_url_invalid');
        data.portalLogoUrl = raw;
      }
    }
    if (input.googleSiteVerification !== undefined)
      data.googleSiteVerification = input.googleSiteVerification || null;
    if (input.googleAnalyticsId !== undefined)
      data.googleAnalyticsId = input.googleAnalyticsId || null;

    if (input.customDomain !== undefined) {
      const domain = input.customDomain.trim().toLowerCase();
      if (domain === '') {
        // Quitar el dominio siempre se permite (p. ej. tras un downgrade).
        data.customDomain = null;
        data.customDomainVerifiedAt = null;
        data.customDomainReadyAt = null;
      } else if (domain !== tenant.customDomain) {
        // Setear/cambiar el dominio requiere la feature del plan.
        if (!(await this.hasFeature(args.tenantId, 'custom_domain'))) {
          throw new ForbiddenException({
            code: 'feature_not_in_plan',
            message: 'El dominio propio no está incluido en tu plan',
            details: { requiredFeature: 'custom_domain' },
          });
        }
        const taken = await this.admin.tenant.findFirst({
          where: { customDomain: domain, id: { not: args.tenantId } },
          select: { id: true },
        });
        if (taken) {
          throw new ConflictException({
            code: 'domain_taken',
            message: 'Ese dominio ya está en uso por otra cuenta',
          });
        }
        data.customDomain = domain;
        // Cambiar el dominio invalida la verificación previa (el admin debe
        // reconfigurar el Proxy Host + SSL y reactivarlo).
        data.customDomainVerifiedAt = null;
        data.customDomainReadyAt = null;
      }
    }

    const updated =
      Object.keys(data).length === 0
        ? tenant
        : await this.admin.tenant.update({ where: { id: args.tenantId }, data });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.branding.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: data as unknown as Prisma.InputJsonValue,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return this.toBrandingResponse(updated);
  }

  async getContractTemplate(tenantId: string): Promise<ContractTemplateDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        contractClauses: true,
        housingContractClauses: true,
        autoEndContracts: true,
        deletedAt: true,
      },
    });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    return {
      clauses: tenant.contractClauses,
      housingClauses: tenant.housingContractClauses,
      autoEndContracts: tenant.autoEndContracts,
    };
  }

  async updateContractTemplate(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateContractTemplateInput;
    meta: RequestMeta;
  }): Promise<ContractTemplateDto> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    // Cada plantilla solo cambia si viene; '' = volver a la de por defecto (null).
    const norm = (v: string | undefined) => (v?.trim() ? v : null);
    const data: {
      contractClauses?: string | null;
      housingContractClauses?: string | null;
      autoEndContracts?: boolean;
    } = {};
    if (args.input.autoEndContracts !== undefined) {
      data.autoEndContracts = args.input.autoEndContracts;
    }
    if (args.input.clauses !== undefined) data.contractClauses = norm(args.input.clauses);
    if (args.input.housingClauses !== undefined) {
      data.housingContractClauses = norm(args.input.housingClauses);
    }
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data,
      select: { contractClauses: true, housingContractClauses: true, autoEndContracts: true },
    });
    const clauses = updated.contractClauses;
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.contract_template.changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: {
        hasCustomClauses: clauses !== null,
        hasHousingClauses: updated.housingContractClauses !== null,
        autoEndContracts: updated.autoEndContracts,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return {
      clauses,
      housingClauses: updated.housingContractClauses,
      autoEndContracts: updated.autoEndContracts,
    };
  }

  async getWebSettings(tenantId: string): Promise<WebSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        webTemplate: true,
        webHeadline: true,
        webAbout: true,
        webSections: true,
        webContent: true,
        webSeo: true,
        externalSiteUrl: true,
        webHeroImageKey: true,
        webHeroBackgroundKey: true,
        deletedAt: true,
      },
    });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    return {
      template: isWebTemplate(tenant.webTemplate) ? tenant.webTemplate : 'default',
      headline: tenant.webHeadline,
      about: tenant.webAbout,
      sections: parseWebSections(tenant.webSections),
      content: parseWebContent(tenant.webContent),
      externalSiteUrl: tenant.externalSiteUrl,
      seo: parseWebSeo(tenant.webSeo),
      heroImageUrl: tenant.webHeroImageKey
        ? this.files.buildPublicUrl('public', tenant.webHeroImageKey)
        : null,
      heroBackgroundUrl: tenant.webHeroBackgroundKey
        ? this.files.buildPublicUrl('public', tenant.webHeroBackgroundKey)
        : null,
    };
  }

  /** URL firmada para subir una foto de la portada directo al bucket público. */
  async requestWebHeroUpload(
    tenantId: string,
    input: RequestWebHeroUploadInput,
  ): Promise<WebHeroUploadDto> {
    const ext =
      input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const key = `${tenantId}/web-hero/${input.slot}-${randomUUID()}.${ext}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: input.mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': input.mimeType } };
  }

  /**
   * Fija (o quita, con `key: null`) una foto de la portada. La que deja de
   * usarse se borra del almacenamiento.
   */
  async setWebHeroImage(args: {
    tenantId: string;
    actorUserId: string;
    input: SetWebHeroImageInput;
    meta: RequestMeta;
  }): Promise<WebSettingsResponse> {
    const { slot, key } = args.input;
    if (key) {
      if (!key.startsWith(`${args.tenantId}/web-hero/${slot}-`) || key.includes('..')) {
        throw new BadRequestException({
          code: 'invalid_hero_image_key',
          message: 'Foto no válida',
        });
      }
      // Los bytes reales: la URL firmada no fija el tipo ni el tamaño.
      await this.files.assertObjectMimeType('public', key, WEB_HERO_MIME_TYPES, WEB_HERO_MAX_BYTES);
    }
    const field = slot === 'image' ? 'webHeroImageKey' : 'webHeroBackgroundKey';
    const before = await this.admin.tenant.findUnique({
      where: { id: args.tenantId },
      select: { webHeroImageKey: true, webHeroBackgroundKey: true },
    });
    await this.admin.tenant.update({ where: { id: args.tenantId }, data: { [field]: key } });
    const previous = before?.[field] ?? null;
    if (previous && previous !== key) {
      await this.files.deleteObjects('public', [previous]).catch(() => undefined);
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: key ? 'tenant.web_hero_image_set' : 'tenant.web_hero_image_removed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { slot, key },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.getWebSettings(args.tenantId);
  }

  /** Hosts de la propia plataforma (no se puede apuntar una web externa a ellos). */
  private platformHosts(): string[] {
    const hosts = new Set<string>();
    for (const raw of [
      this.config.get('WEB_BASE_URL', { infer: true }),
      this.config.get('API_BASE_URL', { infer: true }),
    ]) {
      try {
        hosts.add(new URL(raw).hostname.toLowerCase());
      } catch {
        // env inválida — se ignora, no bloquea el resto de la validación.
      }
    }
    return [...hosts];
  }

  private externalUrlErrorMessage(reason: string): string {
    switch (reason) {
      case 'must_be_https':
        return 'La URL debe empezar por https://';
      case 'platform_host':
        return 'No puedes apuntar a un dominio de la propia plataforma';
      case 'private_ip':
      case 'dns_error':
        return 'Esa dirección no es accesible públicamente';
      default:
        return 'La URL no es válida';
    }
  }

  /**
   * Valida una URL EXTERNA que el backend vaya a usar de alguna forma
   * (proxy de la web externa del tenant, o cualquier otra URL que acabe
   * disparando una petición saliente nuestra): formato (https, no
   * IP-literal privada, no nuestro propio dominio) vía `parseExternalSiteUrl`
   * (shared, sin I/O) + resolución DNS del hostname re-chequeada contra los
   * mismos rangos prohibidos (el hostname puede ser un dominio, no un literal
   * de IP — quien luego use la URL debe hacer la MISMA doble comprobación en
   * cada request, como defensa contra DNS rebinding).
   */
  private async assertSafeExternalUrl(url: string, errorCode: string): Promise<void> {
    const check = parseExternalSiteUrl(url, this.platformHosts());
    if (!check.ok) {
      throw new BadRequestException({
        code: errorCode,
        message: this.externalUrlErrorMessage(check.reason),
        details: { reason: check.reason },
      });
    }
    // Si el hostname YA es un literal de IP, `parseExternalSiteUrl` lo validó
    // por completo — resolverlo por DNS no aporta nada (y `dns.lookup` con
    // corchetes de IPv6 puede fallar). La resolución solo aplica a dominios.
    if (isIpLiteralHostname(check.hostname)) return;
    let resolvedIp: string;
    try {
      resolvedIp = (await dns.lookup(check.hostname)).address;
    } catch {
      throw new BadRequestException({
        code: errorCode,
        message: this.externalUrlErrorMessage('dns_error'),
        details: { reason: 'dns_error' },
      });
    }
    if (isDisallowedIp(resolvedIp)) {
      throw new BadRequestException({
        code: errorCode,
        message: this.externalUrlErrorMessage('private_ip'),
        details: { reason: 'private_ip' },
      });
    }
  }

  async updateWebSettings(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateWebSettingsInput;
    meta: RequestMeta;
  }): Promise<WebSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant no encontrado');
    const { input } = args;
    const data: Prisma.TenantUpdateInput = {};

    // URL de la web externa: '' = borrarla; undefined = no tocarla.
    let externalSiteUrlToSave: string | null | undefined;
    if (input.externalSiteUrl !== undefined) {
      const raw = input.externalSiteUrl.trim();
      if (raw === '') {
        externalSiteUrlToSave = null;
      } else {
        await this.assertSafeExternalUrl(raw, 'external_site_url_invalid');
        externalSiteUrlToSave = raw;
      }
      data.externalSiteUrl = externalSiteUrlToSave;
    }

    if (input.template !== undefined) {
      if (input.template === 'external') {
        if (!tenant.customDomainVerifiedAt) {
          throw new BadRequestException({
            code: 'custom_domain_required',
            message: 'Configura y verifica tu dominio propio antes de usar una web externa',
          });
        }
        const effectiveUrl =
          externalSiteUrlToSave !== undefined ? externalSiteUrlToSave : tenant.externalSiteUrl;
        if (!effectiveUrl) {
          throw new BadRequestException({
            code: 'external_site_url_required',
            message: 'Indica la URL de tu web externa',
          });
        }
      }
      data.webTemplate = input.template;
    }

    // '' = borrar (null); undefined = no tocar.
    if (input.headline !== undefined) data.webHeadline = input.headline || null;
    if (input.about !== undefined) data.webAbout = input.about || null;
    if (input.sections !== undefined) {
      // Merge parcial sobre las secciones actuales.
      const current = parseWebSections(tenant.webSections);
      data.webSections = { ...current, ...input.sections } as unknown as Prisma.InputJsonValue;
    }
    if (input.content !== undefined) {
      // Merge parcial sobre el copy actual (cada sección se sobrescribe entera).
      const current = parseWebContent(tenant.webContent);
      data.webContent = { ...current, ...input.content } as unknown as Prisma.InputJsonValue;
    }
    if (input.seo !== undefined) {
      // Merge parcial; '' borra el campo (vuelve al texto generado).
      const merged: Record<string, unknown> = { ...parseWebSeo(tenant.webSeo), ...input.seo };
      data.webSeo = parseWebSeo(merged) as unknown as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length > 0) {
      await this.admin.tenant.update({ where: { id: args.tenantId }, data });
      await this.audit.write({
        tenantId: args.tenantId,
        userId: args.actorUserId,
        action: 'tenant.web_settings.changed',
        entityType: 'Tenant',
        entityId: args.tenantId,
        changes: data as unknown as Prisma.InputJsonValue,
        ipAddress: args.meta.ipAddress ?? null,
        userAgent: args.meta.userAgent ?? null,
      });
      // Purga la caché de la web pública para que el cambio se vea al instante.
      await this.revalidateLanding(tenant.slug);
    }
    return this.getWebSettings(args.tenantId);
  }

  async getReferrals(tenantId: string): Promise<TenantReferralSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      referralEnabled: tenant.referralEnabled,
      referralRewardType: tenant.referralRewardType,
      referralRewardValue: Number(tenant.referralRewardValue),
    };
  }

  async updateReferrals(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantReferralSettingsInput;
    meta: RequestMeta;
  }): Promise<TenantReferralSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: {
        referralEnabled: args.input.referralEnabled,
        referralRewardType: args.input.referralRewardType,
        referralRewardValue: args.input.referralRewardValue,
      },
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.referrals.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: {
        referralEnabled: { from: tenant.referralEnabled, to: updated.referralEnabled },
        referralRewardType: { from: tenant.referralRewardType, to: updated.referralRewardType },
        referralRewardValue: {
          from: Number(tenant.referralRewardValue),
          to: Number(updated.referralRewardValue),
        },
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return {
      referralEnabled: updated.referralEnabled,
      referralRewardType: updated.referralRewardType,
      referralRewardValue: Number(updated.referralRewardValue),
    };
  }

  async getAccess(tenantId: string): Promise<TenantAccessSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    return {
      extraAccessLimit: tenant.extraAccessLimit,
      nightPassEnabled: tenant.nightPassEnabled,
      nightPassPrice: Number(tenant.nightPassPrice),
    };
  }

  async updateAccess(args: {
    tenantId: string;
    actorUserId: string;
    input: UpdateTenantAccessSettingsInput;
    meta: RequestMeta;
  }): Promise<TenantAccessSettingsResponse> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: args.tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException('Tenant no encontrado');
    }
    const updated = await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: {
        ...(args.input.extraAccessLimit !== undefined
          ? { extraAccessLimit: args.input.extraAccessLimit }
          : {}),
        ...(args.input.nightPassEnabled !== undefined
          ? { nightPassEnabled: args.input.nightPassEnabled }
          : {}),
        ...(args.input.nightPassPrice !== undefined
          ? { nightPassPrice: args.input.nightPassPrice }
          : {}),
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.actorUserId,
      action: 'tenant.access.settings_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { ...args.input },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return {
      extraAccessLimit: updated.extraAccessLimit,
      nightPassEnabled: updated.nightPassEnabled,
      nightPassPrice: Number(updated.nightPassPrice),
    };
  }
}
