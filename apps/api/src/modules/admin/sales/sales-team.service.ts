import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  normalizeSalesCode,
  salesMonth,
  salesSignupUrl,
  type AssignSalesAccountInput,
  type CreateSalesRepInput,
  type ReassignSalesPortfolioInput,
  type SalesPendingAssignmentDto,
  type SalesRepAccountsDto,
  type SalesRepDetailDto,
  type SalesRepSummaryDto,
  type SalesTeamDto,
  type UpdateSalesRepInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';
import { SuperAdminService } from '../super-admin.service';

import { SalesAccountsService } from './sales-accounts.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { SalesCommissionsService } from './sales-commissions.service';
import { clean, DAY, round2 } from './sales-common';

import type { Env } from '../../../config/env.schema';

const ACTIVITY_TYPES = ['note', 'call', 'demo', 'meeting', 'whatsapp', 'email_out', 'quote'];

/**
 * Dirección comercial: el equipo con sus cifras, sus datos y su comisión, la
 * cartera de cada uno, reasignar cuentas y lo que espera una decisión.
 */
@Injectable()
export class SalesTeamService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly superAdmins: SuperAdminService,
    private readonly assignment: SalesAssignmentService,
    private readonly commissions: SalesCommissionsService,
    private readonly accounts: SalesAccountsService,
    private readonly audit: SuperAdminAuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private async summaries(
    repIds: string[] | null,
    now = new Date(),
  ): Promise<SalesRepSummaryDto[]> {
    const reps = await this.admin.superAdmin.findMany({
      where: { role: 'sales', ...(repIds ? { id: { in: repIds } } : {}) },
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
    });
    if (reps.length === 0) return [];
    const ids = reps.map((r) => r.id);
    const month = salesMonth(now);
    const since7 = new Date(now.getTime() - 7 * DAY);
    const [prospects, tenants, activities, achieved, commission, targets, pendingClaims] =
      await Promise.all([
        this.admin.platformLead.groupBy({
          by: ['salesRepId'],
          where: {
            salesRepId: { in: ids },
            tenantId: null,
            discardedAt: null,
            status: { in: ['new', 'contacted', 'interested'] },
          },
          _count: { _all: true },
        }),
        this.admin.tenant.findMany({
          where: { salesRepId: { in: ids }, deletedAt: null },
          select: { id: true, salesRepId: true, status: true, createdAt: true },
        }),
        this.admin.platformLeadActivity.groupBy({
          by: ['superAdminId'],
          where: {
            superAdminId: { in: ids },
            occurredAt: { gte: since7 },
            type: { in: ACTIVITY_TYPES },
          },
          _count: { _all: true },
        }),
        this.commissions.monthAchievements(month),
        this.commissions.commissionByRep(month),
        this.admin.salesTarget.findMany({ where: { repId: { in: ids }, month } }),
        this.admin.salesAddonClaim.groupBy({
          by: ['repId'],
          where: { repId: { in: ids }, status: 'pending' },
          _count: { _all: true },
        }),
      ]);
    const tenantIds = tenants.map((t) => t.id);
    const [firstPaid, monthly] = await Promise.all([
      this.commissions.firstPaidByTenant(tenantIds),
      this.commissions.monthlyByTenant(tenantIds),
    ]);
    const window = { from: now.getTime() - 120 * DAY, to: now.getTime() - 30 * DAY };
    return reps.map((r) => {
      const own = tenants.filter((t) => t.salesRepId === r.id);
      const paying = own.filter((t) => firstPaid.has(t.id) && t.status === 'active');
      const cohort = own.filter(
        (t) => t.createdAt.getTime() >= window.from && t.createdAt.getTime() <= window.to,
      );
      const converted = cohort.filter((t) => firstPaid.has(t.id)).length;
      const target = targets.find((t) => t.repId === r.id);
      const mine = achieved.get(r.id) ?? { newClients: 0, newMrr: 0 };
      return {
        id: r.id,
        fullName: r.fullName,
        email: r.email,
        isActive: r.isActive,
        twoFactorEnabled: r.twoFactorEnabled,
        twoFactorRequired: !r.salesTwoFactorExempt,
        lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
        salesCode: r.salesCode,
        phone: r.phone,
        whatsapp: r.whatsapp,
        bookingUrl: r.bookingUrl,
        prospects: prospects.find((p) => p.salesRepId === r.id)?._count._all ?? 0,
        trials: own.filter((t) => t.status === 'trial').length,
        customers: paying.length,
        mrr: round2(paying.reduce((s, t) => s + (monthly.get(t.id) ?? 0), 0)),
        newClientsMonth: mine.newClients,
        newMrrMonth: mine.newMrr,
        activities7d: activities.find((a) => a.superAdminId === r.id)?._count._all ?? 0,
        conversionPct:
          cohort.length > 0 ? Math.round((converted / cohort.length) * 1000) / 10 : null,
        commissionMonth: commission.get(r.id) ?? 0,
        target: target
          ? {
              month,
              newClients: target.newClients,
              newMrr: Number(target.newMrr),
              achieved: mine,
            }
          : null,
        pendingClaims: pendingClaims.find((p) => p.repId === r.id)?._count._all ?? 0,
      };
    });
  }

  async overview(): Promise<SalesTeamDto> {
    const [reps, orphanTenants, orphanLeads, claims, concepts] = await Promise.all([
      this.summaries(null),
      this.admin.tenant.count({
        where: { deletedAt: null, salesRep: { isActive: false } },
      }),
      this.admin.platformLead.count({
        where: { discardedAt: null, tenantId: null, salesRep: { isActive: false } },
      }),
      this.admin.salesAddonClaim.count({ where: { status: 'pending' } }),
      this.admin.salesCommissionItem.count({ where: { status: 'pending' } }),
    ]);
    return {
      reps,
      orphanAccounts: orphanTenants + orphanLeads,
      pending: { claims, concepts },
    };
  }

  /** Lo que espera una decisión de la dirección (para el aviso del menú). */
  async pendingCount(): Promise<{ count: number }> {
    const [claims, concepts, pending] = await Promise.all([
      this.admin.salesAddonClaim.count({ where: { status: 'pending' } }),
      this.admin.salesCommissionItem.count({ where: { status: 'pending' } }),
      this.pendingAssignments(),
    ]);
    return { count: claims + concepts + pending.length };
  }

  async repDetail(repId: string): Promise<SalesRepDetailDto> {
    const [summary] = await this.summaries([repId]);
    if (!summary)
      throw new NotFoundException({ code: 'rep_not_found', message: 'Comercial no encontrado' });
    const [plan, targets] = await Promise.all([
      this.commissions.getPlan(repId),
      this.commissions.targets(repId),
    ]);
    return {
      ...summary,
      plan,
      targets,
      signupUrl: summary.salesCode
        ? salesSignupUrl(this.config.get('WEB_BASE_URL', { infer: true }), summary.salesCode)
        : null,
    };
  }

  private async assertCodeFree(code: string, exceptId?: string): Promise<void> {
    const taken = await this.admin.superAdmin.findFirst({
      where: { salesCode: code, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        code: 'sales_code_taken',
        message: 'Ese código ya lo tiene otro comercial',
      });
    }
  }

  /** Alta de un comercial: le llega un enlace para elegir su contraseña. */
  async createRep(input: CreateSalesRepInput, byId: string): Promise<SalesRepDetailDto> {
    const wanted = input.salesCode ? normalizeSalesCode(input.salesCode) : null;
    if (input.salesCode && !wanted) {
      throw new ConflictException({
        code: 'invalid_sales_code',
        message: 'El código debe tener de 4 a 12 letras o cifras',
      });
    }
    if (wanted) await this.assertCodeFree(wanted);
    const created = await this.superAdmins.create({
      email: input.email,
      fullName: input.fullName,
      role: 'sales',
    });
    const code = wanted ?? (await this.assignment.generateCode(input.fullName));
    await this.admin.superAdmin.update({
      where: { id: created.id },
      data: {
        salesCode: code,
        phone: clean(input.phone),
        whatsapp: clean(input.whatsapp),
        bookingUrl: clean(input.bookingUrl),
      },
    });
    await this.admin.salesCommissionPlan.create({ data: { repId: created.id, updatedById: byId } });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.rep_created',
      targetType: 'super_admin',
      targetId: created.id,
      changes: { email: input.email, salesCode: code },
    });
    return this.repDetail(created.id);
  }

  async updateRep(
    repId: string,
    input: UpdateSalesRepInput,
    byId: string,
  ): Promise<SalesRepDetailDto> {
    const rep = await this.admin.superAdmin.findFirst({ where: { id: repId, role: 'sales' } });
    if (!rep)
      throw new NotFoundException({ code: 'rep_not_found', message: 'Comercial no encontrado' });
    let code: string | undefined;
    if (input.salesCode !== undefined) {
      const normalized = normalizeSalesCode(input.salesCode);
      if (!normalized) {
        throw new ConflictException({
          code: 'invalid_sales_code',
          message: 'El código debe tener de 4 a 12 letras o cifras',
        });
      }
      await this.assertCodeFree(normalized, repId);
      code = normalized;
    }
    await this.admin.superAdmin.update({
      where: { id: repId },
      data: {
        ...(input.fullName ? { fullName: input.fullName } : {}),
        ...(input.phone !== undefined ? { phone: clean(input.phone) } : {}),
        ...(input.whatsapp !== undefined ? { whatsapp: clean(input.whatsapp) } : {}),
        ...(input.bookingUrl !== undefined ? { bookingUrl: clean(input.bookingUrl) } : {}),
        ...(code ? { salesCode: code } : {}),
        ...(input.twoFactorRequired !== undefined
          ? { salesTwoFactorExempt: !input.twoFactorRequired }
          : {}),
      },
    });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.rep_updated',
      targetType: 'super_admin',
      targetId: repId,
      changes: { fields: Object.keys(input) },
    });
    if (
      input.twoFactorRequired !== undefined &&
      input.twoFactorRequired === rep.salesTwoFactorExempt
    ) {
      await this.audit.record({
        superAdminId: byId,
        action: 'admin.sales.rep_two_factor_changed',
        targetType: 'super_admin',
        targetId: repId,
        changes: { required: input.twoFactorRequired },
      });
    }
    return this.repDetail(repId);
  }

  async repAccounts(repId: string): Promise<SalesRepAccountsDto> {
    const [leads, clients] = await Promise.all([
      this.accounts.listLeads(repId, {}),
      this.accounts.listClients(repId, undefined),
    ]);
    return { leads: leads.items, clients };
  }

  /** Prospectos de comerciales que se han registrado sin su código. */
  async pendingAssignments(): Promise<SalesPendingAssignmentDto[]> {
    const rows = await this.admin.platformLead.findMany({
      where: { salesRepId: { not: null }, tenantId: { not: null }, discardedAt: null },
      select: {
        id: true,
        tenantId: true,
        salesRepId: true,
        trialAt: true,
        salesRep: { select: { fullName: true } },
        tenant: { select: { name: true, salesRepId: true, deletedAt: true } },
      },
    });
    return rows
      .filter((r) => r.tenant && !r.tenant.deletedAt && r.tenant.salesRepId !== r.salesRepId)
      .map((r) => ({
        leadId: r.id,
        tenantId: r.tenantId!,
        tenantName: r.tenant!.name,
        repId: r.salesRepId!,
        repName: r.salesRep?.fullName ?? '',
        registeredAt: r.trialAt?.toISOString() ?? null,
      }));
  }

  /** Asigna, cambia o quita el comercial de una cuenta. */
  async assign(input: AssignSalesAccountInput, byId: string): Promise<{ ok: true }> {
    if (input.repId) {
      const rep = await this.admin.superAdmin.findFirst({
        where: { id: input.repId, role: 'sales', isActive: true },
        select: { id: true },
      });
      if (!rep)
        throw new NotFoundException({ code: 'rep_not_found', message: 'Comercial no encontrado' });
    }
    await this.assignment.assign({
      leadId: input.leadId ?? null,
      tenantId: input.tenantId ?? null,
      repId: input.repId,
      source: 'manual',
      byId,
    });
    return { ok: true };
  }

  /** Pasa la cartera de un comercial a otro (baja, vacaciones) o la deja sin comercial. */
  async reassignPortfolio(
    fromRepId: string,
    input: ReassignSalesPortfolioInput,
    byId: string,
  ): Promise<{ moved: number }> {
    if (input.toRepId) {
      const rep = await this.admin.superAdmin.findFirst({
        where: { id: input.toRepId, role: 'sales', isActive: true },
        select: { id: true },
      });
      if (!rep)
        throw new NotFoundException({ code: 'rep_not_found', message: 'Comercial no encontrado' });
    }
    const [leads, tenants] = await Promise.all([
      input.scope === 'clients'
        ? []
        : this.admin.platformLead.findMany({
            where: { salesRepId: fromRepId, tenantId: null, discardedAt: null },
            select: { id: true },
          }),
      input.scope === 'prospects'
        ? []
        : this.admin.tenant.findMany({
            where: { salesRepId: fromRepId, deletedAt: null },
            select: { id: true },
          }),
    ]);
    let moved = 0;
    for (const l of leads) {
      await this.assignment.assign({ leadId: l.id, repId: input.toRepId, source: 'manual', byId });
      moved += 1;
    }
    for (const t of tenants) {
      await this.assignment.assign({
        tenantId: t.id,
        repId: input.toRepId,
        source: 'manual',
        byId,
      });
      moved += 1;
    }
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.portfolio_reassigned',
      targetType: 'super_admin',
      targetId: fromRepId,
      changes: { toRepId: input.toRepId, scope: input.scope, moved },
    });
    return { moved };
  }
}
