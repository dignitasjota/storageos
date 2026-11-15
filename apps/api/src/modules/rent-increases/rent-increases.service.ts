import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  earliestRentIncreaseDate,
  RENT_INCREASE_EXCLUSIONS,
  RENT_INCREASE_NOTICE_DEFAULTS,
  RentIncreaseNoticeTemplateSchema,
  rentTax,
  type PreviewRentIncreaseNoticeInput,
  type RentIncreaseNoticePreviewDto,
  type RentIncreaseNoticeTemplate,
  type RentIncreaseNoticeTemplateDto,
  type RentIncreaseResultsDto,
  type CreateRentIncreaseInput,
  type PreviewRentIncreaseInput,
  type RentIncreaseAffectedContract,
  type RentIncreaseDto,
  type RentIncreaseExclusion,
  type RentIncreaseItemDto,
  type RentIncreaseNoticeStatus,
  type RentIncreasePolicyDto,
  type RentIncreasePolicyInput,
  type RentIncreasePreviewDto,
  type RentIncreaseScopeInput,
} from '@storageos/shared';

import { assertAllFacilities } from '../../common/facility-scope';
import { formatDateLong, todayInTimezone } from '../../common/format';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';
import { AuditService } from '../auth/audit.service';
import {
  CustomerEmailsService,
  type SendOutcome,
} from '../customer-emails/customer-emails.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

const round2 = (n: number) => Math.round(n * 100) / 100;
const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

type RentIncreaseRow = Prisma.RentIncreaseGetPayload<object>;
type Tx = Prisma.TransactionClient;

interface Policy {
  maxAnnualPct: number;
  minMonthsBetween: number;
  noticeDays: number;
}

/** Un contrato que entra en la tanda, con todo lo que hace falta para el aviso. */
interface AffectedRow {
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  noEmail: boolean;
  unitCode: string;
  facilityName: string;
  propertyKind: string | null;
  oldPrice: number;
  newPrice: number;
  discount: number;
  effectiveDate: Date;
  prepaid: boolean;
  raisedThisYear: boolean;
}

/**
 * Subidas de precio a la cartera (tandas). Reglas:
 * - Empiezan siempre un día 1 y con el preaviso del negocio (30 días por
 *   defecto, condición 4 del contrato). El aviso sale al programarla.
 * - Quedan fuera los contratos con la baja pedida, los que terminan antes, las
 *   viviendas (se actualizan en su aniversario), los que ya tienen un cambio
 *   de cuota programado y lo que excluye la política (subida reciente, tope
 *   de los últimos 12 meses).
 * - Quien paga por adelantado cambia al empezar su siguiente periodo.
 * - Al llegar la fecha se aplica contrato a contrato; si la cuota cambió desde
 *   el aviso o pidió la baja, ese contrato no se toca.
 */
