import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CASE_FILE_MIME_TYPES,
  CASE_STATUS_LABELS,
  CLOSED_CASE_STATUSES,
  CUSTODY_WEEKS_BEFORE_ABANDONMENT,
  MIN_NOTICE_DAYS,
} from '@storageos/shared';

import { depositWasCollected } from '../../common/deposit-collected';
import { resolveFacilityFilter } from '../../common/facility-scope';
import { formatEur, todayInTimezone } from '../../common/format';
import { toCents } from '../../common/money';
import { tenantHasFeature } from '../../common/tenant-features';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { InvoicesService } from '../billing/invoices.service';
import { remindersOfInvoice } from '../billing/reminder-summary';
import { ContractsService } from '../contracts/contracts.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { Prisma, PrismaClient } from '@storageos/database';
import type {
  CancelCaseInput,
  CaseEventType,
  CollectionsSettingsResponse,
  CollectionsSummaryDto,
  CompleteDisposalInput,
  DelinquencyCaseDetailDto,
  DelinquencyCaseDto,
  DelinquencyCaseInvoiceDto,
  DelinquencyCaseStatus,
  DelinquencySettlementDto,
  MoveGoodsInput,
  NoticeReceivedInput,
  OpenCaseInput,
  OverlockCaseInput,
  RegisterCaseFileInput,
  RequestCaseFileUploadInput,
  ResolveContractInput,
  SendNoticeInput,
  StartDisposalInput,
  UpdateCollectionsSettingsInput,
} from '@storageos/shared';

type Tx = Prisma.TransactionClient | PrismaClient;

const DAY = 86_400_000;

/** Motivo con el que el impago bloquea un trastero (lo pone `ContractsService`). */
const IMPAGO_UNIT_REASON_PREFIX = 'Impago:';

/** Resultado del aviso legal del escalado. */
export type LegalNoticeOutcome = 'opened' | 'exists' | 'notified' | 'no_debt';

/** Facturas vencidas de esos contratos (desde el día siguiente al vencimiento). */
function overdueWhere(
  tenantId: string,
  contractIds: string[],
  today: Date,
): Prisma.InvoiceWhereInput {
  return {
    tenantId,
    contractId: { in: contractIds },
    kind: 'invoice',
    deletedAt: null,
    OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: today } }],
  };
}

/** Transiciones permitidas de la máquina de estados (además de los cierres). */
const TRANSITIONS: Record<DelinquencyCaseStatus, DelinquencyCaseStatus[]> = {
  open: ['overlocked', 'closed_paid', 'closed_cancelled'],
  overlocked: ['final_notice', 'closed_paid', 'closed_cancelled'],
  final_notice: ['resolution_pending', 'closed_paid', 'closed_cancelled'],
  resolution_pending: ['contract_resolved', 'closed_paid', 'closed_cancelled'],
  contract_resolved: ['goods_moved', 'closed_paid', 'closed_cancelled'],
  goods_moved: ['disposal', 'closed_paid', 'closed_cancelled'],
  disposal: ['closed_disposed', 'closed_paid', 'closed_cancelled'],
  closed_paid: [],
  closed_disposed: [],
  closed_cancelled: [],
};

