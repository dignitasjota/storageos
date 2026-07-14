import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CLOSED_CASE_STATUSES } from '@storageos/shared';

import { toCents } from '../../common/money';
import { AuditService } from '../auth/audit.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { Prisma, PrismaClient } from '@storageos/database';
import type {
  CancelCaseInput,
  CaseEventType,
  CollectionsSettingsResponse,
  CompleteDisposalInput,
  DelinquencyCaseDetailDto,
  DelinquencyCaseDto,
  DelinquencyCaseStatus,
  DelinquencySettlementDto,
  OpenCaseInput,
  OverlockCaseInput,
  RegisterCaseFileInput,
  RequestCaseFileUploadInput,
  SendNoticeInput,
  StartDisposalInput,
  UpdateCollectionsSettingsInput,
} from '@storageos/shared';

type Tx = Prisma.TransactionClient | PrismaClient;

/** Transiciones permitidas de la máquina de estados (además de los cierres). */
const TRANSITIONS: Record<DelinquencyCaseStatus, DelinquencyCaseStatus[]> = {
  open: ['overlocked', 'closed_paid', 'closed_cancelled'],
  overlocked: ['final_notice', 'closed_paid', 'closed_cancelled'],
  final_notice: ['resolution_pending', 'closed_paid', 'closed_cancelled'],
  resolution_pending: ['disposal', 'closed_paid', 'closed_cancelled'],
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
  ) {}

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

  /** Deuda viva del contrato en céntimos (facturas issued/overdue, neto de pagos/abonos). */
  private async computeDebtCents(tx: Tx, tenantId: string, contractId: string): Promise<number> {
    const invoices = await tx.invoice.findMany({
      where: { tenantId, contractId, status: { in: ['issued', 'overdue'] } },
      select: { total: true, amountPaid: true, amountRefunded: true },
    });
    let cents = 0;
    for (const inv of invoices) {
      cents += toCents(inv.total) - toCents(inv.amountPaid) - toCents(inv.amountRefunded);
    }
    return Math.max(0, cents);
  }

  // ---- lectura ----

  private async toDto(tx: Tx, row: CaseRow): Promise<DelinquencyCaseDto> {
    const debtCents = await this.computeDebtCents(tx, row.tenantId, row.contractId);
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
      closedAt: row.closedAt?.toISOString() ?? null,
      notes: row.notes,
    };
  }

  async list(
    tenantId: string,
    opts: { status?: DelinquencyCaseStatus; facilityScope: string[] | null },
  ): Promise<DelinquencyCaseDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const where: Prisma.DelinquencyCaseWhereInput = {
        tenantId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.facilityScope ? { facilityId: { in: opts.facilityScope } } : {}),
      };
      const rows = await tx.delinquencyCase.findMany({
        where,
        include: caseInclude,
        orderBy: { openedAt: 'desc' },
      });
      return Promise.all(rows.map((r) => this.toDto(tx, r)));
    }, tenantId);
  }

  async getDetail(
    tenantId: string,
    caseId: string,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDetailDto> {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      const base = await this.toDto(tx, row);
      const [events, files] = await Promise.all([
        tx.delinquencyCaseEvent.findMany({
          where: { tenantId, caseId },
          include: { createdBy: { select: { fullName: true } } },
          orderBy: { occurredAt: 'desc' },
        }),
        tx.delinquencyCaseFile.findMany({
          where: { tenantId, caseId },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      return {
        ...base,
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

  /** Apertura manual de un expediente sobre un contrato con deuda. */
  async openManual(
    tenantId: string,
    userId: string,
    input: OpenCaseInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
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
      const debtCents = await this.computeDebtCents(tx, tenantId, input.contractId);
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
      );
      return this.toDto(tx, created);
    }, tenantId);
  }

  /**
   * Apertura desde el dunning (paso `legal_notice` a +30) si el tenant activó
   * los impagos físicos. Cross-tenant (el dunning corre sin contexto). Best-effort
   * e idempotente (el índice único parcial impide dos expedientes abiertos por
   * contrato).
   */
  async openFromDunning(tenantId: string, invoiceId: string): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { collectionsEnabled: true },
    });
    if (!tenant?.collectionsEnabled) return;
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { contractId: true },
    });
    if (!invoice?.contractId) return;
    try {
      await this.prisma.withTenant(async (tx) => {
        const existing = await tx.delinquencyCase.findFirst({
          where: {
            tenantId,
            contractId: invoice.contractId!,
            status: { notIn: CLOSED_CASE_STATUSES },
          },
          select: { id: true },
        });
        if (existing) return;
        const contract = await tx.contract.findFirst({
          where: { id: invoice.contractId!, tenantId },
          select: {
            id: true,
            customerId: true,
            unitId: true,
            unit: { select: { facilityId: true } },
          },
        });
        if (!contract) return;
        const debtCents = await this.computeDebtCents(tx, tenantId, contract.id);
        if (debtCents <= 0) return;
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
            notes: 'Apertura automática (dunning +30)',
          },
          null,
        );
        this.logger.log(
          `collections: expediente abierto por dunning tenant=${tenantId} contract=${contract.id}`,
        );
      }, tenantId);
    } catch (err) {
      // El índice único puede saltar en una carrera; no es un error.
      this.logger.warn(`collections.openFromDunning: ${err instanceof Error ? err.message : err}`);
    }
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
      body: `${customerName(created.customer)} · ${(data.debtCents / 100).toFixed(2)} €`,
      link: `/collections/${created.id}`,
    });
    return created;
  }

  // ---- transiciones ----

  private assertTransition(from: DelinquencyCaseStatus, to: DelinquencyCaseStatus): void {
    if (!TRANSITIONS[from].includes(to)) {
      throw new BadRequestException({
        code: 'invalid_transition',
        message: `No se puede pasar de ${from} a ${to}`,
        details: { from, to },
      });
    }
  }

  private async transition(
    tenantId: string,
    caseId: string,
    userId: string,
    facilityScope: string[] | null,
    to: DelinquencyCaseStatus,
    extra: Prisma.DelinquencyCaseUpdateInput,
    eventType: CaseEventType,
    eventPayload: Record<string, unknown>,
  ): Promise<DelinquencyCaseDto> {
    return this.prisma.withTenant(async (tx) => {
      const row = await this.findOrThrow(tx, tenantId, caseId, facilityScope);
      this.assertTransition(row.status, to);
      const updated = await tx.delinquencyCase.update({
        where: { id: caseId },
        data: { status: to, ...extra },
        include: caseInclude,
      });
      await this.recordEvent(tx, tenantId, caseId, eventType, eventPayload, userId);
      await this.audit.write({
        tenantId,
        userId,
        action: `collections.${to}`,
        entityType: 'DelinquencyCase',
        entityId: caseId,
        changes: eventPayload as Prisma.InputJsonValue,
      });
      return this.toDto(tx, updated);
    }, tenantId);
  }

  async overlock(
    tenantId: string,
    userId: string,
    caseId: string,
    input: OverlockCaseInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'overlocked',
      { overlockedAt: new Date() },
      'overlock_placed',
      { notes: input.notes ?? null },
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
    const days = input.noticeDays ?? tenant?.collectionsNoticeDays ?? 15;
    const deadline = new Date(sentAt.getTime() + days * 24 * 60 * 60 * 1000);
    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'final_notice',
      { finalNoticeAt: sentAt, finalNoticeDeadline: deadline },
      'notice_sent',
      { sentAt: sentAt.toISOString(), deadline: deadline.toISOString(), days },
    );
  }

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
    );
  }

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
      'inventory_done',
      { disposalType: input.disposalType, notes: input.notes ?? null },
    );
  }

  async completeDisposal(
    tenantId: string,
    userId: string,
    caseId: string,
    input: CompleteDisposalInput,
    facilityScope: string[] | null,
  ): Promise<DelinquencyCaseDto> {
    // Liquidación fina: aplica la fianza retenida + lo obtenido de la disposición
    // a las facturas pendientes por antigüedad (más antigua primero) ANTES de
    // cerrar el expediente. Solo se ejecuta si el expediente está en `disposal`
    // (si no, `transition` lanzará invalid_transition sin haber tocado dinero).
    const caseRow = await this.prisma.withTenant(
      (tx) => this.findOrThrow(tx, tenantId, caseId, facilityScope),
      tenantId,
    );
    let settlement: DelinquencySettlementDto | null = null;
    if (caseRow.status === 'disposal') {
      settlement = await this.applyFineSettlement(
        tenantId,
        userId,
        caseRow.contractId,
        input.proceedsCents,
        input.applyDeposit,
        caseId,
        facilityScope,
      );
    }

    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'closed_disposed',
      { disposedAt: new Date(), closedAt: new Date() },
      'disposal_done',
      {
        proceedsCents: input.proceedsCents,
        notes: input.notes ?? null,
        ...(settlement ? { settlement } : {}),
      },
    );
  }

  /**
   * Aplica la fianza retenida (si `applyDeposit`) + el producto de la disposición
   * a las facturas pendientes del contrato por antigüedad (más antigua primero),
   * saldándolas con `markPaidManually` (methodType `other`, parcial permitido por
   * ser una liquidación real). Marca la fianza como liquidada y devuelve el
   * desglose. NO se anida en la tx del expediente (cada cobro abre la suya).
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
    const depositCents =
      applyDeposit && contract?.depositStatus === 'held' ? toCents(contract.depositAmount) : 0;

    const invoices = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findMany({
          where: { tenantId, contractId, status: { in: ['issued', 'overdue'] } },
          select: { id: true, total: true, amountPaid: true, amountRefunded: true },
          orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }],
        }),
      tenantId,
    );
    const debtBeforeCents = invoices.reduce(
      (sum, inv) =>
        sum + Math.max(0, toCents(inv.total) - toCents(inv.amountPaid) - toCents(inv.amountRefunded)),
      0,
    );

    let fundsCents = depositCents + proceedsCents;
    let depositAppliedCents = 0;
    let proceedsAppliedCents = 0;
    let invoicesSettled = 0;

    for (const inv of invoices) {
      if (fundsCents <= 0) break;
      const pendingCents = Math.max(
        0,
        toCents(inv.total) - toCents(inv.amountPaid) - toCents(inv.amountRefunded),
      );
      if (pendingCents <= 0) continue;
      const payCents = Math.min(pendingCents, fundsCents);
      // Reparte el pago entre fianza (primero) y producto para el desglose.
      const fromDeposit = Math.min(payCents, depositCents - depositAppliedCents);
      depositAppliedCents += fromDeposit;
      proceedsAppliedCents += payCents - fromDeposit;
      await this.invoices.markPaidManually({
        tenantId,
        userId,
        invoiceId: inv.id,
        facilityScope,
        input: {
          amount: payCents / 100,
          methodType: 'other',
          notes: `Liquidación expediente ${caseId} (fianza + disposición)`,
          allowPartialNonCash: true,
          overridePaymentInFlight: true,
        },
        meta: {},
      });
      fundsCents -= payCents;
      invoicesSettled += 1;
    }

    // La fianza que no fue necesaria para la deuda queda como devolución al
    // inquilino (real; el reembolso se tramita aparte). Marca la fianza liquidada.
    if (depositCents > 0) {
      const depositReturnedCents = depositCents - depositAppliedCents;
      await this.prisma.withTenant(
        (tx) =>
          tx.contract.update({
            where: { id: contractId },
            data: {
              depositStatus: depositReturnedCents > 0 ? 'partially_returned' : 'returned',
              depositReturnedAmount: depositReturnedCents / 100,
              depositSettledAt: new Date(),
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
      surplusCents: Math.max(0, fundsCents),
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
    return this.transition(
      tenantId,
      caseId,
      userId,
      facilityScope,
      'closed_cancelled',
      { closedAt: new Date() },
      'closed',
      { reason: input.reason },
    );
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

  // ---- cierre automático por pago ----

  /**
   * Al pagar una factura, si el contrato tiene un expediente abierto y su deuda
   * viva llegó a 0, se cierra el expediente (`closed_paid`). El acceso
   * electrónico ya lo reactiva `AccessIntegrationsService` con el mismo evento;
   * aquí solo cerramos el expediente + avisamos de retirar el candado físico.
   */
  async onInvoicePaid(tenantId: string, customerId: string): Promise<void> {
    try {
      await this.prisma.withTenant(async (tx) => {
        const open = await tx.delinquencyCase.findMany({
          where: { tenantId, customerId, status: { notIn: CLOSED_CASE_STATUSES } },
          include: caseInclude,
        });
        for (const c of open) {
          const debt = await this.computeDebtCents(tx, tenantId, c.contractId);
          if (debt > 0) continue;
          await tx.delinquencyCase.update({
            where: { id: c.id },
            data: { status: 'closed_paid', closedAt: new Date() },
          });
          await this.recordEvent(tx, tenantId, c.id, 'payment_received', {}, null);
          await this.recordEvent(tx, tenantId, c.id, 'closed', { reason: 'paid' }, null);
          const overlockNote = c.overlockedAt ? ' Recuerda retirar el candado físico.' : '';
          await this.notifications.create(tenantId, {
            type: 'collections.case_closed_paid',
            title: `Impago saldado — expediente cerrado`,
            body: `${customerName(c.customer)}.${overlockNote}`,
            link: `/collections/${c.id}`,
          });
        }
      }, tenantId);
    } catch (err) {
      this.logger.warn(`collections.onInvoicePaid: ${err instanceof Error ? err.message : err}`);
    }
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
