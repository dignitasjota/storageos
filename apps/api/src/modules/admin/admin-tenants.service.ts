import { randomBytes } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { hash as argonHash } from '@node-rs/argon2';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { SuperAdminAuditService } from './super-admin-audit.service';

import type { AdminTenantDto } from '@storageos/shared';

interface ActionMeta {
  superAdminId: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface ExtendTrialArgs extends ActionMeta {
  days: number;
}

/** Resumen de lo anonimizado, devuelto al super admin. */
export interface AnonymizeTenantResult {
  tenantId: string;
  anonymizedCustomers: number;
  anonymizedUsers: number;
}

/** Placeholder con el que se sustituye cada campo de texto personal. */
const ANON = '*** ANONIMIZADO ***';

/**
 * Operaciones de super admin sobre tenants: lectura cross-tenant + acciones
 * de plataforma (suspender, reactivar, extender trial, anonimizar).
 *
 * Usa `PrismaAdminService` (bypass RLS) porque las super admins ven todos
 * los tenants. Cada accion deja rastro en `audit_logs` del tenant afectado.
 */
@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly superAdminAudit: SuperAdminAuditService,
  ) {}

  // =============================== read ====================================

  async list(filters: { search?: string; status?: string }): Promise<AdminTenantDto[]> {
    const rows = await this.admin.tenant.findMany({
      where: {
        deletedAt: null,
        ...(filters.status
          ? { status: filters.status as 'trial' | 'active' | 'suspended' | 'cancelled' }
          : {}),
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { slug: { contains: filters.search, mode: 'insensitive' } },
                { billingEmail: { contains: filters.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        subscription: { include: { plan: true } },
        _count: { select: { users: true, customers: true, contracts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string): Promise<AdminTenantDto> {
    const row = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      include: {
        subscription: { include: { plan: true } },
        _count: { select: { users: true, customers: true, contracts: true } },
      },
    });
    if (!row || row.deletedAt) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: 'Tenant no encontrado',
      });
    }
    return this.toDto(row);
  }

  // =============================== actions =================================

  async suspend(tenantId: string, meta: ActionMeta): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    if (tenant.status === 'suspended') {
      return this.detail(tenantId);
    }
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended' },
    });
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.suspended',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        superAdminId: meta.superAdminId,
        reason: meta.reason,
        previousStatus: tenant.status,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.suspended',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes: { reason: meta.reason, previousStatus: tenant.status },
    });
    return this.detail(tenantId);
  }

  async reactivate(tenantId: string, meta: ActionMeta): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    if (tenant.status !== 'suspended') {
      // Idempotente: si ya esta activo o en trial no hacemos nada.
      return this.detail(tenantId);
    }
    // Determinar status destino: si el trial sigue vigente, vuelve a trial;
    // si no, pasa a active.
    const targetStatus =
      tenant.trialEndsAt && tenant.trialEndsAt.getTime() > Date.now() ? 'trial' : 'active';

    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { status: targetStatus },
    });
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.reactivated',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        superAdminId: meta.superAdminId,
        reason: meta.reason,
        newStatus: targetStatus,
      },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.reactivated',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes: { reason: meta.reason, newStatus: targetStatus },
    });
    return this.detail(tenantId);
  }

  async extendTrial(tenantId: string, args: ExtendTrialArgs): Promise<AdminTenantDto> {
    const tenant = await this.findOrThrow(tenantId);
    const base =
      tenant.trialEndsAt && tenant.trialEndsAt.getTime() > Date.now()
        ? tenant.trialEndsAt
        : new Date();
    const newTrialEndsAt = new Date(base.getTime() + args.days * 24 * 60 * 60 * 1000);

    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        trialEndsAt: newTrialEndsAt,
        ...(tenant.status === 'cancelled' ? {} : { status: 'trial' }),
      },
    });
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.trial_extended',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        superAdminId: args.superAdminId,
        reason: args.reason,
        days: args.days,
        previousTrialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
        newTrialEndsAt: newTrialEndsAt.toISOString(),
      },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action: 'admin.tenant.trial_extended',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes: {
        reason: args.reason,
        days: args.days,
        previousTrialEndsAt: tenant.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
        newTrialEndsAt: newTrialEndsAt.toISOString(),
      },
    });
    return this.detail(tenantId);
  }

  /**
   * Cambia el plan de suscripcion de un tenant (super admin). Util para
   * mover un tenant entre planes (free/starter/pro) — controla, vía
   * `PLAN_FEATURES`, qué modulos premium ve. No toca Stripe (cambio manual).
   */
  async changePlan(
    tenantId: string,
    args: { planSlug: string; reason: string } & ActionMeta,
  ): Promise<AdminTenantDto> {
    await this.findOrThrow(tenantId);
    const plan = await this.admin.subscriptionPlan.findUnique({
      where: { slug: args.planSlug },
    });
    if (!plan) {
      throw new NotFoundException({ code: 'plan_not_found', message: 'Plan no encontrado' });
    }
    const subscription = await this.admin.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!subscription) {
      throw new NotFoundException({
        code: 'subscription_not_found',
        message: 'Suscripcion no encontrada',
      });
    }
    const previousSlug = subscription.plan.slug;
    await this.admin.tenantSubscription.update({
      where: { tenantId },
      data: { planId: plan.id },
    });
    const changes = { reason: args.reason, previousPlan: previousSlug, newPlan: plan.slug };
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.plan_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: args.superAdminId, ...changes },
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: args.superAdminId,
      action: 'admin.tenant.plan_changed',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      changes,
    });
    return this.detail(tenantId);
  }

  /**
   * Anonimizacion completa de un tenant (RGPD, derecho al olvido al darse de
   * baja). Irreversible. En una sola `$transaction` (bypass RLS porque es
   * cross-tenant):
   *   1. Anonimiza TODOS los customers del tenant con los mismos placeholders
   *      que `RgpdService.anonymizeCustomer` (sin la guarda de contrato activo:
   *      el tenant entero se da de baja). Preserva sus `invoices` por
   *      obligacion fiscal (Veri*Factu + Ley 58/2003).
   *   2. Borra `customer_documents` y `payment_methods` (no obligatorios
   *      fiscalmente).
   *   3. Anonimiza el staff (`users`): email unico irreversible — lo exige el
   *      `@@unique([tenantId, email])` —, `fullName`/`phone` borrados, 2FA
   *      desactivado y `passwordHash` sustituido por el hash de un secreto
   *      aleatorio irrecuperable (defensa adicional sobre `isActive=false`).
   *   4. Revoca todas las `sessions` activas del tenant.
   *   5. Marca el tenant `cancelled` + `deletedAt` y borra su PII de contacto
   *      (`billingEmail`, `taxId`).
   *
   * Se preservan `audit_logs` (registro legal de la operativa) y la propia
   * fila del tenant (no se borra fisicamente: la FK de invoices/audit_logs es
   * `NOT NULL`). Deja rastro en `audit_logs` del tenant + `super_admin_audit_logs`.
   */
  async anonymize(tenantId: string, meta: ActionMeta): Promise<AnonymizeTenantResult> {
    await this.findOrThrow(tenantId);

    // Hash de un secreto aleatorio que nadie conoce: invalida la credencial
    // sin dejar un `passwordHash` mal formado que rompa `argon2.verify`.
    const placeholderHash = await argonHash(randomBytes(32).toString('hex'));
    const now = new Date();

    const counts = await this.admin.$transaction(async (tx) => {
      const customers = await tx.customer.updateMany({
        where: { tenantId },
        data: {
          firstName: ANON,
          lastName: '',
          companyName: ANON,
          email: null,
          phone: null,
          address: null,
          city: null,
          postalCode: null,
          documentNumber: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
          notes: null,
          tags: [],
          portalAccessEnabled: false,
          portalPasswordHash: null,
          deletedAt: now,
        },
      });

      await tx.customerDocument.deleteMany({ where: { tenantId } });
      await tx.paymentMethod.deleteMany({ where: { tenantId } });

      // PII fuera de customers: leads (nombre/email/telefono/mensaje) y
      // communications (recipient + cuerpos renderizados + variables, que
      // arrastran datos personales del snapshot Handlebars).
      const leads = await tx.lead.updateMany({
        where: { tenantId },
        data: {
          firstName: ANON,
          lastName: '',
          companyName: ANON,
          email: null,
          phone: null,
          message: null,
          metadata: {},
          deletedAt: now,
        },
      });
      const communications = await tx.communication.updateMany({
        where: { tenantId },
        data: {
          recipient: ANON,
          subject: ANON,
          bodyText: ANON,
          bodyHtml: null,
          variables: {},
          errorMessage: null,
        },
      });

      const users = await tx.user.findMany({ where: { tenantId }, select: { id: true } });
      for (const user of users) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            email: `anon-${user.id}@anonymized.invalid`,
            fullName: ANON,
            phone: null,
            passwordHash: placeholderHash,
            twoFactorSecret: null,
            twoFactorPendingSecret: null,
            twoFactorEnabled: false,
            twoFactorEnrolledAt: null,
            isActive: false,
          },
        });
      }

      await tx.session.deleteMany({ where: { tenantId } });

      await tx.tenant.update({
        where: { id: tenantId },
        data: { status: 'cancelled', deletedAt: now, billingEmail: null, taxId: null },
      });

      return {
        customers: customers.count,
        users: users.length,
        leads: leads.count,
        communications: communications.count,
      };
    });

    const changes = {
      reason: meta.reason,
      anonymizedCustomers: counts.customers,
      anonymizedUsers: counts.users,
      anonymizedLeads: counts.leads,
      anonymizedCommunications: counts.communications,
    };
    await this.audit.write({
      tenantId,
      userId: null,
      action: 'admin.tenant.anonymized',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: { superAdminId: meta.superAdminId, ...changes },
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });
    await this.superAdminAudit.record({
      superAdminId: meta.superAdminId,
      action: 'admin.tenant.anonymized',
      targetType: 'tenant',
      targetId: tenantId,
      targetTenantId: tenantId,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
      changes,
    });

    return {
      tenantId,
      anonymizedCustomers: counts.customers,
      anonymizedUsers: counts.users,
    };
  }

  // ============================== helpers ==================================

  private async findOrThrow(tenantId: string) {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: 'Tenant no encontrado',
      });
    }
    return tenant;
  }

  private toDto(row: {
    id: string;
    name: string;
    slug: string;
    status: string;
    trialEndsAt: Date | null;
    billingEmail: string | null;
    country: string;
    currency: string;
    createdAt: Date;
    subscription: null | {
      status: string;
      currentPeriodEnd: Date | null;
      stripeSubscriptionId: string | null;
      plan: { slug: string; name: string } | null;
    };
    _count: { users: number; customers: number; contracts: number };
  }): AdminTenantDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      trialEndsAt: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
      billingEmail: row.billingEmail,
      country: row.country,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
      userCount: row._count.users,
      customerCount: row._count.customers,
      contractCount: row._count.contracts,
      subscription: row.subscription
        ? {
            planSlug: row.subscription.plan?.slug ?? null,
            planName: row.subscription.plan?.name ?? null,
            status: row.subscription.status,
            currentPeriodEnd: row.subscription.currentPeriodEnd
              ? row.subscription.currentPeriodEnd.toISOString()
              : null,
            stripeSubscriptionId: row.subscription.stripeSubscriptionId,
          }
        : null,
    };
  }
}
