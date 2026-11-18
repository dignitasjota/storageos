import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  revenueCommission,
  salesMonth,
  type CreateSalesCommissionItemInput,
  type CreateSalesSettlementInput,
  type RequestSalesConceptInput,
  type SalesAddonClaimDto,
  type SalesCommissionItemDto,
  type SalesCommissionKind,
  type SalesCommissionPlanDto,
  type SalesCommissionsDto,
  type SalesCommissionStatus,
  type SalesSettlementDto,
  type SalesTargetDto,
  type UpdateSalesCommissionPlanInput,
  type UpsertSalesCommissionConceptInput,
  type UpsertSalesTargetInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import {
  commissionBase,
  parseSplit,
  scaleSplit,
  splitPaymentForCommission,
  type SplitAddon,
} from './commission-split';
import { addMonths, DAY, monthOf, monthRange, round2 } from './sales-common';
import { SalesNotifyService } from './sales-notify.service';

/** Cobros de hace más de esto no generan comisión nueva (sí se ajustan si se devuelven). */
const NEW_ITEM_WINDOW_DAYS = 60;
/** Se revisan devoluciones de cobros de hasta este tiempo atrás. */
const RECHECK_DAYS = 400;
/** Cobros que cuentan: también los devueltos (cuenta lo que queda). */
const PAID_STATUSES = ['paid', 'partially_refunded', 'refunded'];

const money = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

interface AssignmentWindow {
  repId: string;
  startedAt: Date;
  endedAt: Date | null;
}

const repAt = (assignments: AssignmentWindow[], at: Date): string | null =>
  assignments.find(
    (a) =>
      a.startedAt.getTime() <= at.getTime() && (!a.endedAt || a.endedAt.getTime() > at.getTime()),
  )?.repId ?? null;

/**
 * Comisiones de los comerciales: % de lo que pagan sus clientes (sin IVA y sin
 * lo devuelto), fijo por venta, fijo por extra aprobado y conceptos propios. Los
 * extras que contrata un cliente después de la venta solo cuentan si la
 * dirección los aprueba. Todo se recalcula con cada cobro y devolución, y se
 * cierra en liquidaciones mensuales.
 */
