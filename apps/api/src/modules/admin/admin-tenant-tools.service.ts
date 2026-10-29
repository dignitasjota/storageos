import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';

import { AuthService } from '../auth/auth.service';
import { SessionsService } from '../auth/sessions.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { CustomDomainCheckService } from '../users/custom-domain-check.service';

import { AdminTenantInteractionsService } from './admin-tenant-interactions.service';
import { SuperAdminAuditService } from './super-admin-audit.service';

import type { Prisma } from '@storageos/database';
import type {
  AdminAeatActionResultDto,
  AdminAnonymizePreviewDto,
  AdminCreateTenantInput,
  AdminCreateTenantResultDto,
  AdminSavedViewDto,
  AdminUserSessionDto,
  CreateAdminSavedViewInput,
  CustomDomainCheckDto,
  SnoozeRiskInput,
} from '@storageos/shared';

interface Meta {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Herramientas del super admin sobre los tenants que no son lectura de la
 * lista ni de la ficha: alta manual, vista previa de anonimizar, «ignorar»
 * en la lista de riesgo, comprobar el DNS del dominio propio, reenviar o
 * consultar facturas en la AEAT, sesiones de los usuarios y vistas guardadas.
 */
@Injectable()
export class AdminTenantToolsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly invoices: InvoicesService,
    private readonly domains: CustomDomainCheckService,
    private readonly interactions: AdminTenantInteractionsService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  private async tenantOrThrow(tenantId: string) {
    const t = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!t || t.deletedAt) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    }
    return t;
  }

  private trace(meta: Meta, action: string, tenantId: string | null, changes: object) {
    return this.audit.record({
      superAdminId: meta.superAdminId,
      action,
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      changes: changes as Record<string, unknown>,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  // ------------------------------------------------------------ alta manual

  /**
   * Da de alta un tenant con su propietario (venta asistida). La cuenta nace
   * con el email ya verificado y una contraseña que nadie conoce: el
   * propietario recibe un enlace para elegir la suya.
   */
  async createTenant(
    input: AdminCreateTenantInput,
    meta: Meta,
  ): Promise<AdminCreateTenantResultDto> {
    const plan = await this.admin.subscriptionPlan.findUnique({ where: { slug: input.planSlug } });
    if (!plan?.isActive) {
      throw new BadRequestException({
        code: 'plan_not_active',
        message: 'Ese plan no está disponible',
      });
    }
    const { tenant, user } = await this.auth.createTenantAccount({
      tenantName: input.tenantName,
      ...(input.tenantSlug ? { tenantSlug: input.tenantSlug } : {}),
      email: input.ownerEmail,
      fullName: input.ownerName,
      passwordHash: await argonHash(randomBytes(32).toString('hex')),
      planSlug: plan.slug,
      trialDays: input.trialDays,
      emailVerified: true,
    });
    await this.auth.sendSetPasswordEmail(tenant.id, user.id);
    if (input.note) {
      await this.interactions.create({
        tenantId: tenant.id,
        superAdminId: meta.superAdminId,
        input: { type: 'note', content: input.note },
      });
    }
    await this.trace(meta, 'admin.tenant.created', tenant.id, {
      plan: plan.slug,
      trialDays: input.trialDays,
    });
    return { tenantId: tenant.id, slug: tenant.slug, ownerEmail: user.email };
  }

  // ------------------------------------------------------- antes de anonimizar

  async anonymizePreview(tenantId: string): Promise<AdminAnonymizePreviewDto> {
    await this.tenantOrThrow(tenantId);
    const [customers, users, activeContracts, invoicesKept, sub, mandate, connect] =
      await Promise.all([
        this.admin.customer.count({ where: { tenantId, deletedAt: null } }),
        this.admin.user.count({ where: { tenantId } }),
        this.admin.contract.count({
          where: { tenantId, deletedAt: null, status: { in: ['active', 'ending'] } },
        }),
        this.admin.invoice.count({ where: { tenantId, status: { notIn: ['draft'] } } }),
        this.admin.tenantSubscription.findUnique({
          where: { tenantId },
          select: { stripeSubscriptionId: true, billingMode: true },
        }),
        this.admin.platformSepaMandate.findFirst({
          where: { tenantId, status: 'active' },
          select: { id: true },
        }),
        this.admin.tenantStripeAccount.findUnique({
          where: { tenantId },
          select: { stripeAccountId: true },
        }),
      ]);
    const warnings: AdminAnonymizePreviewDto['warnings'] = [];
    if (sub?.stripeSubscriptionId) {
      warnings.push({
        code: 'stripe_subscription',
        message:
          'Sigue suscrito en Stripe y le seguirá cobrando: pásalo antes a pago manual en «Suscripción».',
      });
    }
    if (mandate) {
      warnings.push({
        code: 'sepa_mandate',
        message:
          'Tiene un mandato SEPA activo con TrasterOS: cancélalo si no debe cobrarse nada más.',
      });
    }
    if (activeContracts > 0) {
      warnings.push({
        code: 'active_contracts',
        message: `Tiene ${activeContracts} contrato(s) activo(s) con sus inquilinos.`,
      });
    }
    if (connect) {
      warnings.push({
        code: 'stripe_connect',
        message:
          'Tiene su propia cuenta de Stripe conectada: se desconecta (la cuenta sigue en Stripe, a su nombre).',
      });
    }
    return { customers, users, activeContracts, invoicesKept, warnings };
  }

  // ------------------------------------------------------------ en riesgo

  async snoozeRisk(
    tenantId: string,
    input: SnoozeRiskInput,
    meta: Meta,
  ): Promise<{ until: string }> {
    await this.tenantOrThrow(tenantId);
    const until = new Date(Date.now() + input.days * 86_400_000);
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { riskSnoozedUntil: until, riskSnoozeReason: input.reason },
    });
    await this.trace(meta, 'admin.tenant.risk_snoozed', tenantId, {
      days: input.days,
      reason: input.reason,
    });
    return { until: until.toISOString() };
  }

  async unsnoozeRisk(tenantId: string, meta: Meta): Promise<void> {
    await this.tenantOrThrow(tenantId);
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { riskSnoozedUntil: null, riskSnoozeReason: null },
    });
    await this.trace(meta, 'admin.tenant.risk_unsnoozed', tenantId, {});
  }

  // ------------------------------------------------------- dominio propio

  async checkCustomDomain(tenantId: string): Promise<CustomDomainCheckDto> {
    await this.tenantOrThrow(tenantId);
    return this.domains.check(tenantId);
  }

  // ------------------------------------------------------------- AEAT

  async refreshAeat(invoiceId: string, meta: Meta): Promise<AdminAeatActionResultDto> {
    const tenantId = await this.invoiceTenant(invoiceId);
    const dto = await this.invoices.refreshAeatStatus(invoiceId, tenantId);
    await this.trace(meta, 'admin.invoice.aeat_refreshed', tenantId, { invoiceId });
    return {
      invoiceId,
      aeatStatus: dto.aeatStatus ?? null,
      message: 'Estado consultado en la AEAT.',
    };
  }

  async resendAeat(invoiceId: string, meta: Meta): Promise<AdminAeatActionResultDto> {
    const tenantId = await this.invoiceTenant(invoiceId);
    await this.invoices.resendAeat(invoiceId, tenantId);
    await this.trace(meta, 'admin.invoice.aeat_resent', tenantId, { invoiceId });
    return { invoiceId, aeatStatus: 'pending', message: 'Reenvío a la AEAT en cola.' };
  }

  private async invoiceTenant(invoiceId: string): Promise<string> {
    const inv = await this.admin.invoice.findUnique({
      where: { id: invoiceId },
      select: { tenantId: true },
    });
    if (!inv) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    return inv.tenantId;
  }

  // ------------------------------------------------------------ sesiones

  async listUserSessions(tenantId: string, userId: string): Promise<AdminUserSessionDto[]> {
    await this.userOrThrow(tenantId, userId);
    const rows = await this.sessions.listActive(tenantId, userId);
    return rows.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
      expiresAt: s.expiresAt.toISOString(),
      ipAddress: s.ipAddress ?? null,
      userAgent: s.userAgent ?? null,
      installedApp: s.installedApp,
    }));
  }

  async revokeUserSession(
    tenantId: string,
    userId: string,
    sessionId: string,
    meta: Meta,
  ): Promise<void> {
    await this.userOrThrow(tenantId, userId);
    const session = await this.admin.session.findFirst({
      where: { id: sessionId, tenantId, userId },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException({ code: 'session_not_found', message: 'Sesión no encontrada' });
    }
    await this.sessions.revoke({ tenantId, sessionId, reason: 'logout_all' });
    await this.trace(meta, 'admin.user.session_revoked', tenantId, { userId, sessionId });
  }

  private async userOrThrow(tenantId: string, userId: string): Promise<void> {
    const user = await this.admin.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException({ code: 'user_not_found', message: 'Usuario no encontrado' });
    }
  }

  // ------------------------------------------------------ vistas guardadas

  async listViews(superAdminId: string, page: string): Promise<AdminSavedViewDto[]> {
    const rows = await this.admin.superAdminSavedView.findMany({
      where: { superAdminId, page },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.viewDto(r));
  }

  async saveView(
    superAdminId: string,
    input: CreateAdminSavedViewInput,
  ): Promise<AdminSavedViewDto> {
    const count = await this.admin.superAdminSavedView.count({
      where: { superAdminId, page: input.page },
    });
    const existing = await this.admin.superAdminSavedView.findFirst({
      where: { superAdminId, page: input.page, name: input.name },
      select: { id: true },
    });
    if (!existing && count >= 50) {
      throw new ConflictException({
        code: 'too_many_views',
        message: 'Máximo 50 vistas por lista',
      });
    }
    const row = await this.admin.superAdminSavedView.upsert({
      where: {
        superAdminId_page_name: { superAdminId, page: input.page, name: input.name },
      },
      create: {
        superAdminId,
        page: input.page,
        name: input.name,
        filters: input.filters as Prisma.InputJsonValue,
      },
      update: { filters: input.filters as Prisma.InputJsonValue },
    });
    return this.viewDto(row);
  }

  async deleteView(superAdminId: string, id: string): Promise<void> {
    const res = await this.admin.superAdminSavedView.deleteMany({ where: { id, superAdminId } });
    if (res.count === 0) {
      throw new NotFoundException({ code: 'view_not_found', message: 'Vista no encontrada' });
    }
  }

  private viewDto(r: {
    id: string;
    page: string;
    name: string;
    filters: unknown;
    createdAt: Date;
  }): AdminSavedViewDto {
    return {
      id: r.id,
      page: 'tenants',
      name: r.name,
      filters: (r.filters ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
