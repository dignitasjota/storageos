import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  effectiveFeaturesFromList,
  resolvePlanFeatures,
  type EmailDnsRecordDto,
  type EmailDomainDto,
  type EmailDomainStatus,
  type TenantFeature,
  type UpsertEmailDomainInput,
} from '@storageos/shared';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import {
  BrevoDomainsClient,
  BrevoDomainsError,
  type BrevoDomainState,
} from './brevo-domains.client';

import type { Env } from '../../config/env.schema';
import type { Prisma, TenantEmailDomain } from '@storageos/database';

interface Actor {
  tenantId: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Dominio propio de correo del tenant: alta en la cuenta Brevo de la
 * plataforma, registros DNS que el tenant debe crear y verificación. Mientras
 * no esté verificado (o si el plan deja de incluir `custom_domain`), sus
 * correos salen desde el dominio de la plataforma con su nombre.
 */
@Injectable()
export class EmailDomainsService {
  private readonly logger = new Logger(EmailDomainsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly brevo: BrevoDomainsClient,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async get(tenantId: string): Promise<EmailDomainDto | null> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantEmailDomain.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row) return null;
    return this.toDto(row, await this.hasFeature(tenantId));
  }

  async upsert(actor: Actor, input: UpsertEmailDomainInput): Promise<EmailDomainDto> {
    await this.assertFeature(actor.tenantId);
    this.assertAvailable();
    const domain = input.domain.trim().toLowerCase();
    if (this.isPlatformDomain(domain)) {
      throw new BadRequestException({
        code: 'domain_not_allowed',
        message: 'Ese dominio es de la plataforma. Usa el dominio de tu negocio.',
      });
    }
    const taken = await this.admin.tenantEmailDomain.findUnique({ where: { domain } });
    if (taken && taken.tenantId !== actor.tenantId) {
      throw new ConflictException({
        code: 'domain_taken',
        message: 'Ese dominio ya está en uso en otra cuenta.',
      });
    }

    const current = await this.admin.tenantEmailDomain.findUnique({
      where: { tenantId: actor.tenantId },
    });
    const fields = {
      fromLocalPart: input.fromLocalPart,
      fromName: input.fromName ? input.fromName : null,
      replyTo: input.replyTo ? input.replyTo : null,
    };

    let row: TenantEmailDomain;
    if (current && current.domain === domain) {
      row = await this.admin.tenantEmailDomain.update({ where: { id: current.id }, data: fields });
    } else {
      const state = await this.callBrevo(() => this.brevo.create(domain));
      const data = {
        domain,
        ...fields,
        status: state.authenticated ? 'verified' : 'pending',
        dnsRecords: state.records as unknown as Prisma.InputJsonValue,
        verifiedAt: state.authenticated ? new Date() : null,
        lastCheckedAt: new Date(),
        lastError: null,
      };
      row = current
        ? await this.admin.tenantEmailDomain.update({ where: { id: current.id }, data })
        : await this.admin.tenantEmailDomain.create({
            data: { tenantId: actor.tenantId, ...data },
          });
      if (current) {
        // El dominio anterior ya no se usa: se retira de Brevo (best-effort).
        await this.brevo
          .remove(current.domain)
          .catch((err: unknown) =>
            this.logger.warn(`No se pudo retirar ${current.domain} de Brevo: ${String(err)}`),
          );
      }
    }

    await this.audit.write({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'tenant.email_domain.updated',
      entityType: 'TenantEmailDomain',
      entityId: row.id,
      changes: { domain, fromLocalPart: fields.fromLocalPart, replyTo: fields.replyTo },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return this.toDto(row, true);
  }

  /** Pide a Brevo que compruebe los DNS del tenant. */
  async verify(actor: Actor): Promise<EmailDomainDto> {
    await this.assertFeature(actor.tenantId);
    this.assertAvailable();
    const row = await this.admin.tenantEmailDomain.findUnique({
      where: { tenantId: actor.tenantId },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'email_domain_not_found',
        message: 'Primero indica tu dominio.',
      });
    }
    const state = await this.callBrevo(() => this.brevo.authenticate(row.domain));
    const updated = await this.applyState(row, state);
    if (updated.status === 'verified' && row.status !== 'verified') {
      await this.audit.write({
        tenantId: actor.tenantId,
        userId: actor.userId,
        action: 'tenant.email_domain.verified',
        entityType: 'TenantEmailDomain',
        entityId: row.id,
        changes: { domain: row.domain },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
    }
    return this.toDto(updated, true);
  }

  async remove(actor: Actor): Promise<void> {
    const row = await this.admin.tenantEmailDomain.findUnique({
      where: { tenantId: actor.tenantId },
    });
    if (!row) return;
    await this.admin.tenantEmailDomain.delete({ where: { id: row.id } });
    if (this.brevo.available) {
      await this.brevo
        .remove(row.domain)
        .catch((err: unknown) =>
          this.logger.warn(`No se pudo retirar ${row.domain} de Brevo: ${String(err)}`),
        );
    }
    await this.audit.write({
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'tenant.email_domain.removed',
      entityType: 'TenantEmailDomain',
      entityId: row.id,
      changes: { domain: row.domain },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  /**
   * Revisión diaria (cron): los pendientes se verifican solos cuando el tenant
   * pone los DNS; si un dominio verificado deja de estarlo, sus correos vuelven
   * a salir desde la plataforma y se avisa al tenant.
   */
  async recheckAll(): Promise<{ checked: number; verified: number; failed: number }> {
    if (!this.brevo.available) return { checked: 0, verified: 0, failed: 0 };
    const rows = await this.admin.tenantEmailDomain.findMany({
      where: { status: { in: ['pending', 'verified'] } },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: 200,
    });
    let verified = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const state =
          row.status === 'pending'
            ? await this.brevo.authenticate(row.domain)
            : await this.brevo.get(row.domain);
        const updated = await this.applyState(row, state);
        if (row.status !== 'verified' && updated.status === 'verified') {
          verified++;
          await this.notify(row.tenantId, {
            title: `Correo desde ${row.domain} activado`,
            body: `Tus correos a inquilinos ya salen desde ${row.fromLocalPart}@${row.domain}.`,
          });
        } else if (row.status === 'verified' && updated.status === 'failed') {
          failed++;
          await this.notify(row.tenantId, {
            title: `Revisa los DNS de ${row.domain}`,
            body: 'Los registros de correo ya no son válidos: mientras tanto tus correos salen desde la plataforma.',
          });
        }
      } catch (err) {
        await this.admin.tenantEmailDomain.update({
          where: { id: row.id },
          data: {
            lastCheckedAt: new Date(),
            lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
          },
        });
      }
    }
    return { checked: rows.length, verified, failed };
  }

  private async applyState(
    row: TenantEmailDomain,
    state: BrevoDomainState,
  ): Promise<TenantEmailDomain> {
    const status: EmailDomainStatus = state.authenticated
      ? 'verified'
      : row.status === 'verified'
        ? 'failed'
        : 'pending';
    return this.admin.tenantEmailDomain.update({
      where: { id: row.id },
      data: {
        status,
        dnsRecords: state.records as unknown as Prisma.InputJsonValue,
        verifiedAt: status === 'verified' ? (row.verifiedAt ?? new Date()) : null,
        lastCheckedAt: new Date(),
        lastError: null,
      },
    });
  }

  private async notify(tenantId: string, n: { title: string; body: string }): Promise<void> {
    await this.notifications
      .create(tenantId, {
        type: 'email_domain.status',
        title: n.title,
        body: n.body,
        link: '/settings/email',
      })
      .catch(() => undefined);
  }

  private async callBrevo<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BrevoDomainsError) {
        throw new BadRequestException({
          code: 'email_domain_provider_error',
          message: `Brevo rechazó la operación: ${err.message}`,
        });
      }
      throw err;
    }
  }

  private assertAvailable(): void {
    if (!this.brevo.available) {
      throw new ServiceUnavailableException({
        code: 'email_domains_not_available',
        message: 'El envío desde dominio propio no está disponible todavía.',
      });
    }
  }

  private async assertFeature(tenantId: string): Promise<void> {
    if (!(await this.hasFeature(tenantId))) {
      throw new ForbiddenException({
        code: 'feature_not_in_plan',
        message: 'El correo desde tu dominio forma parte de «Dominio propio».',
        details: { requiredFeature: 'custom_domain' },
      });
    }
  }

  async hasFeature(tenantId: string): Promise<boolean> {
    const [subscription, overrides] = await Promise.all([
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: { select: { slug: true, tenantFeatures: true } } },
      }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId },
        select: { feature: true, enabled: true },
      }),
    ]);
    const base = subscription ? resolvePlanFeatures(subscription.plan) : [];
    return effectiveFeaturesFromList(
      base,
      overrides as { feature: TenantFeature; enabled: boolean }[],
    ).includes('custom_domain');
  }

  /** El dominio (o un subdominio) de la plataforma no se puede usar. */
  private isPlatformDomain(domain: string): boolean {
    const platform: string[] = [];
    const from = this.config.get('EMAIL_FROM_ADDRESS', { infer: true });
    const fromDomain = from.split('@')[1];
    if (fromDomain) platform.push(fromDomain.toLowerCase());
    try {
      platform.push(new URL(this.config.get('WEB_BASE_URL', { infer: true })).hostname);
    } catch {
      // sin WEB_BASE_URL válida
    }
    return platform.some((p) => p !== 'localhost' && (domain === p || domain.endsWith(`.${p}`)));
  }

  private toDto(row: TenantEmailDomain, active: boolean): EmailDomainDto {
    return {
      domain: row.domain,
      fromAddress: `${row.fromLocalPart}@${row.domain}`,
      fromName: row.fromName,
      replyTo: row.replyTo,
      status: row.status as EmailDomainStatus,
      records: (row.dnsRecords as unknown as EmailDnsRecordDto[]) ?? [],
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastError: row.lastError,
      active,
    };
  }
}