@Injectable()
export class RentIncreasesService {
  private readonly logger = new Logger(RentIncreasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly customerEmails: CustomerEmailsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- política

  async getPolicy(tenantId: string): Promise<RentIncreasePolicyDto> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: {
        rentIncreaseMaxAnnualPct: true,
        rentIncreaseMinMonthsBetween: true,
        rentIncreaseNoticeDays: true,
      },
    });
    return {
      maxAnnualPct: Number(t?.rentIncreaseMaxAnnualPct ?? 0),
      minMonthsBetween: t?.rentIncreaseMinMonthsBetween ?? 12,
      noticeDays: t?.rentIncreaseNoticeDays ?? 30,
    };
  }

  async updatePolicy(args: {
    tenantId: string;
    userId: string;
    input: RentIncreasePolicyInput;
    facilityScope?: string[] | null;
  }): Promise<RentIncreasePolicyDto> {
    assertAllFacilities(args.facilityScope);
    const { input } = args;
    const data: Prisma.TenantUpdateInput = {};
    if (input.maxAnnualPct !== undefined) data.rentIncreaseMaxAnnualPct = input.maxAnnualPct;
    if (input.minMonthsBetween !== undefined)
      data.rentIncreaseMinMonthsBetween = input.minMonthsBetween;
    if (input.noticeDays !== undefined) data.rentIncreaseNoticeDays = input.noticeDays;
    if (Object.keys(data).length > 0) {
      await this.admin.tenant.update({ where: { id: args.tenantId }, data });
      await this.audit.write({
        tenantId: args.tenantId,
        userId: args.userId,
        action: 'rent_increase.policy_changed',
        entityType: 'Tenant',
        entityId: args.tenantId,
        changes: { ...input },
      });
    }
    return this.getPolicy(args.tenantId);
  }

  // ------------------------------------------------------- quién entra y cómo

  /**
   * ¿El usuario (con `facilityScope`) puede operar sobre una tanda con este
   * alcance? Una tanda sin local afecta a toda la empresa: queda fuera para
   * quien solo ve algunos locales.
   */
  private assertScopeInFacility(
    facilityScope: string[] | null | undefined,
    scope: { facilityId?: string | undefined },
  ): void {
    if (!facilityScope) return;
    if (!scope.facilityId || !facilityScope.includes(scope.facilityId)) {
      throw new ForbiddenException({
        code: 'facility_not_in_scope',
        message: 'No tienes acceso a ese local',
      });
    }
  }

  private computeNewPrice(oldPrice: number, type: string, value: number): number {
    return round2(type === 'percentage' ? oldPrice * (1 + value / 100) : oldPrice + value);
  }

  /** Contratos del alcance: los que entran (con su cuota y fecha) y los que no, por motivo. */
  private async resolveAffected(
    tx: Tx,
    tenantId: string,
    args: {
      scope: RentIncreaseScopeInput;
      type: string;
      value: number;
      effectiveDate: Date;
      /** Quitados a mano al repasar la lista. */
      excludeContractIds?: string[];
    },
    policy: Policy,
  ): Promise<{ affected: AffectedRow[]; excluded: Map<RentIncreaseExclusion, number> }> {
    const { scope } = args;
    const now = new Date();
    const signedCutoff =
      scope.minMonthsSinceSigned > 0 ? addMonths(now, -scope.minMonthsSinceSigned) : null;
    const contracts = await tx.contract.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { in: ['active', 'ending'] },
        signedAt: { not: null, ...(signedCutoff ? { lte: signedCutoff } : {}) },
        customer: { isTest: false },
        ...STARTED_CONTRACT_WHERE,
        ...(scope.facilityId || scope.unitTypeId
          ? {
              unit: {
                ...(scope.facilityId ? { facilityId: scope.facilityId } : {}),
                ...(scope.unitTypeId ? { unitTypeId: scope.unitTypeId } : {}),
              },
            }
          : {}),
      },
      select: {
        id: true,
        contractNumber: true,
        status: true,
        priceMonthly: true,
        discountAmount: true,
        endDate: true,
        autoRenew: true,
        startDate: true,
        billingStartsOn: true,
        billingIntervalMonths: true,
        scheduledPrice: true,
        rentIncreaseExemptUntil: true,
        customerId: true,
        customer: {
          select: {
            customerType: true,
            firstName: true,
            lastName: true,
            companyName: true,
            email: true,
          },
        },
        unit: {
          select: {
            code: true,
            basePriceMonthly: true,
            facility: { select: { name: true } },
            unitType: { select: { propertyKind: true } },
          },
        },
      },
      orderBy: { contractNumber: 'asc' },
    });
    const ids = contracts.map((c) => c.id);
    const windowMonths = Math.max(12, policy.minMonthsBetween);
    const [pending, events, prepaidInvoices] = await Promise.all([
      tx.rentIncreaseItem.findMany({
        where: {
          contractId: { in: ids },
          status: 'pending',
          rentIncrease: { status: 'scheduled' },
        },
        select: { contractId: true },
      }),
      tx.contractEvent.findMany({
        where: {
          contractId: { in: ids },
          eventType: 'price_changed',
          occurredAt: { gte: addMonths(now, -windowMonths) },
        },
        select: { contractId: true, payload: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      }),
      tx.invoice.findMany({
        where: {
          contractId: {
            in: contracts.filter((c) => c.billingIntervalMonths > 1).map((c) => c.id),
          },
          kind: 'invoice',
          status: { not: 'cancelled' },
          deletedAt: null,
          periodEnd: { not: null },
        },
        select: { contractId: true, periodEnd: true },
        orderBy: { periodEnd: 'desc' },
      }),
    ]);
    const scheduledInBatch = new Set(pending.map((p) => p.contractId));
    const eventsBy = new Map<string, { from: number; to: number; at: Date }[]>();
    for (const e of events) {
      const p = (e.payload ?? {}) as { from?: unknown; to?: unknown };
      const from = Number(p.from);
      const to = Number(p.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const list = eventsBy.get(e.contractId) ?? [];
      list.push({ from, to, at: e.occurredAt });
      eventsBy.set(e.contractId, list);
    }
    const lastPaidEnd = new Map<string, Date>();
    for (const i of prepaidInvoices) {
      if (i.contractId && i.periodEnd && !lastPaidEnd.has(i.contractId)) {
        lastPaidEnd.set(i.contractId, i.periodEnd);
      }
    }

    const yearAgo = addMonths(now, -12);
    const raiseCutoff =
      policy.minMonthsBetween > 0 ? addMonths(now, -policy.minMonthsBetween) : null;
    const excluded = new Map<RentIncreaseExclusion, number>();
    const exclude = (r: RentIncreaseExclusion) => excluded.set(r, (excluded.get(r) ?? 0) + 1);
    const affected: AffectedRow[] = [];
    const removed = new Set(args.excludeContractIds ?? []);
    for (const c of contracts) {
      if (removed.has(c.id)) continue;
      if (c.rentIncreaseExemptUntil && c.rentIncreaseExemptUntil >= args.effectiveDate) {
        exclude('exempt');
        continue;
      }
      if (c.status === 'ending') {
        exclude('ending');
        continue;
      }
      if (c.endDate && !c.autoRenew && c.endDate < args.effectiveDate) {
        exclude('leaving_before');
        continue;
      }
      if (c.unit.unitType?.propertyKind === 'housing') {
        exclude('housing');
        continue;
      }
      if (c.scheduledPrice != null || scheduledInBatch.has(c.id)) {
        exclude('already_scheduled');
        continue;
      }
      const changes = eventsBy.get(c.id) ?? [];
      const raises = changes.filter((e) => e.to > e.from);
      if (raiseCutoff && raises.some((e) => e.at >= raiseCutoff)) {
        exclude('recently_raised');
        continue;
      }
      const oldPrice = Number(c.priceMonthly);
      let newPrice: number;
      if (args.type === 'to_list_price') {
        // Hasta el precio de tarifa de su trastero, con un máximo de % por vez.
        const listPrice = Number(c.unit.basePriceMonthly);
        newPrice = round2(Math.min(listPrice, oldPrice * (1 + args.value / 100)));
        if (newPrice <= oldPrice) {
          exclude('at_list_price');
          continue;
        }
      } else {
        newPrice = this.computeNewPrice(oldPrice, args.type, args.value);
      }
      if (policy.maxAnnualPct > 0) {
        // Tope sobre la cuota que tenía hace 12 meses (cuentan todas las subidas).
        const first = changes.find((e) => e.at >= yearAgo);
        const base = first ? first.from : oldPrice;
        newPrice = Math.min(newPrice, round2(base * (1 + policy.maxAnnualPct / 100)));
        if (newPrice <= oldPrice) {
          exclude('cap_reached');
          continue;
        }
      }
      let effectiveDate = args.effectiveDate;
      const prepaid = c.billingIntervalMonths > 1;
      if (prepaid) {
        // Cambia al empezar su siguiente periodo pagado (el primero desde la fecha).
        const paidEnd = lastPaidEnd.get(c.id);
        let next = paidEnd ? addDays(paidEnd, 1) : (c.billingStartsOn ?? c.startDate);
        let guard = 0;
        while (next < args.effectiveDate && guard < 240) {
          next = addMonths(next, c.billingIntervalMonths);
          guard += 1;
        }
        effectiveDate = next;
      }
      affected.push({
        contractId: c.id,
        contractNumber: c.contractNumber,
        customerId: c.customerId,
        customerName: customerName(c.customer),
        noEmail: !c.customer.email,
        unitCode: c.unit.code,
        facilityName: c.unit.facility.name,
        propertyKind: c.unit.unitType?.propertyKind ?? null,
        oldPrice,
        newPrice,
        discount: Number(c.discountAmount),
        effectiveDate,
        prepaid,
        raisedThisYear: raises.some((e) => e.at >= yearAgo),
      });
    }
    return { affected, excluded };
  }

  private excludedList(m: Map<RentIncreaseExclusion, number>): RentIncreasePreviewDto['excluded'] {
    return RENT_INCREASE_EXCLUSIONS.filter((r) => (m.get(r) ?? 0) > 0).map((reason) => ({
      reason,
      count: m.get(reason) ?? 0,
    }));
  }

  private todayYmd(): string {
    return ymd(todayInTimezone('Europe/Madrid'));
  }

  async preview(
    tenantId: string,
    input: PreviewRentIncreaseInput,
    facilityScope?: string[] | null,
  ): Promise<RentIncreasePreviewDto> {
    this.assertScopeInFacility(facilityScope, input.scope);
    const policy = await this.getPolicy(tenantId);
    const earliestDate = earliestRentIncreaseDate(this.todayYmd(), policy.noticeDays);
    const date = input.effectiveDate ?? earliestDate;
    const { affected, excluded } = await this.prisma.withTenant(
      (tx) =>
        this.resolveAffected(
          tx,
          tenantId,
          {
            scope: input.scope,
            type: input.increaseType,
            value: input.increaseValue,
            effectiveDate: new Date(`${date}T00:00:00Z`),
          },
          policy,
        ),
      tenantId,
    );
    const contracts: RentIncreaseAffectedContract[] = affected.map((a) => ({
      contractId: a.contractId,
      contractNumber: a.contractNumber,
      customerName: a.customerName,
      unitCode: a.unitCode,
      oldPrice: a.oldPrice,
      newPrice: a.newPrice,
      effectiveDate: ymd(a.effectiveDate),
      raisedThisYear: a.raisedThisYear,
      noEmail: a.noEmail,
    }));
    return {
      affectedCount: affected.length,
      mrrDelta: round2(affected.reduce((s, a) => s + (a.newPrice - a.oldPrice), 0)),
      contracts,
      excluded: this.excludedList(excluded),
      raisedThisYear: affected.filter((a) => a.raisedThisYear).length,
      noEmail: affected.filter((a) => a.noEmail).length,
      earliestDate,
      noticeDays: policy.noticeDays,
    };
  }

  // ---------------------------------------------------------------- programar

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateRentIncreaseInput;
    facilityScope?: string[] | null;
  }): Promise<RentIncreaseDto> {
    const { tenantId, input } = args;
    this.assertScopeInFacility(args.facilityScope, input.scope);
    const policy = await this.getPolicy(tenantId);
    const earliest = earliestRentIncreaseDate(this.todayYmd(), policy.noticeDays);
    if (input.effectiveDate < earliest) {
      throw new BadRequestException({
        code: 'notice_too_short',
        message: `Con ${policy.noticeDays} días de preaviso, la primera fecha posible es el ${formatDateLong(new Date(`${earliest}T12:00:00Z`))}`,
        details: { minDate: earliest, noticeDays: policy.noticeDays },
      });
    }
    const effectiveDate = new Date(`${input.effectiveDate}T00:00:00Z`);

    const { created, affected } = await this.prisma.withTenant(
      async (tx) => {
        // Dos tandas a la vez no pueden coger el mismo contrato.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rent_increase:${tenantId}`}))`;
        const { affected } = await this.resolveAffected(
          tx,
          tenantId,
          {
            scope: input.scope,
            type: input.increaseType,
            value: input.increaseValue,
            effectiveDate,
            ...(input.excludeContractIds ? { excludeContractIds: input.excludeContractIds } : {}),
          },
          policy,
        );
        if (affected.length === 0) {
          throw new BadRequestException({
            code: 'no_contracts_affected',
            message: 'Ningún contrato cumple los criterios seleccionados',
          });
        }
        const created = await tx.rentIncrease.create({
          data: {
            tenantId,
            name: input.name,
            scope: input.scope as Prisma.InputJsonValue,
            increaseType: input.increaseType,
            increaseValue: input.increaseValue,
            effectiveDate,
            status: 'scheduled',
            affectedCount: affected.length,
            mrrDelta: round2(affected.reduce((s, a) => s + (a.newPrice - a.oldPrice), 0)),
            createdByUserId: args.userId,
            items: {
              create: affected.map((a) => ({
                tenantId,
                contractId: a.contractId,
                oldPrice: a.oldPrice,
                newPrice: a.newPrice,
                effectiveDate: a.effectiveDate,
                status: 'pending',
              })),
            },
          },
          include: { items: { select: { id: true, contractId: true } } },
        });
        return { created, affected };
      },
      tenantId,
      { timeout: 30_000 },
    );

    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'rent_increase.created',
      entityType: 'RentIncrease',
      entityId: created.id,
      changes: {
        name: input.name,
        increaseType: input.increaseType,
        increaseValue: input.increaseValue,
        effectiveDate: input.effectiveDate,
        contracts: affected.length,
      },
    });

    // Preaviso a cada inquilino (con IVA, en su idioma, con el texto del negocio y en su ficha).
    const template = await this.noticeTemplate(tenantId);
    const itemOf = new Map(created.items.map((i) => [i.contractId, i.id]));
    let noticeSent = false;
    for (const a of affected) {
      const { taxRate } = rentTax(a.propertyKind);
      const withVat = (p: number) => round2(Math.max(0, p - a.discount) * (1 + taxRate / 100));
      const outcome = await this.customerEmails.sendRentIncreaseMail({
        tenantId,
        customerId: a.customerId,
        contractId: a.contractId,
        data: {
          kind: 'rent_increase_notice',
          contractNumber: a.contractNumber,
          unitCode: a.unitCode,
          facilityName: a.facilityName,
          oldMonthlyWithVat: withVat(a.oldPrice),
          newMonthlyWithVat: withVat(a.newPrice),
          effectiveDate: a.effectiveDate,
          prepaid: a.prepaid,
          template,
        },
      });
      if (outcome.status === 'sent') noticeSent = true;
      await this.recordNotice(tenantId, itemOf.get(a.contractId)!, outcome);
    }
    if (noticeSent) {
      await this.prisma.withTenant(
        (tx) => tx.rentIncrease.update({ where: { id: created.id }, data: { noticeSent: true } }),
        tenantId,
      );
    }
    return this.detail(tenantId, created.id);
  }

  private async recordNotice(tenantId: string, itemId: string, outcome: SendOutcome) {
    const status: RentIncreaseNoticeStatus =
      outcome.status === 'sent' ? 'sent' : outcome.status === 'no_email' ? 'no_email' : 'failed';
    await this.prisma.withTenant(
      (tx) =>
        tx.rentIncreaseItem.update({
          where: { id: itemId },
          data: {
            noticeStatus: status,
            noticeSentAt: outcome.status === 'sent' ? new Date() : null,
            noticeCommunicationId: outcome.status === 'sent' ? outcome.communicationId : null,
          },
        }),
      tenantId,
    );
  }

  // ----------------------------------------------------------------- aplicar

  /**
   * Aplica los contratos de la tanda cuya fecha ya llegó. Cada contrato se
   * reserva antes de tocarlo: dos procesos a la vez no lo suben dos veces.
   */
  private async applyDueItems(
    tenantId: string,
    batchId: string,
    today: Date,
    userId: string | null,
  ): Promise<{ applied: number; skipped: number }> {
    const due = await this.admin.rentIncreaseItem.findMany({
      where: {
        tenantId,
        rentIncreaseId: batchId,
        status: 'pending',
        effectiveDate: { lte: today },
      },
      select: { id: true },
    });
    let applied = 0;
    let skipped = 0;
    for (const { id } of due) {
      const result = await this.prisma.withTenant(async (tx) => {
        const claimed = await tx.rentIncreaseItem.updateMany({
          where: { id, status: 'pending' },
          data: { status: 'applied', appliedAt: new Date() },
        });
        if (claimed.count === 0) return null;
        const item = await tx.rentIncreaseItem.findUniqueOrThrow({
          where: { id },
          include: {
            contract: { select: { status: true, priceMonthly: true, deletedAt: true } },
          },
        });
        const c = item.contract;
        const skip =
          !c || c.deletedAt || (c.status !== 'active' && c.status !== 'ending')
            ? 'contract_not_active'
            : c.status === 'ending'
              ? 'contract_ending'
              : !sameAmount(Number(c.priceMonthly), Number(item.oldPrice))
                ? 'price_changed'
                : null;
        if (skip) {
          await tx.rentIncreaseItem.update({
            where: { id },
            data: { status: 'skipped', skipReason: skip, appliedAt: null },
          });
          return 'skipped' as const;
        }
        await tx.contract.update({
          where: { id: item.contractId },
          data: { priceMonthly: item.newPrice },
        });
        await tx.contractEvent.create({
          data: {
            tenantId,
            contractId: item.contractId,
            eventType: 'price_changed',
            payload: {
              from: Number(item.oldPrice),
              to: Number(item.newPrice),
              reason: `rent_increase:${batchId}`,
            },
            createdByUserId: userId,
          },
        });
        return 'applied' as const;
      }, tenantId);
      if (result === 'applied') applied += 1;
      if (result === 'skipped') skipped += 1;
    }

    const [pendingLeft, appliedTotal] = await Promise.all([
      this.admin.rentIncreaseItem.count({ where: { rentIncreaseId: batchId, status: 'pending' } }),
      this.admin.rentIncreaseItem.count({ where: { rentIncreaseId: batchId, status: 'applied' } }),
    ]);
    await this.admin.rentIncrease.update({
      where: { id: batchId },
      data: { appliedCount: appliedTotal },
    });
    if (pendingLeft === 0) {
      await this.admin.rentIncrease.updateMany({
        where: { id: batchId, status: 'scheduled' },
        data: { status: 'applied', appliedAt: new Date() },
      });
    }
    if (applied + skipped > 0) {
      await this.audit.write({
        tenantId,
        userId,
        action: 'rent_increase.applied',
        entityType: 'RentIncrease',
        entityId: batchId,
        changes: { applied, skipped },
      });
    }
    if (skipped > 0) {
      const batch = await this.admin.rentIncrease.findUnique({
        where: { id: batchId },
        select: { name: true },
      });
      await this.admin.notification
        .create({
          data: {
            tenantId,
            type: 'rent_increase.skipped',
            title: `${skipped} ${skipped === 1 ? 'contrato no se ha subido' : 'contratos no se han subido'}`,
            body: `En la tanda «${batch?.name ?? ''}»: su cuota cambió después del aviso, pidieron la baja o el contrato ya no está en vigor. Revísalo en Subidas de precio.`,
            link: '/rent-increases',
          },
        })
        .catch(() => undefined);
    }
    return { applied, skipped };
  }

  /**
   * Aplica ya los contratos de la tanda cuya fecha ha llegado (si el proceso
   * diario no lo hizo). Nunca antes: el inquilino tiene avisado ese día.
   */
  async apply(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
    userId: string | null = null,
  ): Promise<RentIncreaseDto> {
    const increase = await this.findRow(tenantId, id, facilityScope);
    if (increase.status === 'cancelled') {
      throw new BadRequestException({
        code: 'rent_increase_cancelled',
        message: 'La tanda está cancelada',
      });
    }
    const today = todayInTimezone('Europe/Madrid');
    const [due, next] = await Promise.all([
      this.admin.rentIncreaseItem.count({
        where: { rentIncreaseId: id, status: 'pending', effectiveDate: { lte: today } },
      }),
      this.admin.rentIncreaseItem.findFirst({
        where: { rentIncreaseId: id, status: 'pending' },
        orderBy: { effectiveDate: 'asc' },
        select: { effectiveDate: true },
      }),
    ]);
    if (due === 0) {
      if (next) {
        throw new BadRequestException({
          code: 'rent_increase_not_due',
          message: `Se aplica sola el ${formatDateLong(new Date(`${ymd(next.effectiveDate)}T12:00:00Z`))}: es la fecha que tienen avisada los inquilinos`,
          details: { date: ymd(next.effectiveDate) },
        });
      }
      return this.detail(tenantId, id, facilityScope);
    }
    await this.applyDueItems(tenantId, id, today, userId);
    return this.detail(tenantId, id, facilityScope);
  }

  /**
   * Proceso diario (antes de facturar): aplica lo que toca en todos los
   * negocios en marcha. Los suspendidos o dados de baja esperan.
   */
  async applyDue(reference: Date = new Date()): Promise<{ applied: number }> {
    const today = todayInTimezone('Europe/Madrid', reference);
    const due = await this.admin.rentIncrease.findMany({
      where: {
        status: 'scheduled',
        tenant: { deletedAt: null, status: { in: ['trial', 'active'] } },
        items: { some: { status: 'pending', effectiveDate: { lte: today } } },
      },
      select: { id: true, tenantId: true, name: true },
      take: 200,
    });
    let applied = 0;
    for (const ri of due) {
      try {
        const res = await this.applyDueItems(ri.tenantId, ri.id, today, null);
        applied += res.applied;
      } catch (err) {
        this.logger.error(
          `[rent-increase] aplicar ${ri.id} falló: ${err instanceof Error ? err.message : err}`,
        );
        await this.admin.notification
          .create({
            data: {
              tenantId: ri.tenantId,
              type: 'rent_increase.apply_failed',
              title: 'Una subida de precio no se ha podido aplicar',
              body: `La tanda «${ri.name}» no se ha aplicado. Ábrela en Subidas de precio y pulsa «Aplicar ahora».`,
              link: '/rent-increases',
            },
          })
          .catch(() => undefined);
      }
    }
    return { applied };
  }

  // ---------------------------------------------------------------- cancelar

  /**
   * Cancela lo que queda por aplicar de una tanda y avisa a quien tenía el
   * preaviso de que ya no va. Si parte ya se aplicó, la tanda queda aplicada.
   */
  async cancel(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
    userId: string | null = null,
  ): Promise<RentIncreaseDto> {
    const increase = await this.findRow(tenantId, id, facilityScope);
    if (increase.status !== 'scheduled') {
      throw new BadRequestException({
        code: 'rent_increase_not_cancellable',
        message: 'Solo se puede cancelar una tanda programada',
      });
    }
    const cancelled = await this.prisma.withTenant(async (tx) => {
      const pending = await tx.rentIncreaseItem.findMany({
        where: { rentIncreaseId: id, status: 'pending' },
        select: {
          id: true,
          effectiveDate: true,
          noticeStatus: true,
          contract: {
            select: {
              id: true,
              contractNumber: true,
              customerId: true,
              priceMonthly: true,
              discountAmount: true,
              unit: {
                select: {
                  code: true,
                  facility: { select: { name: true } },
                  unitType: { select: { propertyKind: true } },
                },
              },
            },
          },
        },
      });
      const done = await tx.rentIncreaseItem.updateMany({
        where: { id: { in: pending.map((p) => p.id) }, status: 'pending' },
        data: { status: 'skipped', skipReason: 'cancelled' },
      });
      const applied = await tx.rentIncreaseItem.count({
        where: { rentIncreaseId: id, status: 'applied' },
      });
      await tx.rentIncrease.update({
        where: { id },
        data: {
          status: applied > 0 ? 'applied' : 'cancelled',
          cancelledAt: new Date(),
          ...(applied > 0 ? { appliedAt: new Date() } : {}),
        },
      });
      return done.count > 0 ? pending : [];
    }, tenantId);

    await this.audit.write({
      tenantId,
      userId,
      action: 'rent_increase.cancelled',
      entityType: 'RentIncrease',
      entityId: id,
      changes: { contracts: cancelled.length },
    });
    for (const p of cancelled) {
      if (p.noticeStatus !== 'sent' || !p.contract) continue;
      const c = p.contract;
      const { taxRate } = rentTax(c.unit.unitType?.propertyKind);
      const monthly = Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount));
      await this.customerEmails.sendRentIncreaseMail({
        tenantId,
        customerId: c.customerId,
        contractId: c.id,
        data: {
          kind: 'rent_increase_cancelled',
          contractNumber: c.contractNumber,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          monthlyWithVat: round2(monthly * (1 + taxRate / 100)),
          effectiveDate: p.effectiveDate,
        },
      });
    }
    return this.detail(tenantId, id, facilityScope);
  }

  // --------------------------------------------------------- texto del aviso

  private async noticeTemplate(tenantId: string): Promise<RentIncreaseNoticeTemplate | null> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { rentIncreaseNoticeTemplate: true },
    });
    const parsed = RentIncreaseNoticeTemplateSchema.safeParse(t?.rentIncreaseNoticeTemplate);
    return parsed.success ? parsed.data : null;
  }

  async getNoticeTemplate(tenantId: string): Promise<RentIncreaseNoticeTemplateDto> {
    return {
      template: await this.noticeTemplate(tenantId),
      defaults: {
        es: { ...RENT_INCREASE_NOTICE_DEFAULTS.es },
        en: { ...RENT_INCREASE_NOTICE_DEFAULTS.en },
      },
    };
  }

  async updateNoticeTemplate(args: {
    tenantId: string;
    userId: string;
    template: RentIncreaseNoticeTemplate | null;
    facilityScope?: string[] | null;
  }): Promise<RentIncreaseNoticeTemplateDto> {
    assertAllFacilities(args.facilityScope);
    await this.admin.tenant.update({
      where: { id: args.tenantId },
      data: {
        rentIncreaseNoticeTemplate: args.template
          ? (args.template as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'rent_increase.notice_template_changed',
      entityType: 'Tenant',
      entityId: args.tenantId,
      changes: { custom: !!args.template },
    });
    return this.getNoticeTemplate(args.tenantId);
  }

  /** Cómo le llegará el aviso (a un inquilino concreto o con datos de ejemplo). */
  async previewNotice(
    tenantId: string,
    input: PreviewRentIncreaseNoticeInput,
  ): Promise<RentIncreaseNoticePreviewDto> {
    const template =
      input.template === undefined ? await this.noticeTemplate(tenantId) : input.template;
    const policy = await this.getPolicy(tenantId);
    const date =
      input.effectiveDate ?? earliestRentIncreaseDate(this.todayYmd(), policy.noticeDays);
    const contractId = input.contractId;
    const contract = contractId
      ? await this.prisma.withTenant(
          (tx) =>
            tx.contract.findFirst({
              where: { id: contractId, deletedAt: null },
              select: {
                customerId: true,
                contractNumber: true,
                priceMonthly: true,
                discountAmount: true,
                billingIntervalMonths: true,
                unit: {
                  select: {
                    code: true,
                    facility: { select: { name: true } },
                    unitType: { select: { propertyKind: true } },
                  },
                },
              },
            }),
          tenantId,
        )
      : null;
    const facility = contract
      ? null
      : await this.admin.facility.findFirst({
          where: { tenantId, deletedAt: null },
          select: { name: true },
        });
    const old = contract ? Number(contract.priceMonthly) : 60;
    const discount = contract ? Number(contract.discountAmount) : 0;
    const next = input.newPrice ?? round2(old * 1.05);
    const { taxRate } = rentTax(contract?.unit.unitType?.propertyKind);
    const withVat = (p: number) => round2(Math.max(0, p - discount) * (1 + taxRate / 100));
    return this.customerEmails.previewRentIncreaseNotice({
      tenantId,
      customerId: contract?.customerId ?? null,
      locale: input.locale,
      data: {
        kind: 'rent_increase_notice',
        contractNumber: contract?.contractNumber ?? 'CT-2027-00001',
        unitCode: contract?.unit.code ?? 'A-12',
        facilityName: contract?.unit.facility.name ?? facility?.name ?? 'Tu local',
        oldMonthlyWithVat: withVat(old),
        newMonthlyWithVat: withVat(next),
        effectiveDate: new Date(`${date}T00:00:00Z`),
        prepaid: (contract?.billingIntervalMonths ?? 1) > 1,
        template,
      },
    });
  }

  // ------------------------------------------------- contratos de una tanda

  /** Datos del aviso de un contrato de la tanda (para reenviarlo o anularlo). */
  private async itemForNotice(tenantId: string, rentIncreaseId: string, itemId: string) {
    const item = await this.prisma.withTenant(
      (tx) =>
        tx.rentIncreaseItem.findFirst({
          where: { id: itemId, rentIncreaseId },
          include: {
            rentIncrease: { select: { status: true } },
            contract: {
              select: {
                id: true,
                contractNumber: true,
                customerId: true,
                priceMonthly: true,
                discountAmount: true,
                billingIntervalMonths: true,
                unit: {
                  select: {
                    code: true,
                    facility: { select: { name: true } },
                    unitType: { select: { propertyKind: true } },
                  },
                },
              },
            },
          },
        }),
      tenantId,
    );
    if (!item) {
      throw new NotFoundException({
        code: 'rent_increase_item_not_found',
        message: 'Ese contrato no está en esta subida',
      });
    }
    return item;
  }

  /** Quita un contrato de una subida aún sin aplicar y, si tenía el aviso, se le dice. */
  async removeItem(args: {
    tenantId: string;
    rentIncreaseId: string;
    itemId: string;
    userId: string;
    facilityScope?: string[] | null;
  }): Promise<RentIncreaseDto> {
    await this.findRow(args.tenantId, args.rentIncreaseId, args.facilityScope);
    const item = await this.itemForNotice(args.tenantId, args.rentIncreaseId, args.itemId);
    const done = await this.admin.rentIncreaseItem.updateMany({
      where: { id: item.id, status: 'pending' },
      data: { status: 'skipped', skipReason: 'removed' },
    });
    if (done.count === 0) {
      throw new BadRequestException({
        code: 'rent_increase_item_not_pending',
        message: 'Ese contrato ya no está pendiente en esta subida',
      });
    }
    await this.finishIfEmpty(args.rentIncreaseId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'rent_increase.contract_removed',
      entityType: 'RentIncrease',
      entityId: args.rentIncreaseId,
      changes: { contractId: item.contractId },
    });
    const c = item.contract;
    if (item.noticeStatus === 'sent' && c) {
      const { taxRate } = rentTax(c.unit.unitType?.propertyKind);
      await this.customerEmails.sendRentIncreaseMail({
        tenantId: args.tenantId,
        customerId: c.customerId,
        contractId: c.id,
        data: {
          kind: 'rent_increase_cancelled',
          contractNumber: c.contractNumber,
          unitCode: c.unit.code,
          facilityName: c.unit.facility.name,
          monthlyWithVat: round2(
            Math.max(0, Number(c.priceMonthly) - Number(c.discountAmount)) * (1 + taxRate / 100),
          ),
          effectiveDate: item.effectiveDate,
        },
      });
    }
    return this.detail(args.tenantId, args.rentIncreaseId, args.facilityScope);
  }

  /** Vuelve a enviar el aviso a un contrato pendiente (p. ej. tras corregir su email). */
  async resendNotice(args: {
    tenantId: string;
    rentIncreaseId: string;
    itemId: string;
    facilityScope?: string[] | null;
  }): Promise<RentIncreaseDto> {
    await this.findRow(args.tenantId, args.rentIncreaseId, args.facilityScope);
    const item = await this.itemForNotice(args.tenantId, args.rentIncreaseId, args.itemId);
    if (item.status !== 'pending' || item.rentIncrease.status !== 'scheduled' || !item.contract) {
      throw new BadRequestException({
        code: 'rent_increase_item_not_pending',
        message: 'Ese contrato ya no está pendiente en esta subida',
      });
    }
    const c = item.contract;
    const { taxRate } = rentTax(c.unit.unitType?.propertyKind);
    const discount = Number(c.discountAmount);
    const withVat = (p: number) => round2(Math.max(0, p - discount) * (1 + taxRate / 100));
    const outcome = await this.customerEmails.sendRentIncreaseMail({
      tenantId: args.tenantId,
      customerId: c.customerId,
      contractId: c.id,
      data: {
        kind: 'rent_increase_notice',
        contractNumber: c.contractNumber,
        unitCode: c.unit.code,
        facilityName: c.unit.facility.name,
        oldMonthlyWithVat: withVat(Number(item.oldPrice)),
        newMonthlyWithVat: withVat(Number(item.newPrice)),
        effectiveDate: item.effectiveDate,
        prepaid: c.billingIntervalMonths > 1,
        template: await this.noticeTemplate(args.tenantId),
      },
    });
    await this.recordNotice(args.tenantId, item.id, outcome);
    if (outcome.status === 'no_email') {
      throw new BadRequestException({
        code: 'customer_without_email',
        message: 'El inquilino no tiene email: añádelo en su ficha o avísale por otro medio',
      });
    }
    return this.detail(args.tenantId, args.rentIncreaseId, args.facilityScope);
  }

  /** Sin contratos pendientes: aplicada si se subió alguno, cancelada si no. */
  private async finishIfEmpty(rentIncreaseId: string): Promise<void> {
    const [pending, applied] = await Promise.all([
      this.admin.rentIncreaseItem.count({ where: { rentIncreaseId, status: 'pending' } }),
      this.admin.rentIncreaseItem.count({ where: { rentIncreaseId, status: 'applied' } }),
    ]);
    if (pending > 0) return;
    await this.admin.rentIncrease.updateMany({
      where: { id: rentIncreaseId, status: 'scheduled' },
      data:
        applied > 0
          ? { status: 'applied', appliedAt: new Date(), appliedCount: applied }
          : { status: 'cancelled', cancelledAt: new Date() },
    });
  }

  /**
   * Qué ha dado la subida: lo que se cobra de más ahora, lo ya facturado de
   * más y quién se fue (o pidió la baja) después del aviso.
   */
  async results(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<RentIncreaseResultsDto> {
    const row = await this.findRow(tenantId, id, facilityScope);
    return this.prisma.withTenant(async (tx) => {
      const items = await tx.rentIncreaseItem.findMany({
        where: { rentIncreaseId: id },
        include: {
          contract: {
            select: {
              id: true,
              contractNumber: true,
              status: true,
              endDate: true,
              endingRequestedAt: true,
              endedAt: true,
              cancelledAt: true,
              customer: {
                select: { customerType: true, firstName: true, lastName: true, companyName: true },
              },
              unit: { select: { code: true } },
            },
          },
        },
      });
      const appliedItems = items.filter((i) => i.status === 'applied');
      const invoices = await tx.invoice.findMany({
        where: {
          contractId: { in: appliedItems.map((i) => i.contractId) },
          kind: 'invoice',
          status: { notIn: ['draft', 'cancelled'] },
          deletedAt: null,
          periodStart: { not: null },
          periodEnd: { not: null },
        },
        select: { contractId: true, periodStart: true, periodEnd: true },
      });
      let extraInvoiced = 0;
      for (const it of appliedItems) {
        const delta = Number(it.newPrice) - Number(it.oldPrice);
        for (const inv of invoices) {
          if (inv.contractId !== it.contractId || inv.periodStart! < it.effectiveDate) continue;
          const days = (inv.periodEnd!.getTime() - inv.periodStart!.getTime()) / 86_400_000 + 1;
          extraInvoiced += delta * Math.max(1, Math.round(days / 30.44));
        }
      }
      const live = (status: string | undefined) => status === 'active' || status === 'ending';
      const leftAt = (c: (typeof items)[number]['contract']) =>
        c.endingRequestedAt ?? c.endedAt ?? c.cancelledAt ?? null;
      const left = items.filter((i) => {
        const at = i.contract ? leftAt(i.contract) : null;
        return !!at && at >= row.createdAt;
      });
      return {
        applied: appliedItems.length,
        skipped: items.filter((i) => i.status === 'skipped').length,
        pending: items.filter((i) => i.status === 'pending').length,
        plannedMonthly: Number(row.mrrDelta),
        realMonthly: round2(
          appliedItems
            .filter((i) => live(i.contract?.status))
            .reduce((sum, i) => sum + Number(i.newPrice) - Number(i.oldPrice), 0),
        ),
        extraInvoiced: round2(extraInvoiced),
        lostMonthly: round2(left.reduce((sum, i) => sum + Number(i.oldPrice), 0)),
        left: left.map((i) => ({
          contractId: i.contractId,
          contractNumber: i.contract.contractNumber,
          customerName: customerName(i.contract.customer),
          unitCode: i.contract.unit.code,
          endDate: i.contract.endDate ? ymd(i.contract.endDate) : null,
          requestedAt: leftAt(i.contract)?.toISOString() ?? null,
        })),
      };
    }, tenantId);
  }

  // ------------------------------------------------------------------ lectura

  async list(tenantId: string, facilityScope?: string[] | null): Promise<RentIncreaseDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.rentIncrease.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
      tenantId,
    );
    const visible = facilityScope
      ? rows.filter((r) => {
          const scope = (r.scope as RentIncreaseScopeInput | null) ?? null;
          return !!scope?.facilityId && facilityScope.includes(scope.facilityId);
        })
      : rows;
    return visible.map((r) => this.toDto(r));
  }

  async detail(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<RentIncreaseDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.rentIncrease.findFirst({
          where: { id, tenantId },
          include: {
            items: {
              orderBy: [{ effectiveDate: 'asc' }, { oldPrice: 'desc' }],
              include: {
                noticeCommunication: { select: { status: true } },
                contract: {
                  select: {
                    contractNumber: true,
                    customer: {
                      select: {
                        customerType: true,
                        firstName: true,
                        lastName: true,
                        companyName: true,
                      },
                    },
                    unit: { select: { code: true } },
                  },
                },
              },
            },
          },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'rent_increase_not_found',
        message: 'Tanda no encontrada',
      });
    }
    this.assertScopeInFacility(facilityScope, (row.scope as RentIncreaseScopeInput | null) ?? {});
    const items: RentIncreaseItemDto[] = row.items.map((it) => ({
      id: it.id,
      contractId: it.contractId,
      contractNumber: it.contract?.contractNumber ?? '',
      customerName: it.contract ? customerName(it.contract.customer) : '',
      unitCode: it.contract?.unit.code ?? '',
      oldPrice: Number(it.oldPrice),
      newPrice: Number(it.newPrice),
      status: it.status as RentIncreaseItemDto['status'],
      skipReason: it.skipReason,
      appliedAt: it.appliedAt?.toISOString() ?? null,
      effectiveDate: ymd(it.effectiveDate),
      noticeStatus: (it.noticeStatus as RentIncreaseNoticeStatus | null) ?? null,
      noticeDelivery: deliveryOf(it.noticeCommunication?.status ?? null),
    }));
    return { ...this.toDto(row), items };
  }

  private async findRow(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<RentIncreaseRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.rentIncrease.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'rent_increase_not_found',
        message: 'Tanda no encontrada',
      });
    }
    this.assertScopeInFacility(facilityScope, (row.scope as RentIncreaseScopeInput | null) ?? {});
    return row;
  }

  private toDto(r: RentIncreaseRow): RentIncreaseDto {
    return {
      id: r.id,
      name: r.name,
      scope: (r.scope as RentIncreaseScopeInput) ?? { minMonthsSinceSigned: 0 },
      increaseType: r.increaseType as RentIncreaseDto['increaseType'],
      increaseValue: Number(r.increaseValue),
      effectiveDate: ymd(r.effectiveDate),
      status: r.status as RentIncreaseDto['status'],
      affectedCount: r.affectedCount,
      appliedCount: r.appliedCount,
      mrrDelta: Number(r.mrrDelta),
      noticeSent: r.noticeSent,
      createdAt: r.createdAt.toISOString(),
      appliedAt: r.appliedAt?.toISOString() ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
    };
  }
}

/** Ajustes de toda la empresa: solo quien ve todos los locales. */
export { assertAllFacilities };

/** Qué pasó con el correo del aviso, a partir del estado de la comunicación. */
function deliveryOf(status: string | null): RentIncreaseItemDto['noticeDelivery'] {
  switch (status) {
    case null:
      return null;
    case 'pending':
    case 'processing':
      return 'pending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'bounced':
      return 'bounced';
    default:
      return 'failed';
  }
}
