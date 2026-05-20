import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

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
    return this.detail(tenantId);
  }

  /**
   * TODO Fase 8: anonimizacion completa de un tenant (RGPD). Debe:
   *   - reutilizar la logica de `RgpdService.anonymizeCustomer` aplicada
   *     a todos los customers del tenant,
   *   - anonimizar staff users (email/fullName) preservando audit_logs,
   *   - marcar el tenant como cancelled + deletedAt,
   *   - dejar audit log y `data_subject_requests` entry.
   * Placeholder por ahora.
   */
  async anonymize(_tenantId: string, _meta: ActionMeta): Promise<void> {
    throw new Error('admin.tenant.anonymize aun no implementado (Fase 8 pendiente)');
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