@Injectable()
export class SalesCommissionsService {
  private readonly logger = new Logger(SalesCommissionsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly notify: SalesNotifyService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ----------------------------------------------------------------- plan

  async getPlan(repId: string): Promise<SalesCommissionPlanDto> {
    const [plan, concepts] = await Promise.all([
      this.admin.salesCommissionPlan.findUnique({ where: { repId } }),
      this.admin.salesCommissionConcept.findMany({
        where: { repId },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      }),
    ]);
    return {
      revenuePct: Number(plan?.revenuePct ?? 0),
      revenueMonths: plan?.revenueMonths ?? null,
      perSaleAmount: Number(plan?.perSaleAmount ?? 0),
      perAddonAmount: Number(plan?.perAddonAmount ?? 0),
      notes: plan?.notes ?? null,
      concepts: concepts.map((c) => ({
        id: c.id,
        name: c.name,
        amount: Number(c.amount),
        isActive: c.isActive,
      })),
      updatedAt: plan?.updatedAt.toISOString() ?? null,
    };
  }

  async updatePlan(
    repId: string,
    input: UpdateSalesCommissionPlanInput,
    byId: string,
  ): Promise<SalesCommissionPlanDto> {
    await this.assertRep(repId);
    const data = {
      revenuePct: input.revenuePct,
      revenueMonths: input.revenueMonths,
      perSaleAmount: input.perSaleAmount,
      perAddonAmount: input.perAddonAmount,
      notes: input.notes ?? null,
      updatedById: byId,
    };
    await this.admin.salesCommissionPlan.upsert({
      where: { repId },
      create: { repId, ...data },
      update: data,
    });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.commission_plan_updated',
      targetType: 'super_admin',
      targetId: repId,
      changes: { ...input },
    });
    return this.getPlan(repId);
  }

  async upsertConcept(
    repId: string,
    conceptId: string | null,
    input: UpsertSalesCommissionConceptInput,
    byId: string,
  ): Promise<SalesCommissionPlanDto> {
    await this.assertRep(repId);
    if (conceptId) {
      const { count } = await this.admin.salesCommissionConcept.updateMany({
        where: { id: conceptId, repId },
        data: { name: input.name, amount: input.amount, isActive: input.isActive },
      });
      if (count === 0) {
        throw new NotFoundException({
          code: 'concept_not_found',
          message: 'Concepto no encontrado',
        });
      }
    } else {
      await this.admin.salesCommissionConcept.create({
        data: { repId, name: input.name, amount: input.amount, isActive: input.isActive },
      });
    }
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.commission_concept_saved',
      targetType: 'super_admin',
      targetId: repId,
      changes: { name: input.name, amount: input.amount, isActive: input.isActive },
    });
    return this.getPlan(repId);
  }

  async deleteConcept(
    repId: string,
    conceptId: string,
    byId: string,
  ): Promise<SalesCommissionPlanDto> {
    await this.assertRep(repId);
    const concept = await this.admin.salesCommissionConcept.findFirst({
      where: { id: conceptId, repId },
      select: { id: true },
    });
    if (!concept) {
      throw new NotFoundException({ code: 'concept_not_found', message: 'Concepto no encontrado' });
    }
    const used = await this.admin.salesCommissionItem.count({ where: { conceptId, repId } });
    if (used > 0) {
      // Ya se ha usado: se desactiva para conservar el historial.
      await this.admin.salesCommissionConcept.updateMany({
        where: { id: conceptId, repId },
        data: { isActive: false },
      });
    } else {
      await this.admin.salesCommissionConcept.deleteMany({ where: { id: conceptId, repId } });
    }
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.commission_concept_deleted',
      targetType: 'super_admin',
      targetId: repId,
      changes: { conceptId },
    });
    return this.getPlan(repId);
  }

  private async assertRep(repId: string): Promise<void> {
    const rep = await this.admin.superAdmin.findFirst({
      where: { id: repId, role: 'sales' },
      select: { id: true },
    });
    if (!rep)
      throw new NotFoundException({ code: 'rep_not_found', message: 'Comercial no encontrado' });
  }

  // ------------------------------------------------- extras de sus clientes

  /**
   * Cada extra que tiene un cliente de un comercial queda registrado: si lo
   * contrató antes de su primer pago (o antes de que el comercial llevara la
   * cuenta) es parte de la venta; si no, espera a que la dirección lo apruebe.
   */
  async syncClaims(now = new Date()): Promise<number> {
    const tenants = await this.admin.tenant.findMany({
      where: { salesRepId: { not: null }, deletedAt: null },
      select: { id: true, name: true, salesRepId: true },
    });
    if (tenants.length === 0) return 0;
    let created = 0;
    for (let i = 0; i < tenants.length; i += 200) {
      const chunk = tenants.slice(i, i + 200);
      const ids = chunk.map((t) => t.id);
      const [all, claimed, firstPaid, openAssignments] = await Promise.all([
        this.admin.tenantSubscriptionAddon.findMany({
          where: { tenantId: { in: ids } },
          select: {
            id: true,
            tenantId: true,
            addonId: true,
            createdAt: true,
            addon: { select: { name: true } },
          },
        }),
        this.admin.salesAddonClaim.findMany({
          where: { tenantId: { in: ids } },
          select: { tenantAddonId: true },
        }),
        this.firstPaidByTenant(ids),
        this.admin.salesAssignment.findMany({
          where: { tenantId: { in: ids }, endedAt: null },
          select: { tenantId: true, startedAt: true },
        }),
      ]);
      const seen = new Set(claimed.map((c) => c.tenantAddonId));
      const assigned = all.filter((ta) => !seen.has(ta.id));
      if (assigned.length === 0) continue;
      const assignedSince = new Map(openAssignments.map((a) => [a.tenantId!, a.startedAt]));
      const tenantById = new Map(chunk.map((t) => [t.id, t]));
      for (const ta of assigned) {
        const tenant = tenantById.get(ta.tenantId);
        if (!tenant?.salesRepId) continue;
        const paidAt = firstPaid.get(ta.tenantId) ?? null;
        const since = assignedSince.get(ta.tenantId) ?? null;
        const partOfSale =
          !paidAt ||
          ta.createdAt.getTime() <= paidAt.getTime() ||
          (since !== null && ta.createdAt.getTime() < since.getTime());
        const offerId = await this.offerWithAddon(
          tenant.salesRepId,
          ta.tenantId,
          ta.addonId,
          ta.createdAt,
        );
        try {
          await this.admin.salesAddonClaim.create({
            data: {
              tenantId: ta.tenantId,
              tenantAddonId: ta.id,
              addonId: ta.addonId,
              repId: tenant.salesRepId,
              status: partOfSale ? 'approved' : 'pending',
              partOfSale,
              offerId,
              ...(partOfSale
                ? { decidedAt: now, decisionNote: 'Contratado con la venta: cuenta sin aprobación' }
                : {}),
            },
          });
          created += 1;
        } catch (err) {
          if (isUniqueViolation(err)) continue;
          throw err;
        }
        if (!partOfSale) {
          await this.notify.team({
            type: 'sales.addon_claim',
            title: `${tenant.name} ha contratado ${ta.addon.name}`,
            body: 'Es cliente de un comercial: decide si cuenta para su comisión.',
            link: '/admin/sales-team/pending',
          });
          await this.notify.rep(tenant.salesRepId, {
            type: 'sales.claim_pending',
            title: `${tenant.name} ha contratado ${ta.addon.name}`,
            body: 'La dirección decidirá si cuenta para tu comisión. Si lo vendiste tú, explícalo en «Mis resultados».',
            link: '/admin/sales/results?tab=claims',
          });
        }
      }
    }
    return created;
  }

  /** La propuesta del comercial que incluía ese extra y seguía en vigor al contratarlo. */
  private async offerWithAddon(
    repId: string,
    tenantId: string,
    addonId: string,
    at: Date,
  ): Promise<string | null> {
    const offers = await this.admin.platformQuoteOffer.findMany({
      where: {
        superAdminId: repId,
        tenantId,
        createdAt: { lte: at },
        OR: [{ expiresAt: null }, { expiresAt: { gte: at } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, addons: true },
    });
    const hit = offers.find(
      (o) =>
        Array.isArray(o.addons) &&
        (o.addons as { addonId?: string }[]).some((a) => a?.addonId === addonId),
    );
    return hit?.id ?? null;
  }

  async claims(filter: { repId?: string; status?: string }): Promise<SalesAddonClaimDto[]> {
    const rows = await this.admin.salesAddonClaim.findMany({
      where: {
        ...(filter.repId ? { repId: filter.repId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 300,
      include: {
        tenant: { select: { name: true } },
        addon: { select: { name: true } },
        rep: { select: { fullName: true } },
      },
    });
    const assignments = rows.length
      ? await this.admin.tenantSubscriptionAddon.findMany({
          where: { id: { in: rows.map((r) => r.tenantAddonId) } },
          select: { id: true, priceMonthly: true, quantity: true, createdAt: true },
        })
      : [];
    const byId = new Map(assignments.map((a) => [a.id, a]));
    return rows.map((r) => {
      const ta = byId.get(r.tenantAddonId);
      return {
        id: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenant.name,
        addonId: r.addonId,
        addonName: r.addon.name,
        monthly: ta ? round2(Number(ta.priceMonthly) * ta.quantity) : 0,
        repId: r.repId,
        repName: r.rep.fullName,
        status: r.status as SalesCommissionStatus,
        partOfSale: r.partOfSale,
        repNote: r.repNote,
        fromOffer: !!r.offerId,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
        assignedAt: ta?.createdAt.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  async setClaimNote(repId: string, claimId: string, note: string): Promise<SalesAddonClaimDto[]> {
    const { count } = await this.admin.salesAddonClaim.updateMany({
      where: { id: claimId, repId, status: 'pending' },
      data: { repNote: note.trim() || null },
    });
    if (count === 0) {
      throw new NotFoundException({
        code: 'claim_not_found',
        message: 'Solo se puede explicar un extra pendiente de aprobar',
      });
    }
    return this.claims({ repId });
  }

  async decideClaim(
    claimId: string,
    approve: boolean,
    note: string | undefined,
    byId: string,
  ): Promise<SalesAddonClaimDto> {
    const claim = await this.admin.salesAddonClaim.findUnique({
      where: { id: claimId },
      include: { tenant: { select: { name: true } }, addon: { select: { name: true } } },
    });
    if (!claim)
      throw new NotFoundException({ code: 'claim_not_found', message: 'Extra no encontrado' });
    const wanted = approve ? 'approved' : 'rejected';
    if (claim.status === wanted) {
      const [same] = (await this.claims({ repId: claim.repId })).filter((c) => c.id === claimId);
      return same!;
    }
    const now = new Date();
    await this.admin.salesAddonClaim.update({
      where: { id: claimId },
      data: {
        status: wanted,
        decidedById: byId,
        decidedAt: now,
        decisionNote: note?.trim() || null,
      },
    });
    await this.syncClaimFixed(claim, approve, byId, now);
    await this.audit.record({
      superAdminId: byId,
      action: approve ? 'admin.sales.addon_claim_approved' : 'admin.sales.addon_claim_rejected',
      targetType: 'tenant',
      targetId: claim.tenantId,
      targetTenantId: claim.tenantId,
      changes: { claimId, addon: claim.addon.name, note: note ?? null },
    });
    await this.notify.rep(claim.repId, {
      type: 'sales.claim_decided',
      title: approve
        ? `${claim.addon.name} de ${claim.tenant.name} cuenta para tu comisión`
        : `${claim.addon.name} de ${claim.tenant.name} no cuenta para tu comisión`,
      body: note?.trim() || null,
      link: '/admin/sales/results?tab=claims',
    });
    // Los cobros de ese cliente se recalculan con la decisión.
    await this.computeTenant(claim.tenantId, now);
    const [dto] = await this.claims({ repId: claim.repId }).then((list) =>
      list.filter((c) => c.id === claimId),
    );
    return dto!;
  }

  /**
   * Deja el fijo de un extra en lo que toca según la decisión: si la partida aún
   * no se ha liquidado se aprueba o se rechaza ella misma; si ya se pagó, la
   * diferencia va en un ajuste (descuento o reintegro).
   */
  private async syncClaimFixed(
    claim: { id: string; repId: string; tenantId: string; addonId: string; partOfSale: boolean },
    approve: boolean,
    byId: string | null,
    now: Date,
  ): Promise<void> {
    if (claim.partOfSale) return;
    const addonName =
      (
        await this.admin.subscriptionAddon.findUnique({
          where: { id: claim.addonId },
          select: { name: true },
        })
      )?.name ?? 'extra';
    const original = await this.admin.salesCommissionItem.findFirst({
      where: { claimId: claim.id, kind: 'addon_sale' },
    });
    if (!original) {
      if (!approve) return;
      const plan = await this.admin.salesCommissionPlan.findUnique({
        where: { repId: claim.repId },
      });
      const fixed = Number(plan?.perAddonAmount ?? 0);
      if (!(fixed > 0)) return;
      await this.admin.salesCommissionItem
        .create({
          data: {
            repId: claim.repId,
            tenantId: claim.tenantId,
            kind: 'addon_sale',
            claimId: claim.id,
            addonId: claim.addonId,
            description: `Extra vendido: ${addonName}`,
            month: salesMonth(now),
            amount: fixed,
            status: 'approved',
            decidedById: byId,
            decidedAt: now,
          },
        })
        .catch((err: unknown) => {
          if (!isUniqueViolation(err)) throw err;
        });
      return;
    }
    if (!original.settlementId) {
      await this.admin.salesCommissionItem.update({
        where: { id: original.id },
        data: {
          status: approve ? 'approved' : 'rejected',
          decidedById: byId,
          decidedAt: now,
          decisionNote: approve ? null : 'Extra no aprobado',
        },
      });
      return;
    }
    const paid = await this.admin.salesCommissionItem.aggregate({
      where: { claimId: claim.id, status: 'approved' },
      _sum: { amount: true },
    });
    const target = approve ? Number(original.amount) : 0;
    const delta = round2(target - Number(paid._sum.amount ?? 0));
    if (Math.abs(delta) < 0.01) return;
    await this.admin.salesCommissionItem.create({
      data: {
        repId: original.repId,
        tenantId: original.tenantId,
        kind: 'adjustment',
        claimId: claim.id,
        description: `${delta < 0 ? 'Descuento' : 'Reintegro'}: ${original.description}`,
        month: salesMonth(now),
        amount: delta,
        status: 'approved',
        decidedById: byId,
        decidedAt: now,
      },
    });
  }

  /**
   * Anula el fijo de una venta: si aún no se ha liquidado,
   * queda rechazada; si ya se pagó, se descuenta con un ajuste en negativo.
   */
  private async reverseItem(
    where: { saleOfTenant: string },
    reason: string,
    byId: string | null,
  ): Promise<void> {
    const item = await this.admin.salesCommissionItem.findFirst({
      where: { tenantId: where.saleOfTenant, kind: 'sale' },
    });
    if (!item || item.status === 'rejected') return;
    const now = new Date();
    if (!item.settlementId) {
      await this.admin.salesCommissionItem.update({
        where: { id: item.id },
        data: { status: 'rejected', decidedById: byId, decidedAt: now, decisionNote: reason },
      });
      return;
    }
    const marker = `Descuento: ${item.description}`;
    const exists = await this.admin.salesCommissionItem.findFirst({
      where: { tenantId: item.tenantId, kind: 'adjustment', description: marker },
      select: { id: true },
    });
    if (exists) return;
    await this.admin.salesCommissionItem.create({
      data: {
        repId: item.repId,
        tenantId: item.tenantId,
        kind: 'adjustment',
        description: marker,
        month: salesMonth(now),
        amount: -Number(item.amount),
        status: 'approved',
        decidedById: byId,
        decidedAt: now,
        decisionNote: reason,
      },
    });
  }

  // ------------------------------------------------------------------ cálculo

  /** Primer cobro (con importe) de cada tenant, aunque luego se devolviera. */
  async firstPaidByTenant(tenantIds: string[]): Promise<Map<string, Date>> {
    if (tenantIds.length === 0) return new Map();
    const rows = await this.admin.tenantSubscriptionPayment.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: { in: PAID_STATUSES }, amount: { gt: 0 } },
      _min: { paidAt: true, createdAt: true },
    });
    return new Map(
      rows.map((r) => [r.tenantId, r._min.paidAt ?? r._min.createdAt ?? new Date()] as const),
    );
  }

  /** Recalcula las comisiones de todos los clientes que tienen o han tenido comercial. */
  async computeAll(now = new Date()): Promise<{ tenants: number; created: number }> {
    const rows = await this.admin.salesAssignment.findMany({
      where: { tenantId: { not: null } },
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    let created = 0;
    for (const r of rows) {
      try {
        created += await this.computeTenant(r.tenantId!, now);
      } catch (err) {
        this.logger.warn(`[sales] comisiones del tenant ${r.tenantId}: ${String(err)}`);
      }
    }
    return { tenants: rows.length, created };
  }

  /**
   * Comisiones de un cliente: el % de cada cobro (y sus ajustes si se devuelve o
   * cambia lo que cuenta) y el fijo por la venta. Idempotente.
   *
   * - Un cobro devuelto (total o en parte) sigue contando con lo que queda.
   * - El reparto entre plan y extras se guarda al cobrarse: contratar o quitar
   *   un extra después no cambia la comisión de cobros anteriores.
   * - Un comercial desactivado no genera comisiones nuevas; las devoluciones de
   *   lo que ya cobró se le siguen descontando.
   */
  async computeTenant(tenantId: string, now = new Date()): Promise<number> {
    const assignments: AssignmentWindow[] = (
      await this.admin.salesAssignment.findMany({
        where: { tenantId },
        orderBy: { startedAt: 'asc' },
        select: { repId: true, startedAt: true, endedAt: true },
      })
    ).map((a) => ({ repId: a.repId, startedAt: a.startedAt, endedAt: a.endedAt }));
    if (assignments.length === 0) return 0;

    const repIds = [...new Set(assignments.map((a) => a.repId))];
    const since = new Date(now.getTime() - RECHECK_DAYS * DAY);
    const [tenant, payments, allPaid, items, claims, plans, reps, settings] = await Promise.all([
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: {
          name: true,
          subscription: { select: { plan: { select: { priceMonthly: true } } } },
          subscriptionAddons: {
            select: {
              addonId: true,
              priceMonthly: true,
              quantity: true,
              billingMode: true,
              createdAt: true,
              addon: { select: { name: true } },
            },
          },
        },
      }),
      this.admin.tenantSubscriptionPayment.findMany({
        where: {
          tenantId,
          status: { in: PAID_STATUSES },
          amount: { gt: 0 },
          paidAt: { gte: since },
        },
        orderBy: { paidAt: 'asc' },
        include: { invoice: { select: { taxRate: true, lines: true } } },
      }),
      this.admin.tenantSubscriptionPayment.findMany({
        where: { tenantId, status: { in: PAID_STATUSES }, amount: { gt: 0 } },
        orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
        select: { paidAt: true, createdAt: true, amount: true, refundedAmount: true },
      }),
      this.admin.salesCommissionItem.findMany({ where: { tenantId } }),
      this.admin.salesAddonClaim.findMany({
        where: { tenantId, status: 'approved' },
        select: { addonId: true },
      }),
      this.admin.salesCommissionPlan.findMany({ where: { repId: { in: repIds } } }),
      this.admin.superAdmin.findMany({
        where: { id: { in: repIds } },
        select: { id: true, isActive: true, role: true },
      }),
      this.admin.platformBillingSettings.findFirst({ select: { taxRate: true } }),
    ]);
    if (!tenant) return 0;
    const planOf = new Map(plans.map((p) => [p.repId, p]));
    const activeRep = new Set(
      reps.filter((r) => r.isActive && r.role === 'sales').map((r) => r.id),
    );
    const approved = new Set(claims.map((c) => c.addonId));
    const planMonthly = Number(tenant.subscription?.plan.priceMonthly ?? 0);
    const defaultTax = Number(settings?.taxRate ?? 21);
    const first = allPaid[0];
    const firstPaidAt = first ? (first.paidAt ?? first.createdAt) : null;
    let created = 0;

    for (const p of payments) {
      const paidAt = p.paidAt ?? p.createdAt;
      const existing = items.filter(
        (i) => i.paymentId === p.id && i.kind === 'revenue' && i.status !== 'rejected',
      );
      const repId = existing[0]?.repId ?? repAt(assignments, paidAt);
      if (!repId) continue;
      const plan = planOf.get(repId);
      const rate =
        existing[0]?.rate != null ? Number(existing[0].rate) : Number(plan?.revenuePct ?? 0);
      const isNew = existing.length === 0;
      if (isNew) {
        if (!(rate > 0) || !activeRep.has(repId)) continue;
        if (paidAt.getTime() < now.getTime() - NEW_ITEM_WINDOW_DAYS * DAY) continue;
        if (
          plan?.revenueMonths &&
          firstPaidAt &&
          paidAt.getTime() > addMonths(firstPaidAt, plan.revenueMonths).getTime()
        ) {
          continue;
        }
      }
      const gross = Number(p.amount);
      const kept = Math.max(0, gross - Number(p.refundedAmount ?? 0)) / gross;
      const stored = existing.map((i) => parseSplit(i.split)).find((x) => x !== null) ?? null;
      // Reparto del cobro con los extras que tenía el cliente al pagar.
      const snapshot =
        stored ??
        splitPaymentForCommission({
          gross,
          refunded: 0,
          taxRate: p.invoice ? Number(p.invoice.taxRate) : defaultTax,
          provider: p.provider,
          description: p.description,
          lines: (p.invoice?.lines ?? []).map((l) => ({
            kind: l.kind,
            description: l.description,
            total: Number(l.total),
          })),
          planMonthly,
          addons: tenant.subscriptionAddons
            .filter((a) => a.createdAt.getTime() <= paidAt.getTime())
            .map(
              (a): SplitAddon => ({
                addonId: a.addonId,
                name: a.addon.name,
                monthly: Number(a.priceMonthly) * a.quantity,
                billingMode: a.billingMode,
              }),
            ),
        });
      const base = commissionBase(scaleSplit(snapshot, kept), approved);
      const target = revenueCommission(base, rate);
      const current = round2(existing.reduce((s, i) => s + Number(i.amount), 0));
      const delta = round2(target - current);
      if (Math.abs(delta) < 0.01) continue;
      await this.admin.salesCommissionItem.create({
        data: {
          repId,
          tenantId,
          kind: 'revenue',
          paymentId: p.id,
          description: isNew
            ? `${rate} % de ${money(base)} cobrados a ${tenant.name}`
            : `Ajuste del cobro de ${tenant.name} (${delta < 0 ? 'devolución o extra no aprobado' : 'extra aprobado'})`,
          month: isNew ? monthOf(paidAt) : salesMonth(now),
          baseAmount: base,
          rate,
          amount: delta,
          status: 'approved',
          ...(stored ? {} : { split: snapshot as unknown as Prisma.InputJsonValue }),
        },
      });
      created += 1;
    }

    // Fijo por la venta: el primer cobro del cliente con el comercial.
    if (firstPaidAt) {
      const saleRep = repAt(assignments, firstPaidAt);
      const sale = items.find((i) => i.kind === 'sale');
      const netPaid = allPaid.reduce(
        (s, x) => s + Number(x.amount) - Number(x.refundedAmount ?? 0),
        0,
      );
      if (saleRep && netPaid > 0.005) await this.ensureWin(tenantId, saleRep, firstPaidAt);
      if (saleRep && !sale && netPaid > 0.005 && activeRep.has(saleRep)) {
        const fixed = Number(planOf.get(saleRep)?.perSaleAmount ?? 0);
        const recent = firstPaidAt.getTime() >= now.getTime() - NEW_ITEM_WINDOW_DAYS * DAY;
        if (fixed > 0 && recent) {
          try {
            await this.admin.salesCommissionItem.create({
              data: {
                repId: saleRep,
                tenantId,
                kind: 'sale',
                description: `Venta: ${tenant.name}`,
                month: monthOf(firstPaidAt),
                amount: fixed,
                status: 'approved',
              },
            });
            created += 1;
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
          }
        }
        if (recent) {
          await this.notify.repOnce(saleRep, `sale:${tenantId}`, 60 * 24 * 365 * 5, {
            type: 'sales.sale',
            title: `¡Venta! ${tenant.name} ha hecho su primer pago`,
            body: 'Ya es cliente de pago.',
            link: '/admin/sales/clients',
          });
        }
      }
      if (netPaid <= 0.005) {
        // Todo devuelto: la venta no cuenta.
        await this.admin.salesWin.deleteMany({ where: { tenantId } });
        if (sale && sale.status !== 'rejected') {
          await this.reverseItem(
            { saleOfTenant: tenantId },
            'Se ha devuelto todo lo cobrado',
            null,
          );
        }
      }
    }
    return created;
  }

  /**
   * La venta de un cliente (su primer pago) queda anotada con lo que aportaba
   * al mes entonces: los objetivos no cambian si después sube o baja de plan.
   */
  private async ensureWin(tenantId: string, repId: string, paidAt: Date): Promise<void> {
    const exists = await this.admin.salesWin.findUnique({
      where: { tenantId },
      select: { tenantId: true },
    });
    if (exists) return;
    const monthly = (await this.monthlyByTenant([tenantId])).get(tenantId) ?? 0;
    await this.admin.salesWin
      .create({ data: { tenantId, repId, month: monthOf(paidAt), paidAt, monthly } })
      .catch((err: unknown) => {
        if (!isUniqueViolation(err)) throw err;
      });
  }

  // ------------------------------------------------------------------ partidas

  private async itemDtos(
    rows: Prisma.SalesCommissionItemGetPayload<{
      include: { rep: { select: { fullName: true } }; tenant: { select: { name: true } } };
    }>[],
  ): Promise<SalesCommissionItemDto[]> {
    const requesterIds = [
      ...new Set(rows.map((r) => r.requestedById).filter((x): x is string => !!x)),
    ];
    const requesters = requesterIds.length
      ? await this.admin.superAdmin.findMany({
          where: { id: { in: requesterIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const names = new Map(requesters.map((r) => [r.id, r.fullName]));
    return rows.map((r) => ({
      id: r.id,
      repId: r.repId,
      repName: r.rep.fullName,
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      kind: r.kind as SalesCommissionKind,
      description: r.description,
      month: r.month,
      baseAmount: r.baseAmount != null ? Number(r.baseAmount) : null,
      rate: r.rate != null ? Number(r.rate) : null,
      amount: Number(r.amount),
      status: r.status as SalesCommissionStatus,
      settlementId: r.settlementId,
      requestedByName: r.requestedById ? (names.get(r.requestedById) ?? null) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async items(filter: {
    repId?: string;
    month?: string;
    status?: string;
    tenantId?: string;
    take?: number;
  }): Promise<SalesCommissionItemDto[]> {
    const rows = await this.admin.salesCommissionItem.findMany({
      where: {
        ...(filter.repId ? { repId: filter.repId } : {}),
        ...(filter.month ? { month: filter.month } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.tenantId ? { tenantId: filter.tenantId } : {}),
      },
      orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
      take: filter.take ?? 500,
      include: { rep: { select: { fullName: true } }, tenant: { select: { name: true } } },
    });
    return this.itemDtos(rows);
  }

  /** Lo que ve el comercial: su plan, sus partidas y los totales. */
  async view(repId: string, now = new Date()): Promise<SalesCommissionsDto> {
    const month = salesMonth(now);
    const [plan, items, sums] = await Promise.all([
      this.getPlan(repId),
      this.items({ repId, take: 400 }),
      this.admin.salesCommissionItem.groupBy({
        by: ['status'],
        where: { repId },
        _sum: { amount: true },
      }),
    ]);
    const [unsettled, settled, monthSum] = await Promise.all([
      this.admin.salesCommissionItem.aggregate({
        where: { repId, status: 'approved', settlementId: null },
        _sum: { amount: true },
      }),
      this.admin.salesCommissionItem.aggregate({
        where: { repId, status: 'approved', settlementId: { not: null } },
        _sum: { amount: true },
      }),
      this.admin.salesCommissionItem.aggregate({
        where: { repId, status: 'approved', month },
        _sum: { amount: true },
      }),
    ]);
    const pending = Number(sums.find((s) => s.status === 'pending')?._sum.amount ?? 0);
    return {
      plan,
      items,
      totals: {
        approvedUnsettled: round2(Number(unsettled._sum.amount ?? 0)),
        pending: round2(pending),
        month: round2(Number(monthSum._sum.amount ?? 0)),
        settled: round2(Number(settled._sum.amount ?? 0)),
      },
    };
  }

  /** El comercial pide cobrar un concepto (p. ej. una migración) por un cliente suyo. */
  async requestConcept(
    repId: string,
    input: RequestSalesConceptInput,
  ): Promise<SalesCommissionsDto> {
    const [tenant, concept] = await Promise.all([
      this.admin.tenant.findFirst({
        where: { id: input.tenantId, salesRepId: repId, deletedAt: null },
        select: { name: true },
      }),
      this.admin.salesCommissionConcept.findFirst({
        where: { id: input.conceptId, repId, isActive: true },
      }),
    ]);
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Cliente no encontrado' });
    if (!concept)
      throw new NotFoundException({ code: 'concept_not_found', message: 'Concepto no encontrado' });
    await this.admin.salesCommissionItem.create({
      data: {
        repId,
        tenantId: input.tenantId,
        kind: 'concept',
        conceptId: concept.id,
        description: `${concept.name}: ${tenant.name}${input.note ? ` — ${input.note}` : ''}`,
        month: salesMonth(),
        amount: concept.amount,
        status: 'pending',
        requestedById: repId,
      },
    });
    await this.notify.team({
      type: 'sales.concept_request',
      title: `Comisión por «${concept.name}» para aprobar`,
      body: `${tenant.name} · ${money(Number(concept.amount))}`,
      link: '/admin/sales-team/pending',
    });
    return this.view(repId);
  }

  /** La dirección añade un concepto o un ajuste (aprobado). */
  async createItem(
    input: CreateSalesCommissionItemInput,
    byId: string,
  ): Promise<SalesCommissionItemDto> {
    await this.assertRep(input.repId);
    const tenant = await this.admin.tenant.findUnique({
      where: { id: input.tenantId },
      select: { name: true },
    });
    if (!tenant)
      throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant no encontrado' });
    let amount = input.amount ?? 0;
    let description = input.description ?? '';
    if (input.kind === 'concept') {
      const concept = await this.admin.salesCommissionConcept.findFirst({
        where: { id: input.conceptId!, repId: input.repId },
      });
      if (!concept) {
        throw new NotFoundException({
          code: 'concept_not_found',
          message: 'Concepto no encontrado',
        });
      }
      amount = input.amount ?? Number(concept.amount);
      description = `${concept.name}: ${tenant.name}${input.description ? ` — ${input.description}` : ''}`;
    }
    const now = new Date();
    const row = await this.admin.salesCommissionItem.create({
      data: {
        repId: input.repId,
        tenantId: input.tenantId,
        kind: input.kind,
        conceptId: input.kind === 'concept' ? input.conceptId! : null,
        description,
        month: salesMonth(now),
        amount,
        status: 'approved',
        requestedById: byId,
        decidedById: byId,
        decidedAt: now,
      },
      include: { rep: { select: { fullName: true } }, tenant: { select: { name: true } } },
    });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.commission_item_created',
      targetType: 'tenant',
      targetId: input.tenantId,
      targetTenantId: input.tenantId,
      changes: { repId: input.repId, kind: input.kind, amount },
    });
    const [dto] = await this.itemDtos([row]);
    return dto!;
  }

  async decideItem(
    itemId: string,
    approve: boolean,
    note: string | undefined,
    byId: string,
  ): Promise<SalesCommissionItemDto> {
    const item = await this.admin.salesCommissionItem.findUnique({ where: { id: itemId } });
    if (!item)
      throw new NotFoundException({ code: 'item_not_found', message: 'Comisión no encontrada' });
    if (item.settlementId) {
      throw new ConflictException({
        code: 'item_settled',
        message: 'Ya está en una liquidación: para corregirla, añade un ajuste',
      });
    }
    if (item.status !== 'pending') {
      // Las calculadas solas (cobros, ventas, extras) se recalculan: rechazarlas
      // a mano haría que volvieran a salir. Para corregirlas, un ajuste.
      throw new ConflictException({
        code: 'item_not_pending',
        message: 'Ya está decidida: para corregirla, añade un ajuste',
      });
    }
    const row = await this.admin.salesCommissionItem.update({
      where: { id: itemId },
      data: {
        status: approve ? 'approved' : 'rejected',
        decidedById: byId,
        decidedAt: new Date(),
        decisionNote: note?.trim() || null,
      },
      include: { rep: { select: { fullName: true } }, tenant: { select: { name: true } } },
    });
    await this.audit.record({
      superAdminId: byId,
      action: approve
        ? 'admin.sales.commission_item_approved'
        : 'admin.sales.commission_item_rejected',
      targetType: 'tenant',
      targetId: item.tenantId,
      targetTenantId: item.tenantId,
      changes: { itemId, amount: Number(item.amount) },
    });
    {
      await this.notify.rep(item.repId, {
        type: 'sales.claim_decided',
        title: approve ? `Aprobada: ${item.description}` : `Rechazada: ${item.description}`,
        body: note?.trim() || null,
        link: '/admin/sales/results',
      });
    }
    const [dto] = await this.itemDtos([row]);
    return dto!;
  }

  // ---------------------------------------------------------- liquidaciones

  async settlements(repId?: string): Promise<SalesSettlementDto[]> {
    const rows = await this.admin.salesSettlement.findMany({
      where: repId ? { repId } : {},
      orderBy: [{ month: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: { rep: { select: { fullName: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      repId: r.repId,
      repName: r.rep.fullName,
      month: r.month,
      total: Number(r.total),
      itemsCount: r.itemsCount,
      status: r.status === 'paid' ? 'paid' : 'pending_payment',
      paidAt: r.paidAt?.toISOString() ?? null,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Cierra el mes: todo lo aprobado sin liquidar hasta ese mes, ya pagado (se
   * paga en efectivo). No se avisa al comercial: lo ve en «Mis comisiones».
   */
  async createSettlement(
    input: CreateSalesSettlementInput,
    byId: string,
  ): Promise<SalesSettlementDto> {
    await this.assertRep(input.repId);
    const items = await this.admin.salesCommissionItem.findMany({
      where: {
        repId: input.repId,
        status: 'approved',
        settlementId: null,
        month: { lte: input.month },
      },
      select: { id: true, amount: true },
    });
    if (items.length === 0) {
      throw new BadRequestException({
        code: 'nothing_to_settle',
        message: 'No hay comisiones aprobadas sin liquidar hasta ese mes',
      });
    }
    const total = round2(items.reduce((s, i) => s + Number(i.amount), 0));
    let settlementId: string;
    try {
      settlementId = await this.admin.$transaction(async (tx) => {
        const settlement = await tx.salesSettlement.create({
          data: {
            repId: input.repId,
            month: input.month,
            total,
            itemsCount: items.length,
            note: input.note?.trim() || null,
            createdById: byId,
            status: 'paid',
            paidAt: new Date(),
            paidById: byId,
          },
        });
        const { count } = await tx.salesCommissionItem.updateMany({
          where: { id: { in: items.map((i) => i.id) }, settlementId: null },
          data: { settlementId: settlement.id },
        });
        if (count !== items.length) {
          throw new ConflictException({
            code: 'settlement_changed',
            message: 'Las comisiones han cambiado mientras se liquidaban: vuelve a intentarlo',
          });
        }
        return settlement.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'settlement_exists',
          message: 'Ya hay una liquidación de ese mes para este comercial',
        });
      }
      throw err;
    }
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.settlement_created',
      targetType: 'super_admin',
      targetId: input.repId,
      changes: { month: input.month, total, items: items.length, paidInCash: true },
    });
    const [dto] = (await this.settlements(input.repId)).filter((s) => s.id === settlementId);
    return dto!;
  }

  async markSettlementPaid(id: string, byId: string): Promise<SalesSettlementDto> {
    const row = await this.admin.salesSettlement.findUnique({ where: { id } });
    if (!row)
      throw new NotFoundException({
        code: 'settlement_not_found',
        message: 'Liquidación no encontrada',
      });
    await this.admin.salesSettlement.update({
      where: { id },
      data: { status: 'paid', paidAt: new Date(), paidById: byId },
    });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.settlement_paid',
      targetType: 'super_admin',
      targetId: row.repId,
      changes: { settlementId: id, total: Number(row.total) },
    });
    const [dto] = (await this.settlements(row.repId)).filter((s) => s.id === id);
    return dto!;
  }

  // ------------------------------------------------------------- resultados

  /** Lo que aporta al mes cada tenant (plan + extras activos). */
  async monthlyByTenant(tenantIds: string[]): Promise<Map<string, number>> {
    if (tenantIds.length === 0) return new Map();
    const [subs, addons] = await Promise.all([
      this.admin.tenantSubscription.findMany({
        where: { tenantId: { in: tenantIds } },
        select: { tenantId: true, plan: { select: { priceMonthly: true } } },
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId: { in: tenantIds }, suspendedAt: null },
        select: { tenantId: true, priceMonthly: true, quantity: true },
      }),
    ]);
    const out = new Map<string, number>();
    for (const s of subs) out.set(s.tenantId, Number(s.plan.priceMonthly));
    for (const a of addons) {
      out.set(a.tenantId, (out.get(a.tenantId) ?? 0) + Number(a.priceMonthly) * a.quantity);
    }
    for (const [k, v] of out) out.set(k, round2(v));
    return out;
  }

  /**
   * Clientes nuevos de cada comercial en el mes (su primer pago fue ese mes, en
   * hora de España, y con él) y lo que aportaban al mes al pagar.
   */
  async monthAchievements(
    month: string,
  ): Promise<Map<string, { newClients: number; newMrr: number }>> {
    await this.ensureWinsOf(month);
    const wins = await this.admin.salesWin.findMany({
      where: { month },
      select: { repId: true, monthly: true },
    });
    const out = new Map<string, { newClients: number; newMrr: number }>();
    for (const w of wins) {
      const cur = out.get(w.repId) ?? { newClients: 0, newMrr: 0 };
      cur.newClients += 1;
      cur.newMrr = round2(cur.newMrr + Number(w.monthly));
      out.set(w.repId, cur);
    }
    return out;
  }

  /** Anota las ventas del mes que aún no estén (el cálculo horario aún no ha pasado). */
  private async ensureWinsOf(month: string): Promise<void> {
    const { from, to } = monthRange(month);
    const rows = await this.admin.$queryRaw<{ tenant_id: string; first_paid: Date }[]>`
      SELECT p.tenant_id, MIN(COALESCE(p.paid_at, p.created_at)) AS first_paid
        FROM tenant_subscription_payments p
       WHERE p.status IN ('paid', 'partially_refunded', 'refunded') AND p.amount > 0
         AND NOT EXISTS (SELECT 1 FROM sales_wins w WHERE w.tenant_id = p.tenant_id)
         AND EXISTS (SELECT 1 FROM sales_assignments a WHERE a.tenant_id = p.tenant_id)
       GROUP BY p.tenant_id
      HAVING MIN(COALESCE(p.paid_at, p.created_at)) >= ${from}
         AND MIN(COALESCE(p.paid_at, p.created_at)) < ${to}
         AND SUM(p.amount - p.refunded_amount) > 0.005`;
    if (rows.length === 0) return;
    const assignments = await this.admin.salesAssignment.findMany({
      where: { tenantId: { in: rows.map((r) => r.tenant_id) } },
      select: { tenantId: true, repId: true, startedAt: true, endedAt: true },
    });
    for (const r of rows) {
      const own = assignments
        .filter((a) => a.tenantId === r.tenant_id)
        .map((a) => ({ repId: a.repId, startedAt: a.startedAt, endedAt: a.endedAt }));
      const repId = repAt(own, r.first_paid);
      if (repId) await this.ensureWin(r.tenant_id, repId, r.first_paid);
    }
  }

  async commissionByRep(month: string): Promise<Map<string, number>> {
    const rows = await this.admin.salesCommissionItem.groupBy({
      by: ['repId'],
      where: { status: 'approved', month },
      _sum: { amount: true },
    });
    return new Map(rows.map((r) => [r.repId, round2(Number(r._sum.amount ?? 0))]));
  }

  // --------------------------------------------------------------- objetivos

  async targets(repId: string, months = 6, now = new Date()): Promise<SalesTargetDto[]> {
    const list: string[] = [];
    const d = new Date(now.getTime());
    for (let i = 0; i < months; i++) {
      list.push(salesMonth(addMonths(d, -i)));
    }
    const rows = await this.admin.salesTarget.findMany({
      where: { repId, month: { in: list } },
    });
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    const out: SalesTargetDto[] = [];
    for (const m of list) {
      const t = byMonth.get(m);
      const achieved = (await this.monthAchievements(m)).get(repId) ?? { newClients: 0, newMrr: 0 };
      if (!t && achieved.newClients === 0) continue;
      out.push({
        month: m,
        newClients: t?.newClients ?? 0,
        newMrr: Number(t?.newMrr ?? 0),
        achieved,
      });
    }
    return out;
  }

  async targetFor(repId: string, month: string): Promise<SalesTargetDto | null> {
    const t = await this.admin.salesTarget.findUnique({
      where: { repId_month: { repId, month } },
    });
    if (!t) return null;
    const achieved = (await this.monthAchievements(month)).get(repId) ?? {
      newClients: 0,
      newMrr: 0,
    };
    return { month, newClients: t.newClients, newMrr: Number(t.newMrr), achieved };
  }

  async upsertTarget(
    repId: string,
    input: UpsertSalesTargetInput,
    byId: string,
  ): Promise<SalesTargetDto[]> {
    await this.assertRep(repId);
    await this.admin.salesTarget.upsert({
      where: { repId_month: { repId, month: input.month } },
      create: { repId, month: input.month, newClients: input.newClients, newMrr: input.newMrr },
      update: { newClients: input.newClients, newMrr: input.newMrr },
    });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.sales.target_saved',
      targetType: 'super_admin',
      targetId: repId,
      changes: { ...input },
    });
    return this.targets(repId);
  }
}
