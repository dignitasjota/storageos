import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TtlCache } from '../../common/cache/ttl-cache';
import { tenantHasFeature } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { PlatformEmailSettingsService } from './platform-email-settings.service';
import { platformFrom, sanitizeDisplayName, type EmailAddress } from './providers/email-provider';

import type { Env } from '../../config/env.schema';

export interface TenantSender {
  from: EmailAddress;
  replyTo?: EmailAddress;
  /** El dominio propio del tenant solo está autenticado en Brevo. */
  forceProvider?: 'brevo';
}

/**
 * Remitente de los correos que un tenant envía a SUS inquilinos (recordatorios,
 * campañas, enlaces del portal…):
 * - con dominio propio de correo **verificado** y la funcionalidad
 *   `custom_domain` en su plan → `<local>@<su-dominio>`, enviado por Brevo;
 * - si no → la dirección de la plataforma con el nombre del tenant.
 * Las respuestas van a la dirección configurada, o al email de facturación del
 * tenant, o al del propietario.
 *
 * Nunca lanza: ante cualquier fallo cae al remitente de la plataforma, para
 * que un problema resolviendo el remitente no bloquee un envío.
 */
@Injectable()
export class TenantSenderService {
  private readonly logger = new Logger(TenantSenderService.name);
  private readonly cache = new TtlCache<TenantSender>();

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
    private readonly platformSettings: PlatformEmailSettingsService,
  ) {}

  async resolve(tenantId: string): Promise<TenantSender> {
    try {
      return await this.cache.get(tenantId, () => this.load(tenantId));
    } catch (err) {
      this.logger.warn(
        `No se pudo resolver el remitente del tenant ${tenantId}: ${err instanceof Error ? err.message : err}`,
      );
      return { from: platformFrom(this.config) };
    }
  }

  private async load(tenantId: string): Promise<TenantSender> {
    // Dirección común de la plataforma (panel admin → Correo saliente).
    const platform = (await this.platformSettings.platformSender()).from;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        billingEmail: true,
        emailDomain: {
          select: {
            domain: true,
            fromLocalPart: true,
            fromName: true,
            replyTo: true,
            status: true,
          },
        },
      },
    });
    if (!tenant) return { from: platform };

    const tenantName = sanitizeDisplayName(tenant.name) || platform.name || '';
    const custom =
      tenant.emailDomain?.status === 'verified' && (await this.hasCustomDomain(tenantId))
        ? tenant.emailDomain
        : null;
    const name = (custom?.fromName && sanitizeDisplayName(custom.fromName)) || tenantName;

    let replyEmail = custom?.replyTo ?? tenant.billingEmail;
    if (!replyEmail) {
      const owner = await this.admin.user.findFirst({
        where: { tenantId, role: 'owner', isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { email: true },
      });
      replyEmail = owner?.email ?? null;
    }

    const from: EmailAddress = custom
      ? { email: `${custom.fromLocalPart}@${custom.domain}`, ...(name ? { name } : {}) }
      : { email: platform.email, ...(name ? { name } : {}) };
    return {
      from,
      ...(replyEmail ? { replyTo: { email: replyEmail, ...(name ? { name } : {}) } } : {}),
      ...(custom ? { forceProvider: 'brevo' as const } : {}),
    };
  }

  private async hasCustomDomain(tenantId: string): Promise<boolean> {
    return tenantHasFeature(this.admin, tenantId, 'custom_domain');
  }
}