function customerName(
  c: {
    customerType: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null,
): string {
  if (!c) return 'Cliente';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

const caseInclude = {
  customer: {
    select: { customerType: true, firstName: true, lastName: true, companyName: true },
  },
  unit: { select: { code: true } },
  contract: { select: { unit: { select: { facility: { select: { name: true } } } } } },
} satisfies Prisma.DelinquencyCaseInclude;

type CaseRow = Prisma.DelinquencyCaseGetPayload<{ include: typeof caseInclude }>;

/**
 * Expedientes de impago: overlock (candado físico) → requerimiento fehaciente
 * (burofax) → disposición del contenido. El software ORQUESTA el expediente
 * (plazos, avisos, evidencias, liquidación) con compuertas MANUALES en cada
 * paso legalmente sensible; nunca dispone por su cuenta. En España no hay lien
 * law: la validez del procedimiento depende del contrato + asesoría del
 * operador (por eso todo es opt-in con plazos configurables).
 */
@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
    private readonly invoices: InvoicesService,
    private readonly contracts: ContractsService,
    private readonly events: EventEmitter2,
  ) {}

  /** Hoy (medianoche UTC del día del calendario) en la zona del negocio. */
  private async tenantToday(tenantId: string): Promise<Date> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return todayInTimezone(tenant?.timezone ?? 'Europe/Madrid');
  }

  // ---- config ----

  async getSettings(tenantId: string): Promise<CollectionsSettingsResponse> {
    const t = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!t) throw new NotFoundException('Tenant no encontrado');
    return {
      collectionsEnabled: t.collectionsEnabled,
      collectionsOpenAfterDays: t.collectionsOpenAfterDays,
      collectionsNoticeDays: t.collectionsNoticeDays,
      collectionsClauseRef: t.collectionsClauseRef,
    };
  }

  async updateSettings(
    tenantId: string,
    actorUserId: string,
    input: UpdateCollectionsSettingsInput,
  ): Promise<CollectionsSettingsResponse> {
    const data: Prisma.TenantUpdateInput = {};
    if (input.collectionsEnabled !== undefined) data.collectionsEnabled = input.collectionsEnabled;
    if (input.collectionsOpenAfterDays !== undefined)
      data.collectionsOpenAfterDays = input.collectionsOpenAfterDays;
    if (input.collectionsNoticeDays !== undefined)
      data.collectionsNoticeDays = input.collectionsNoticeDays;
    if (input.collectionsClauseRef !== undefined)
      data.collectionsClauseRef = input.collectionsClauseRef || null;
    if (Object.keys(data).length > 0) {
      await this.admin.tenant.update({ where: { id: tenantId }, data });
      await this.audit.write({
        tenantId,
        userId: actorUserId,
        action: 'collections.settings_changed',
        entityType: 'Tenant',
        entityId: tenantId,
        changes: data as unknown as Prisma.InputJsonValue,
      });
    }
    return this.getSettings(tenantId);
  }

  // ---- deuda viva ----

  /**
   * Deuda VENCIDA de cada contrato en céntimos (lo que aún no ha vencido no se
   * reclama ni cuenta para cerrar el expediente).
   */
  private async debtByContract(
    tx: Tx,
    tenantId: string,
    contractIds: string[],
    today: Date,
  ): Promise<Map<string, number>> {
    const debts = new Map<string, number>();
    if (contractIds.length === 0) return debts;
    const invoices = await tx.invoice.findMany({
      where: overdueWhere(tenantId, contractIds, today),
      select: { contractId: true, total: true, amountPaid: true },
    });
    for (const inv of invoices) {
      const pending = Math.max(0, toCents(inv.total) - toCents(inv.amountPaid));
      debts.set(inv.contractId!, (debts.get(inv.contractId!) ?? 0) + pending);
    }
    return debts;
  }

  private async computeDebtCents(
    tx: Tx,
    tenantId: string,
    contractId: string,
    today: Date,
  ): Promise<number> {
    return (await this.debtByContract(tx, tenantId, [contractId], today)).get(contractId) ?? 0;
  }

  // ---- lectura ----

  private toDto(row: CaseRow, debtCents: number): DelinquencyCaseDto {
    const deadlineExpired =
      row.status === 'final_notice' &&
      row.finalNoticeDeadline != null &&
      row.finalNoticeDeadline.getTime() <= Date.now();
    return {
      id: row.id,
      contractId: row.contractId,
      customerId: row.customerId,
      customerName: customerName(row.customer),
      unitId: row.unitId,
      unitCode: row.unit?.code ?? null,
      facilityId: row.facilityId,
      facilityName: row.contract.unit?.facility?.name ?? null,
      status: row.status,
      debtCents,
      disposalType: row.disposalType,
      openedAt: row.openedAt.toISOString(),
      overlockedAt: row.overlockedAt?.toISOString() ?? null,
      finalNoticeAt: row.finalNoticeAt?.toISOString() ?? null,
      finalNoticeDeadline: row.finalNoticeDeadline?.toISOString() ?? null,
      deadlineExpired,
      noticeDays: row.noticeDays,
      noticeTracking: row.noticeTracking,
      noticeReceivedAt: row.noticeReceivedAt?.toISOString() ?? null,
      contractResolvedAt: row.contractResolvedAt?.toISOString() ?? null,
      goodsMovedAt: row.goodsMovedAt?.toISOString() ?? null,
      custodyLocation: row.custodyLocation,
      abandonmentFrom: row.goodsMovedAt
        ? new Date(
            row.goodsMovedAt.getTime() + CUSTODY_WEEKS_BEFORE_ABANDONMENT * 7 * DAY,
          ).toISOString()
        : null,
      closedAt: row.closedAt?.toISOString() ?? null,
      notes: row.notes,
    };
  }

  private async toDtoOne(tx: Tx, row: CaseRow): Promise<DelinquencyCaseDto> {
    const today = await this.tenantToday(row.tenantId);
    return this.toDto(row, await this.computeDebtCents(tx, row.tenantId, row.contractId, today));
  }

  async list(
    tenantId: string,
    opts: { status?: DelinquencyCaseStatus; facilityScope: string[] | null; facilityId?: string },
  ): Promise<DelinquencyCaseDto[]> {
    const ids = resolveFacilityFilter(opts.facilityScope, opts.facilityId);
    if (ids === null) return [];
    const today = await this.tenantToday(tenantId);
    return this.prisma.withTenant(async (tx) => {
      const where: Prisma.DelinquencyCaseWhereInput = {
        tenantId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(ids ? { facilityId: { in: ids } } : {}),
      };
      const rows = await tx.delinquencyCase.findMany({
        where,
        include: caseInclude,
        orderBy: { openedAt: 'desc' },
        take: 500,
      });
      const debts = await this.debtByContract(
        tx,
        tenantId,
        [...new Set(rows.map((r) => r.contractId))],
        today,
      );
      return rows.map((r) => this.toDto(r, debts.get(r.contractId) ?? 0));
    }, tenantId);
  }

  /** Vista rápida de expedientes ABIERTOS (cualquier estado no cerrado) para el Resumen del panel. */
  async getSummary(
    tenantId: string,
    facilityScope: string[] | null,
    facilityId?: string,
  ): Promise<CollectionsSummaryDto> {
    const facilities = resolveFacilityFilter(facilityScope, facilityId);
    const today = await this.tenantToday(tenantId);
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.delinquencyCase.findMany({
        where: {
          tenantId,
          status: { notIn: CLOSED_CASE_STATUSES },
          ...(facilities === undefined ? {} : { facilityId: { in: facilities ?? [] } }),
        },
        select: { contractId: true, status: true },
      });
      const debts = await this.debtByContract(
        tx,
        tenantId,
        [...new Set(rows.map((r) => r.contractId))],
        today,
      );
      const totalDebtCents = [...debts.values()].reduce((sum, d) => sum + d, 0);
      const byStatus: Partial<Record<DelinquencyCaseStatus, number>> = {};
      for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      return { openCount: rows.length, totalDebt: totalDebtCents / 100, byStatus };
    }, tenantId);
  }

  async getDetail(
    tenantId: string,
    caseId: string,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDetailDto> {
    const today = await this.tenantToday(tenantId);
    return this.prisma.withTenant(async (tx) => {
      const row = await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      const [events, files, invoices, reminded] = await Promise.all([
        tx.delinquencyCaseEvent.findMany({
          where: { tenantId, caseId },
          include: { createdBy: { select: { fullName: true } } },
          orderBy: { occurredAt: 'desc' },
        }),
        tx.delinquencyCaseFile.findMany({
          where: { tenantId, caseId },
          orderBy: { createdAt: 'desc' },
        }),
        this.overdueInvoices(tx, tenantId, row.contractId, today),
        this.wasReminded(tx, tenantId, row.contractId, today),
      ]);
      const debtCents = invoices.reduce((sum, i) => sum + i.pendingCents, 0);
      return {
        ...this.toDto(row, debtCents),
        invoices,
        reminded,
        events: events.map((e) => ({
          id: e.id,
          eventType: e.eventType,
          payload: (e.payload ?? {}) as Record<string, unknown>,
          createdByName: e.createdBy?.fullName ?? null,
          occurredAt: e.occurredAt.toISOString(),
        })),
        files: await Promise.all(
          files.map(async (f) => ({
            id: f.id,
            kind: f.kind,
            url: await this.files.getPresignedGetUrl('uploads', f.objectKey),
            contentType: f.contentType,
            createdAt: f.createdAt.toISOString(),
          })),
        ),
      };
    }, tenantId);
  }

  /** Las facturas vencidas que forman la deuda del contrato. */
  private async overdueInvoices(
    tx: Tx,
    tenantId: string,
    contractId: string,
    today: Date,
  ): Promise<DelinquencyCaseInvoiceDto[]> {
    const rows = await tx.invoice.findMany({
      where: overdueWhere(tenantId, [contractId], today),
      select: { id: true, invoiceNumber: true, dueDate: true, total: true, amountPaid: true },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows
      .map((r) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        dueDate: r.dueDate?.toISOString().slice(0, 10) ?? null,
        pendingCents: Math.max(0, toCents(r.total) - toCents(r.amountPaid)),
      }))
      .filter((r) => r.pendingCents > 0);
  }

  /**
   * ¿Se le avisó del impago? Un recordatorio de pago (del escalado o desde el
   * panel, también los que agrupan varias facturas) de lo que debe.
   */
  private async wasReminded(
    tx: Tx,
    tenantId: string,
    contractId: string,
    today: Date,
  ): Promise<boolean> {
    const overdue = await tx.invoice.findMany({
      where: overdueWhere(tenantId, [contractId], today),
      select: { id: true },
    });
    if (overdue.length === 0) return false;
    const sent = await tx.communication.count({
      where: { tenantId, OR: overdue.map((i) => remindersOfInvoice(i.id)) },
    });
    if (sent > 0) return true;
    const dunning = await tx.dunningAction.count({
      where: {
        invoiceId: { in: overdue.map((i) => i.id) },
        actionType: { in: ['email_reminder', 'email_reminder_final'] },
        status: 'executed',
      },
    });
    return dunning > 0;
  }

  /**
   * Expediente NO cerrado del contrato (si lo hay), para el badge de overlock en
   * la ficha del contrato / portal. Devuelve null si no hay ninguno abierto.
   */
  async findActiveByContract(
    tenantId: string,
    contractId: string,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto | null> {
    return this.prisma.withTenant(async (tx) => {
      const row = await tx.delinquencyCase.findFirst({
        where: { tenantId, contractId, status: { notIn: CLOSED_CASE_STATUSES } },
        include: caseInclude,
        orderBy: { openedAt: 'desc' },
      });
      if (!row) return null;
      if (facilityScope && row.facilityId && !facilityScope.includes(row.facilityId)) return null;
      return this.toDtoOne(tx, row);
    }, tenantId);
  }

  private async findOrThrow(
    tx: Tx,
    tenantId: string,
    caseId: string,
    facilityScope: string[] | null,
  ): Promise<CaseRow> {
    const row = await tx.delinquencyCase.findFirst({
      where: { id: caseId, tenantId },
      include: caseInclude,
    });
    if (!row)
      throw new NotFoundException({ code: 'case_not_found', message: 'Expediente no encontrado' });
    if (facilityScope && row.facilityId && !facilityScope.includes(row.facilityId)) {
      throw new ForbiddenException({
        code: 'facility_not_in_scope',
        message: 'Fuera de tu alcance',
      });
    }
    return row;
  }

  // ---- apertura ----

  /** Apertura manual de un expediente sobre un contrato con deuda vencida. */
  async openManual(
    tenantId: string,
    userId: string,
    input: OpenCaseInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    const today = await this.tenantToday(tenantId);
    return this.prisma.withTenant(async (tx) => {
      const contract = await tx.contract.findFirst({
        where: { id: input.contractId, tenantId },
        select: {
          id: true,
          customerId: true,
          unitId: true,
          unit: { select: { facilityId: true } },
        },
      });
      if (!contract) {
        throw new NotFoundException({
          code: 'contract_not_found',
          message: 'Contrato no encontrado',
        });
      }
      const facilityId = contract.unit?.facilityId ?? null;
      if (facilityScope && facilityId && !facilityScope.includes(facilityId)) {
        throw new ForbiddenException({
          code: 'facility_not_in_scope',
          message: 'Fuera de tu alcance',
        });
      }
      const debtCents = await this.computeDebtCents(tx, tenantId, input.contractId, today);
      if (debtCents <= 0) {
        throw new BadRequestException({
          code: 'no_debt',
          message: 'El contrato no tiene deuda vencida',
        });
      }
      const created = await this.createCase(
        tx,
        tenantId,
        {
          contractId: contract.id,
          customerId: contract.customerId,
          unitId: contract.unitId,
          facilityId,
          debtCents,
          openedByUserId: userId,
          notes: input.notes ?? null,
        },
        userId,
      ).catch((err: unknown) => {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          throw new ConflictException({
            code: 'case_already_open',
            message: 'Este contrato ya tiene un expediente abierto',
          });
        }
        throw err;
      });
      return this.toDto(created, debtCents);
    }, tenantId);
  }

  /**
   * Paso «aviso legal» del escalado (a los días que elige el negocio). Abre un
   * expediente si el negocio los usa (y su plan los incluye) y el contrato
   * sigue en marcha; si no, avisa al equipo de que toca decidir qué hacer.
   * Cross-tenant (el escalado corre sin contexto), idempotente.
   */
  async openFromDunning(tenantId: string, invoiceId: string): Promise<LegalNoticeOutcome> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { collectionsEnabled: true, timezone: true },
    });
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: {
        contractId: true,
        invoiceNumber: true,
        customer: {
          select: { customerType: true, firstName: true, lastName: true, companyName: true },
        },
        contract: { select: { status: true, unit: { select: { facilityId: true } } } },
      },
    });
    if (!invoice?.contractId) return 'no_debt';
    const today = todayInTimezone(tenant?.timezone ?? 'Europe/Madrid');
    const debtCents = await this.computeDebtCents(this.admin, tenantId, invoice.contractId, today);
    if (debtCents <= 0) return 'no_debt';
    const live = invoice.contract?.status === 'active' || invoice.contract?.status === 'ending';
    const usesCases =
      !!tenant?.collectionsEnabled && (await tenantHasFeature(this.admin, tenantId, 'collections'));
    if (usesCases && live) {
      try {
        const outcome = await this.prisma.withTenant(async (tx) => {
          const existing = await tx.delinquencyCase.findFirst({
            where: {
              tenantId,
              contractId: invoice.contractId!,
              status: { notIn: CLOSED_CASE_STATUSES },
            },
            select: { id: true },
          });
          if (existing) return 'exists' as const;
          const contract = await tx.contract.findFirst({
            where: { id: invoice.contractId!, tenantId },
            select: {
              id: true,
              customerId: true,
              unitId: true,
              unit: { select: { facilityId: true } },
            },
          });
          if (!contract) return 'no_debt' as const;
          await this.createCase(
            tx,
            tenantId,
            {
              contractId: contract.id,
              customerId: contract.customerId,
              unitId: contract.unitId,
              facilityId: contract.unit?.facilityId ?? null,
              debtCents,
              openedByUserId: null,
              notes: 'Apertura automática por el escalado de impagos',
            },
            null,
          );
          this.logger.log(
            `collections: expediente abierto por el escalado tenant=${tenantId} contract=${contract.id}`,
          );
          return 'opened' as const;
        }, tenantId);
        return outcome;
      } catch (err) {
        // El índice único puede saltar en una carrera: ya hay uno abierto.
        this.logger.warn(
          `collections.openFromDunning: ${err instanceof Error ? err.message : err}`,
        );
        return 'exists';
      }
    }
    // Sin expedientes (o el contrato ya terminó): que alguien lo mire.
    await this.notifications
      .create(tenantId, {
        type: 'collections.long_overdue',
        title: `Impago sin resolver — ${customerName(invoice.customer)}`,
        body: `Sigue debiendo ${formatEur(debtCents / 100)} (factura ${invoice.invoiceNumber}). ${
          live
            ? 'Llámale, ofrécele un plan de pagos o abre un expediente.'
            : 'Su contrato ya terminó: reclámalo o valora un juicio monitorio.'
        }`,
        link: '/arrears',
        facilityId: invoice.contract?.unit?.facilityId ?? null,
      })
      .catch((err: unknown) =>
        this.logger.warn(`collections.long_overdue: ${(err as Error).message}`),
      );
    return 'notified';
  }

  private async createCase(
    tx: Tx,
    tenantId: string,
    data: {
      contractId: string;
      customerId: string;
      unitId: string | null;
      facilityId: string | null;
      debtCents: number;
      openedByUserId: string | null;
      notes: string | null;
    },
    userId: string | null,
  ): Promise<CaseRow> {
    const created = await tx.delinquencyCase.create({
      data: {
        tenantId,
        contractId: data.contractId,
        customerId: data.customerId,
        unitId: data.unitId,
        facilityId: data.facilityId,
        status: 'open',
        debtSnapshot: data.debtCents,
        openedByUserId: data.openedByUserId,
        notes: data.notes,
      },
      include: caseInclude,
    });
    await this.recordEvent(
      tx,
      tenantId,
      created.id,
      'opened',
      { debtCents: data.debtCents },
      userId,
    );
    await this.notifications.create(tenantId, {
      type: 'collections.case_opened',
      title: `Expediente de impago abierto`,
      body: `${customerName(created.customer)} · ${formatEur(data.debtCents / 100)}`,
      link: `/collections/${created.id}`,
      facilityId: created.facilityId,
    });
    return created;
  }

  // ---- transiciones ----

  private assertTransition(from: DelinquencyCaseStatus, to: DelinquencyCaseStatus): void {
    if (!TRANSITIONS[from].includes(to)) {
      throw new BadRequestException({
        code: 'invalid_transition',
        message: `Desde «${CASE_STATUS_LABELS[from]}» no se puede pasar a «${CASE_STATUS_LABELS[to]}»`,
        details: { from, to },
      });
    }
  }

  /**
   * Cambia de estado con el expediente reclamado: si otra persona lo cambió a
   * la vez (cancelarlo mientras se registra el candado), la segunda recibe 409
   * en vez de pisar el estado.
   */
  private async transition(
    tenantId: string,
    caseId: string,
    userId: string,
    facilityScope: string[] | null,
    to: DelinquencyCaseStatus,
    extra: Prisma.DelinquencyCaseUpdateManyMutationInput,
    eventType: CaseEventType,
    eventPayload: Record<string, unknown>,
    check?: (row: CaseRow) => Promise<void> | void,
  ): Promise<DelinquencyCaseDto> {
    const dto = await this.prisma.withTenant(async (tx) => {
      const row = await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      this.assertTransition(row.status, to);
      if (check) await check(row);
      const claimed = await tx.delinquencyCase.updateMany({
        where: { id: caseId, status: row.status },
        data: { status: to, ...extra },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'case_changed',
          message: 'El expediente ha cambiado mientras tanto: vuelve a cargarlo.',
        });
      }
      const updated = await tx.delinquencyCase.findUniqueOrThrow({
        where: { id: caseId },
        include: caseInclude,
      });
      await this.recordEvent(tx, tenantId, caseId, eventType, eventPayload, userId);
      return this.toDtoOne(tx, updated);
    }, tenantId);
    await this.audit.write({
      tenantId,
      userId,
      action: `collections.${to}`,
      entityType: 'DelinquencyCase',
      entityId: caseId,
      changes: eventPayload as Prisma.InputJsonValue,
    });
    return dto;
  }

  /** ¿Hay alguna evidencia de ese tipo en el expediente? */
  private async hasFile(tx: Tx, caseId: string, kind: string): Promise<boolean> {
    return (await tx.delinquencyCaseFile.count({ where: { caseId, kind } })) > 0;
  }

  /**
   * Candado (suspensión de las entradas). La condición 12 pide avisarle antes:
   * un recordatorio de pago o, si se le avisó de otra forma, la constancia.
   */
  async overlock(
    tenantId: string,
    userId: string,
    caseId: string,
    input: OverlockCaseInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    const today = await this.tenantToday(tenantId);
    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'overlocked',
      { overlockedAt: new Date() },
      'overlock_placed',
      { notes: input.notes ?? null, priorNotice: input.priorNotice ?? null },
      async (row) => {
        if (input.priorNotice) return;
        const reminded = await this.prisma.withTenant(
          (tx) => this.wasReminded(tx, tenantId, row.contractId, today),
          tenantId,
        );
        if (!reminded) {
          throw new BadRequestException({
            code: 'notice_before_overlock_required',
            message:
              'Antes del candado hay que avisarle del impago (condición 12): envíale un recordatorio o indica cómo se le avisó.',
          });
        }
      },
    );
  }

  async sendNotice(
    tenantId: string,
    userId: string,
    caseId: string,
    input: SendNoticeInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { collectionsNoticeDays: true },
    });
    const sentAt = input.sentAt ? new Date(input.sentAt) : new Date();
    if (sentAt.getTime() > Date.now() + 10 * 60_000) {
      throw new BadRequestException({
        code: 'sent_at_in_future',
        message: 'La fecha de envío no puede ser futura',
      });
    }
    const days = Math.max(
      MIN_NOTICE_DAYS,
      input.noticeDays ?? tenant?.collectionsNoticeDays ?? MIN_NOTICE_DAYS,
    );
    // Hasta que se registre la entrega, el plazo cuenta desde el envío (el
    // mínimo); al registrar la recepción se recalcula desde ese día.
    const deadline = new Date(sentAt.getTime() + days * DAY);
    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'final_notice',
      {
        finalNoticeAt: sentAt,
        finalNoticeDeadline: deadline,
        noticeDays: days,
        noticeTracking: input.tracking?.trim() || null,
      },
      'notice_sent',
      {
        sentAt: sentAt.toISOString(),
        deadline: deadline.toISOString(),
        days,
        tracking: input.tracking?.trim() || null,
        notes: input.notes ?? null,
      },
    );
  }

  /** El inquilino recibió el requerimiento: el plazo cuenta desde ese día. */
  async noticeReceived(
    tenantId: string,
    userId: string,
    caseId: string,
    input: NoticeReceivedInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    const receivedAt = new Date(input.receivedAt);
    const dto = await this.prisma.withTenant(async (tx) => {
      const row = await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      if (row.status !== 'final_notice') {
        throw new BadRequestException({
          code: 'invalid_transition',
          message: 'La entrega se registra con el requerimiento enviado y el plazo en curso',
        });
      }
      if (
        receivedAt.getTime() > Date.now() + 10 * 60_000 ||
        (row.finalNoticeAt && receivedAt < row.finalNoticeAt)
      ) {
        throw new BadRequestException({
          code: 'invalid_received_at',
          message: 'La fecha de entrega no puede ser futura ni anterior al envío',
        });
      }
      const days = row.noticeDays ?? MIN_NOTICE_DAYS;
      const deadline = new Date(receivedAt.getTime() + days * DAY);
      const claimed = await tx.delinquencyCase.updateMany({
        where: { id: caseId, status: 'final_notice' },
        data: { noticeReceivedAt: receivedAt, finalNoticeDeadline: deadline },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'case_changed',
          message: 'El expediente ha cambiado mientras tanto: vuelve a cargarlo.',
        });
      }
      await this.recordEvent(
        tx,
        tenantId,
        caseId,
        'notice_received',
        {
          receivedAt: receivedAt.toISOString(),
          deadline: deadline.toISOString(),
          notes: input.notes ?? null,
        },
        userId,
      );
      return this.toDtoOne(
        tx,
        await tx.delinquencyCase.findUniqueOrThrow({ where: { id: caseId }, include: caseInclude }),
      );
    }, tenantId);
    await this.audit.write({
      tenantId,
      userId,
      action: 'collections.notice_received',
      entityType: 'DelinquencyCase',
      entityId: caseId,
      changes: { receivedAt: receivedAt.toISOString() },
    });
    return dto;
  }

  /** El plazo del requerimiento pasó sin pagar (solo a partir de esa fecha). */
  async markResolutionPending(
    tenantId: string,
    userId: string,
    caseId: string,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'resolution_pending',
      { resolutionPendingAt: new Date() },
      'deadline_expired',
      {},
      (row) => {
        if (!row.finalNoticeDeadline || row.finalNoticeDeadline.getTime() > Date.now()) {
          throw new BadRequestException({
            code: 'deadline_not_reached',
            message: 'El plazo del requerimiento aún no ha vencido',
            details: { deadline: row.finalNoticeDeadline?.toISOString() ?? null },
          });
        }
      },
    );
  }

  /**
   * El contrato queda resuelto (condición 12): se termina y el trastero queda
   * bloqueado mientras los bienes sigan dentro.
   */
  async resolveContract(
    tenantId: string,
    userId: string,
    caseId: string,
    input: ResolveContractInput,
    facilityScope: string[] | null,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<DelinquencyCaseDto> {
    const row = await this.prisma.withTenant(
      (tx) => this.findOrThrow(tx, tenantId, caseId, facilityScope),
      tenantId,
    );
    this.assertTransition(row.status, 'contract_resolved');
    const contract = await this.admin.contract.findFirst({
      where: { id: row.contractId, tenantId },
      select: { status: true },
    });
    // Termina el contrato si sigue en marcha (con el expediente abierto, el
    // trastero queda bloqueado en vez de volver a la venta).
    if (contract && (contract.status === 'active' || contract.status === 'ending')) {
      await this.contracts.end({
        tenantId,
        userId,
        contractId: row.contractId,
        facilityScope,
        meta,
      });
    }
    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'contract_resolved',
      { contractResolvedAt: new Date() },
      'contract_resolved',
      { notes: input.notes ?? null },
    );
  }

  /**
   * Traslado de los bienes a un lugar de custodia, con inventario (fotos y
   * lista). El trastero queda libre.
   */
  async moveGoods(
    tenantId: string,
    userId: string,
    caseId: string,
    input: MoveGoodsInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    const dto = await this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'goods_moved',
      { goodsMovedAt: new Date(), custodyLocation: input.custodyLocation },
      'goods_moved',
      { custodyLocation: input.custodyLocation, notes: input.notes ?? null },
      async (row) => {
        const inventory = await this.prisma.withTenant(
          (tx) => this.hasFile(tx, row.id, 'inventory'),
          tenantId,
        );
        if (!inventory) {
          throw new BadRequestException({
            code: 'inventory_required',
            message: 'Antes del traslado sube el inventario (fotos y lista de lo que hay).',
          });
        }
      },
    );
    // Vacío: el trastero bloqueado por los bienes vuelve a la venta.
    if (dto.unitId) {
      const freed = await this.prisma.withTenant(async (tx) => {
        // Solo si lo bloqueó el impago (no uno parado por otro motivo).
        const res = await tx.unit.updateMany({
          where: {
            id: dto.unitId!,
            status: 'blocked',
            outOfServiceReason: { startsWith: IMPAGO_UNIT_REASON_PREFIX },
          },
          data: { status: 'available', outOfServiceReason: null, outOfServiceSince: null },
        });
        if (res.count > 0) {
          await tx.unitStatusHistory.create({
            data: {
              tenantId,
              unitId: dto.unitId!,
              previousStatus: 'blocked',
              newStatus: 'available',
              changedByUserId: userId,
              reason: 'Bienes trasladados a custodia (expediente de impago)',
            },
          });
        }
        return res.count > 0;
      }, tenantId);
      if (freed) {
        this.events.emit(DOMAIN_EVENTS.unit_available, { tenantId, unitId: dto.unitId });
      }
    }
    return dto;
  }

  /**
   * Disposición de los bienes, solo por un cauce legal. Por abandono, solo
   * pasadas 8 semanas de custodia desde el traslado.
   */
  async startDisposal(
    tenantId: string,
    userId: string,
    caseId: string,
    input: StartDisposalInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'disposal',
      { disposalType: input.disposalType },
      'disposal_started',
      { disposalType: input.disposalType, notes: input.notes ?? null },
      (row) => {
        if (input.disposalType !== 'abandonment') return;
        const from = row.goodsMovedAt
          ? new Date(row.goodsMovedAt.getTime() + CUSTODY_WEEKS_BEFORE_ABANDONMENT * 7 * DAY)
          : null;
        if (!from || from.getTime() > Date.now()) {
          throw new BadRequestException({
            code: 'custody_period_not_over',
            message: `Los bienes solo se dan por abandonados tras ${CUSTODY_WEEKS_BEFORE_ABANDONMENT} semanas de custodia.`,
            details: { availableFrom: from?.toISOString() ?? null },
          });
        }
      },
    );
  }

  async completeDisposal(
    tenantId: string,
    userId: string,
    caseId: string,
    input: CompleteDisposalInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    const caseRow = await this.prisma.withTenant(async (tx) => {
      const row = await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      this.assertTransition(row.status, 'closed_disposed');
      // El documento del cauce legal (sentencia, acuerdo firmado, acta del
      // abandono) tiene que estar en el expediente.
      if (!(await this.hasFile(tx, caseId, 'disposal_act'))) {
        throw new BadRequestException({
          code: 'disposal_act_required',
          message:
            'Sube antes el documento del cauce legal (sentencia, acuerdo firmado o acta del abandono).',
        });
      }
      return row;
    }, tenantId);

    // Reclama el cierre ATÓMICAMENTE antes de liquidar: dos «Completar» a la
    // vez no pueden aplicar la fianza y lo obtenido dos veces.
    const claim = await this.prisma.withTenant(
      (tx) =>
        tx.delinquencyCase.updateMany({
          where: { id: caseId, status: 'disposal' },
          data: { status: 'closed_disposed', disposedAt: new Date(), closedAt: new Date() },
        }),
      tenantId,
    );
    if (claim.count === 0) {
      throw new ConflictException({
        code: 'case_changed',
        message: 'El expediente ha cambiado mientras tanto: vuelve a cargarlo.',
      });
    }

    const settlement = await this.applyFineSettlement(
      tenantId,
      userId,
      caseRow.contractId,
      input.proceedsCents,
      input.applyDeposit,
      caseId,
      facilityScope,
    );
    const eventPayload = {
      proceedsCents: input.proceedsCents,
      notes: input.notes ?? null,
      settlement,
    };
    const toReturn = settlement.surplusCents + settlement.depositReturnedCents;
    if (toReturn > 0) {
      await this.notifications
        .create(tenantId, {
          type: 'collections.surplus_to_return',
          title: `Hay que devolver ${formatEur(toReturn / 100)} — ${customerName(caseRow.customer)}`,
          body: 'Lo que sobra de la fianza y de lo obtenido tras saldar la deuda es del inquilino: devuélvelo y anótalo en el expediente.',
          link: `/collections/${caseId}`,
          facilityId: caseRow.facilityId,
        })
        .catch((err: unknown) =>
          this.logger.warn(`collections.surplus_to_return: ${(err as Error).message}`),
        );
    }

    return this.prisma.withTenant(async (tx) => {
      const updated = await tx.delinquencyCase.findUniqueOrThrow({
        where: { id: caseId },
        include: caseInclude,
      });
      await this.recordEvent(tx, tenantId, caseId, 'disposal_done', eventPayload, userId);
      await this.audit.write({
        tenantId,
        userId,
        action: 'collections.closed_disposed',
        entityType: 'DelinquencyCase',
        entityId: caseId,
        changes: eventPayload as unknown as Prisma.InputJsonValue,
      });
      return this.toDtoOne(tx, updated);
    }, tenantId);
  }

  /**
   * Aplica la fianza retenida (si `applyDeposit`) + lo obtenido de la
   * disposición a las facturas pendientes del contrato por antigüedad (más
   * antigua primero). La fianza se reclama antes (otra liquidación a la vez no
   * la aplica dos veces) y lo que sobra queda para devolver al inquilino.
   */
  private async applyFineSettlement(
    tenantId: string,
    userId: string,
    contractId: string,
    proceedsCents: number,
    applyDeposit: boolean,
    caseId: string,
    facilityScope: string[] | null,
  ): Promise<DelinquencySettlementDto> {
    const contract = await this.admin.contract.findFirst({
      where: { id: contractId, tenantId },
      select: { depositAmount: true, depositStatus: true },
    });
    // Solo lo que se cobró de verdad se puede aplicar a la deuda.
    const collected =
      applyDeposit &&
      contract?.depositStatus === 'held' &&
      (await this.prisma.withTenant((tx) => depositWasCollected(tx, contractId), tenantId));
    let depositCents = 0;
    if (collected) {
      const claimed = await this.prisma.withTenant(
        (tx) =>
          tx.contract.updateMany({
            where: { id: contractId, depositStatus: 'held' },
            data: { depositStatus: 'returned', depositSettledAt: new Date() },
          }),
        tenantId,
      );
      if (claimed.count > 0) depositCents = toCents(contract.depositAmount);
    }

    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: {
            tenantId,
            contractId,
            kind: 'invoice',
            deletedAt: null,
            status: { in: ['issued', 'overdue'] },
          },
          select: { id: true, total: true, amountPaid: true },
          orderBy: [{ dueDate: 'asc' }, { issueDate: 'asc' }, { createdAt: 'asc' }],
        }),
      tenantId,
    );
    const pendingOf = (inv: { total: Prisma.Decimal; amountPaid: Prisma.Decimal }): number =>
      Math.max(0, toCents(inv.total) - toCents(inv.amountPaid));
    const debtBeforeCents = invoices.reduce((sum, inv) => sum + pendingOf(inv), 0);

    let fundsCents = depositCents + proceedsCents;
    let depositAppliedCents = 0;
    let proceedsAppliedCents = 0;
    let invoicesSettled = 0;

    for (const inv of invoices) {
      if (fundsCents <= 0) break;
      const pendingCents = pendingOf(inv);
      if (pendingCents <= 0) continue;
      const payCents = Math.min(pendingCents, fundsCents);
      // Reparte el pago entre fianza (primero) y lo obtenido. La fianza va con
      // su forma propia: no es dinero nuevo y no cuenta en caja.
      const fromDeposit = Math.min(payCents, depositCents - depositAppliedCents);
      const fromProceeds = payCents - fromDeposit;
      for (const [cents, methodType, label] of [
        [fromDeposit, 'deposit', 'fianza'],
        [fromProceeds, 'other', 'disposición'],
      ] as const) {
        if (cents <= 0) continue;
        await this.invoices.markPaidManually({
          tenantId,
          userId,
          invoiceId: inv.id,
          facilityScope,
          input: {
            amount: cents / 100,
            methodType,
            notes: `Liquidación expediente ${caseId} (${label})`,
            allowPartialNonCash: true,
            overridePaymentInFlight: true,
            allowInSepaRemittance: true,
          },
          meta: {},
        });
      }
      depositAppliedCents += fromDeposit;
      proceedsAppliedCents += fromProceeds;
      fundsCents -= payCents;
      invoicesSettled += 1;
    }

    // La fianza que no hizo falta para la deuda es del inquilino: queda como
    // devolución pendiente (se avisa al equipo).
    const depositReturnedCents = depositCents - depositAppliedCents;
    if (depositCents > 0) {
      await this.prisma.withTenant(
        (tx) =>
          tx.contract.update({
            where: { id: contractId },
            data: {
              depositStatus: depositReturnedCents > 0 ? 'partially_returned' : 'returned',
              depositReturnedAmount: depositReturnedCents / 100,
              depositRetentionReason: `Aplicada a la deuda del expediente ${caseId}`,
            },
          }),
        tenantId,
      );
    }

    return {
      debtBeforeCents,
      depositAppliedCents,
      proceedsAppliedCents,
      debtAfterCents: Math.max(0, debtBeforeCents - depositAppliedCents - proceedsAppliedCents),
      surplusCents: Math.max(0, proceedsCents - proceedsAppliedCents),
      depositReturnedCents,
      invoicesSettled,
    };
  }

  async cancel(
    tenantId: string,
    userId: string,
    caseId: string,
    input: CancelCaseInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    const seen: { row?: CaseRow } = {};
    const dto = await this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'closed_cancelled',
      { closedAt: new Date() },
      'closed',
      { reason: input.reason },
      (row) => {
        seen.row = row;
      },
    );
    // Lo que queda por hacer en el local (candado puesto, bienes dentro o en custodia).
    const pending = seen.row ? this.pendingTasksNote(seen.row) : '';
    if (pending) {
      await this.notifications
        .create(tenantId, {
          type: 'collections.case_closed',
          title: `Expediente cerrado — ${dto.customerName}`,
          body: pending.trim(),
          link: `/collections/${caseId}`,
          facilityId: dto.facilityId,
        })
        .catch((err: unknown) =>
          this.logger.warn(`collections.case_closed: ${(err as Error).message}`),
        );
    }
    return dto;
  }

  async addNote(
    tenantId: string,
    userId: string,
    caseId: string,
    note: string,
    facilityScope: string[] | null,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      await this.recordEvent(tx, tenantId, caseId, 'note', { note }, userId);
    }, tenantId);
  }

  // ---- cierre automático por pago o anulación ----

  /**
   * Al pagar una factura, si el contrato tiene un expediente abierto y ya no
   * debe nada vencido, el expediente se cierra (`closed_paid`). El acceso
   * electrónico lo reactiva `AccessIntegrationsService` con el mismo evento;
   * aquí se cierra el expediente y se avisa de lo que queda por hacer.
   */
  async onInvoicePaid(tenantId: string, customerId: string): Promise<void> {
    await this.closeIfSettled(tenantId, { customerId }, 'paid');
  }

  /** Una factura anulada o sustituida puede dejar el expediente sin deuda. */
  async onInvoiceVoided(tenantId: string, invoiceId: string): Promise<void> {
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { contractId: true },
    });
    if (!invoice?.contractId) return;
    await this.closeIfSettled(tenantId, { contractId: invoice.contractId }, 'voided');
  }

  private async closeIfSettled(
    tenantId: string,
    where: { customerId: string } | { contractId: string },
    reason: 'paid' | 'voided',
  ): Promise<void> {
    try {
      const today = await this.tenantToday(tenantId);
      await this.prisma.withTenant(async (tx) => {
        const open = await tx.delinquencyCase.findMany({
          where: { tenantId, ...where, status: { notIn: CLOSED_CASE_STATUSES } },
          include: caseInclude,
        });
        for (const c of open) {
          const debt = await this.computeDebtCents(tx, tenantId, c.contractId, today);
          if (debt > 0) continue;
          const to: DelinquencyCaseStatus = reason === 'paid' ? 'closed_paid' : 'closed_cancelled';
          const claimed = await tx.delinquencyCase.updateMany({
            where: { id: c.id, status: c.status },
            data: { status: to, closedAt: new Date() },
          });
          if (claimed.count === 0) continue;
          if (reason === 'paid') {
            await this.recordEvent(tx, tenantId, c.id, 'payment_received', {}, null);
          }
          await this.recordEvent(
            tx,
            tenantId,
            c.id,
            'closed',
            { reason: reason === 'paid' ? 'paid' : 'debt_voided' },
            null,
          );
          await this.notifications.create(tenantId, {
            type: reason === 'paid' ? 'collections.case_closed_paid' : 'collections.case_closed',
            title:
              reason === 'paid'
                ? 'Impago saldado — expediente cerrado'
                : 'Deuda anulada — expediente cerrado',
            body: `${customerName(c.customer)}.${this.pendingTasksNote(c)}`,
            link: `/collections/${c.id}`,
            facilityId: c.facilityId,
          });
        }
      }, tenantId);
    } catch (err) {
      this.logger.warn(`collections.closeIfSettled: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Lo que queda por hacer al cerrar un expediente según hasta dónde llegó. */
  private pendingTasksNote(c: CaseRow): string {
    if (c.status === 'goods_moved') {
      return ` Sus bienes están en custodia${c.custodyLocation ? ` (${c.custodyLocation})` : ''}: acuerda con él cómo los recoge.`;
    }
    if (c.status === 'contract_resolved') {
      return ' Su contrato está terminado y sus bienes siguen en el trastero (bloqueado): acuerda con él cuándo los retira y después pon el trastero disponible.';
    }
    if (c.overlockedAt) return ' Recuerda retirar el candado.';
    return '';
  }

  // ---- evidencias (MinIO privado, patrón inspection photos) ----

  async requestFileUpload(
    tenantId: string,
    caseId: string,
    input: RequestCaseFileUploadInput,
    facilityScope: string[] | null,
  ): Promise<{ uploadUrl: string; objectKey: string }> {
    return this.prisma.withTenant(async (tx) => {
      await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      const ext = input.contentType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
      const objectKey = `${tenantId}/collections/${caseId}/${input.kind}/${randomUUID()}.${ext}`;
      const { uploadUrl } = await this.files.getPresignedPutUrl({
        bucket: 'uploads',
        key: objectKey,
        contentType: input.contentType,
      });
      return { uploadUrl, objectKey };
    }, tenantId);
  }

  async registerFile(
    tenantId: string,
    userId: string,
    caseId: string,
    input: RegisterCaseFileInput,
    facilityScope: string[] | null,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      const prefix = `${tenantId}/collections/${caseId}/`;
      if (!input.objectKey.startsWith(prefix)) {
        throw new BadRequestException({ code: 'invalid_file_key', message: 'Key inválida' });
      }
      // Bytes reales, no solo el Content-Type declarado al pedir la URL. El
      // requerimiento en PDF lo genera el propio sistema (Puppeteer, subida
      // server-side) — comprobar sus bytes también es correcto (SIEMPRE es un
      // PDF real), no un caso especial a excluir.
      await this.files.assertObjectMimeType('uploads', input.objectKey, CASE_FILE_MIME_TYPES);
      await tx.delinquencyCaseFile.create({
        data: {
          tenantId,
          caseId,
          kind: input.kind,
          objectKey: input.objectKey,
          contentType: input.contentType ?? null,
          createdByUserId: userId,
        },
      });
      await this.recordEvent(tx, tenantId, caseId, 'note', { file: input.kind }, userId);
    }, tenantId);
  }

  // ---- helpers ----

  private async recordEvent(
    tx: Tx,
    tenantId: string,
    caseId: string,
    eventType: CaseEventType,
    payload: Record<string, unknown>,
    userId: string | null,
  ): Promise<void> {
    await tx.delinquencyCaseEvent.create({
      data: {
        tenantId,
        caseId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        createdByUserId: userId,
      },
    });
  }
}
