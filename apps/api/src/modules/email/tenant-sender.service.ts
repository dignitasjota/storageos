import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TtlCache } from '../../common/cache/ttl-cache';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { platformFrom, sanitizeDisplayName, type EmailAddress } from './providers/email-provider';

import type { Env } from '../../config/env.schema';

export interface TenantSender {
  from: EmailAddress;
  replyTo?: EmailAddress;
}

/**
 * Remitente de los correos que un tenant envía a SUS inquilinos (recordatorios,
 * campañas, enlaces del portal…). Hoy: la dirección de la plataforma con el
 * nombre del tenant como nombre visible, y las respuestas al email de
 * facturación del tenant (o al del propietario). Cuando el tenant tenga un
 * dominio propio verificado, aquí se sustituirá la dirección.
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
    const platform = platformFrom(this.config);
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, billingEmail: true },
    });
    if (!tenant) return { from: platform };

    let replyEmail = tenant.billingEmail;
    if (!replyEmail) {
      const owner = await this.admin.user.findFirst({
        where: { tenantId, role: 'owner', isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { email: true },
      });
      replyEmail = owner?.email ?? null;
    }
    const name = sanitizeDisplayName(tenant.name) || platform.name;
    return {
      from: { email: platform.email, ...(name ? { name } : {}) },
      ...(replyEmail ? { replyTo: { email: replyEmail, ...(name ? { name } : {}) } } : {}),
    };
  }
}
