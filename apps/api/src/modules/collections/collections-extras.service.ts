import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  CASE_CHARGE_LABELS,
  CLOSED_CASE_STATUSES,
  CUSTODY_WEEKS_BEFORE_ABANDONMENT,
  type ApprovePickupInput,
  type CaseChargeInput,
  type DelinquencyCaseStatus,
  type DelinquencyPickupDto,
  type PickupStatus,
  type PickupTime,
  type PortalCollectionsCaseDto,
  type RejectPickupInput,
  type RemoveOverlockInput,
  type RequestPickupInput,
  type SurplusReturnedInput,
  type TodayAttentionItemDto,
} from '@storageos/shared';

import { claimDailyCronRun } from '../../common/cron-claim';
import { CryptoService } from '../../common/crypto/crypto.service';
import { formatDateLong, formatEur, todayInTimezone, zonedDayStart } from '../../common/format';
import { toCents } from '../../common/money';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { tenantHasFeature } from '../../common/tenant-features';
import { AccessCredentialsService } from '../access/access-credentials.service';
import { AuditService } from '../auth/audit.service';
import { InvoicesService } from '../billing/invoices.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, PrismaClient } from '@storageos/database';

type Tx = Prisma.TransactionClient | PrismaClient;

const DAY = 86_400_000;
/** Estados en los que el inquilino puede pedir cita para retirar sus bienes. */
const PICKUP_STATUSES: DelinquencyCaseStatus[] = ['contract_resolved', 'goods_moved', 'disposal'];
/** Un expediente sin ningún movimiento en estos días está parado. */
const STALLED_DAYS = 14;
/** Aviso de que el plazo del requerimiento vence pronto. */
const DEADLINE_SOON_DAYS = 3;

const caseInclude = {
  customer: {
    select: {
      customerType: true,
      firstName: true,
      lastName: true,
      companyName: true,
      email: true,
      locale: true,
    },
  },
  unit: { select: { code: true } },
  contract: {
    select: {
      unit: { select: { facility: { select: { id: true, name: true, timezone: true } } } },
    },
  },
} satisfies Prisma.DelinquencyCaseInclude;

type CaseRow = Prisma.DelinquencyCaseGetPayload<{ include: typeof caseInclude }>;

function customerName(c: CaseRow['customer'] | null): string {
  if (!c) return 'Cliente';
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

/** «HH:MM» → minutos desde la medianoche. */
function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * Lo que rodea a un expediente de impago: retirar el candado, devolver lo que
 * sobró, facturar los gastos de traslado y custodia, la cita para que el
 * inquilino retire sus bienes (desde su área de clientes) y los avisos al
 * equipo (en «Hoy» y en el móvil).
 */
@Injectable()
export class CollectionsExtrasService {
  private readonly logger = new Logger(CollectionsExtrasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly invoices: InvoicesService,
    private readonly access: AccessCredentialsService,
    private readonly communications: CommunicationsService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private async findCase(
    tx: Tx,
    tenantId: string,
    caseId: string,
    facilityScope: string[] | null,
  ): Promise<CaseRow> {
    const row = await tx.delinquencyCase.findFirst({
      where: { id: caseId, tenantId },
      include: caseInclude,
    });
    if (!row) {
      throw new NotFoundException({ code: 'case_not_found', message: 'Expediente no encontrado' });
    }
    if (facilityScope && row.facilityId && !facilityScope.includes(row.facilityId)) {
      throw new ForbiddenException({
        code: 'facility_not_in_scope',
        message: 'Fuera de tu alcance',
      });
    }
    return row;
  }

  private async recordEvent(
    tx: Tx,
    tenantId: string,
    caseId: string,
    eventType: string,
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

  private async writeAudit(
    tenantId: string,
    userId: string | null,
    action: string,
    caseId: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({
      tenantId,
      userId,
      action,
      entityType: 'DelinquencyCase',
      entityId: caseId,
      changes: changes as Prisma.InputJsonValue,
    });
  }

  // ---- candado y sobrante ----

  /** Se quita el candado: pagó, hay un plan de pagos o retiró sus bienes. */
  async removeOverlock(
    tenantId: string,
    userId: string,
    caseId: string,
    input: RemoveOverlockInput,
    facilityScope: string[] | null,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const row = await this.findCase(tx, tenantId, caseId, facilityScope);
      if (!row.overlockedAt) {
        throw new BadRequestException({
          code: 'no_overlock',
          message: 'Este expediente no tiene candado puesto',
        });
      }
      const claimed = await tx.delinquencyCase.updateMany({
        where: { id: caseId, overlockRemovedAt: null },
        data: { overlockRemovedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'overlock_already_removed',
          message: 'El candado ya se quitó',
        });
      }
      await this.recordEvent(
        tx,
        tenantId,
        caseId,
        'overlock_removed',
        { notes: input.notes ?? null },
        userId,
      );
    }, tenantId);
    await this.writeAudit(tenantId, userId, 'collections.overlock_removed', caseId, {
      notes: input.notes ?? null,
    });
  }

  /** Lo que sobró de la liquidación ya se le devolvió al inquilino. */
  async markSurplusReturned(
    tenantId: string,
    userId: string,
    caseId: string,
    input: SurplusReturnedInput,
    facilityScope: string[] | null,
  ): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const row = await this.findCase(tx, tenantId, caseId, facilityScope);
      if (!row.surplusCents || row.surplusCents <= 0) {
        throw new BadRequestException({
          code: 'no_surplus',
          message: 'No hay nada que devolver en este expediente',
        });
      }
      const claimed = await tx.delinquencyCase.updateMany({
        where: { id: caseId, surplusReturnedAt: null },
        data: { surplusReturnedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'surplus_already_returned',
          message: 'Ya consta que se devolvió',
        });
      }
      await this.recordEvent(
        tx,
        tenantId,
        caseId,
        'surplus_returned',
        { amountCents: row.surplusCents, notes: input.notes ?? null },
        userId,
      );
    }, tenantId);
    await this.writeAudit(tenantId, userId, 'collections.surplus_returned', caseId, {
      notes: input.notes ?? null,
    });
  }

  // ---- gastos del expediente ----

  /**
   * Gastos del traslado o de la custodia de los bienes, a cargo del inquilino
   * (condición 12): una factura aparte con su IVA, ligada al expediente.
   */
  async addCharge(
    tenantId: string,
    userId: string,
    caseId: string,
    input: CaseChargeInput,
    facilityScope: string[] | null,
    meta: RequestMeta,
  ): Promise<{ invoiceId: string; invoiceNumber: string }> {
    const row = await this.prisma.withTenant(
      (tx) => this.findCase(tx, tenantId, caseId, facilityScope),
      tenantId,
    );
    if ((CLOSED_CASE_STATUSES as string[]).includes(row.status)) {
      throw new BadRequestException({
        code: 'case_closed',
        message: 'El expediente está cerrado',
      });
    }
    const description =
      input.description?.trim() ||
      `${CASE_CHARGE_LABELS[input.kind]}${row.unit?.code ? ` — trastero ${row.unit.code}` : ''}`;
    const draft = await this.invoices.create({
      tenantId,
      userId,
      input: {
        invoiceType: 'F1',
        customerId: row.customerId,
        contractId: row.contractId,
        items: [{ description, quantity: 1, unitPrice: input.amount, taxRate: 21 }],
        verifactuMode: 'verifactu',
      },
      facilityScope,
      meta,
    });
    let invoice = draft;
    try {
      invoice = await this.invoices.issue({ tenantId, userId, invoiceId: draft.id, meta });
    } catch (err) {
      // Sin emitir (faltan datos fiscales, la serie…): el borrador queda en la
      // factura y el error llega a quien lo pidió.
      this.logger.warn(`collections charge issue: ${(err as Error).message}`);
      throw err;
    }
    await this.prisma.withTenant(
      (tx) =>
        this.recordEvent(
          tx,
          tenantId,
          caseId,
          'charge_added',
          { invoiceId: invoice.id, kind: input.kind, amount: input.amount, description },
          userId,
        ),
      tenantId,
    );
    await this.writeAudit(tenantId, userId, 'collections.charge_added', caseId, {
      invoiceId: invoice.id,
      kind: input.kind,
      amount: input.amount,
    });
    return { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber };
  }

  // ---- cita para retirar los bienes ----

  private async pickupRow(tx: Tx, caseId: string, pickupId: string) {
    const pickup = await tx.delinquencyPickupRequest.findFirst({
      where: { id: pickupId, caseId },
    });
    if (!pickup) {
      throw new NotFoundException({ code: 'pickup_not_found', message: 'Cita no encontrada' });
    }
    return pickup;
  }

  /**
   * El equipo concede la cita: un día y una franja en la hora del local. Con el
   * control de accesos, un código de un solo uso que solo abre en esa franja.
   */
  async approvePickup(args: {
    tenantId: string;
    userId: string;
    caseId: string;
    pickupId: string;
    input: ApprovePickupInput;
    facilityScope: string[] | null;
    meta: RequestMeta;
  }): Promise<void> {
    const { tenantId, input } = args;
    const { row, pickup } = await this.prisma.withTenant(async (tx) => {
      const row = await this.findCase(tx, tenantId, args.caseId, args.facilityScope);
      const pickup = await this.pickupRow(tx, args.caseId, args.pickupId);
      return { row, pickup };
    }, tenantId);
    if (pickup.status !== 'pending') {
      throw new ConflictException({
        code: 'pickup_not_pending',
        message: 'Esa cita ya está resuelta',
      });
    }
    const facility = row.contract.unit?.facility ?? null;
    const tz = facility?.timezone ?? 'Europe/Madrid';
    const today = todayInTimezone(tz).toISOString().slice(0, 10);
    if (input.date < today) {
      throw new BadRequestException({
        code: 'pickup_in_past',
        message: 'La cita no puede ser en un día que ya ha pasado',
      });
    }
    const dayStart = zonedDayStart(input.date, tz).getTime();
    const from = new Date(dayStart + minutes(input.from) * 60_000);
    const until = new Date(dayStart + minutes(input.to) * 60_000);
    if (until.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'pickup_in_past',
        message: 'Esa franja ya ha pasado',
      });
    }

    // El código, si los bienes siguen en el trastero (no en otro lugar de
    // custodia) y el negocio tiene control de accesos. Abre el local y su
    // trastero, una vez y solo en la franja.
    let credentialId: string | null = null;
    const goodsInUnit = !row.goodsMovedAt;
    if (
      facility &&
      goodsInUnit &&
      (await tenantHasFeature(this.admin, tenantId, 'access_control'))
    ) {
      const created = await this.access.createTemporary({
        tenantId,
        userId: args.userId,
        input: {
          holderName: `Retirada · ${customerName(row.customer)}`.slice(0, 120),
          holderKind: 'other',
          method: 'pin',
          allowedFacilityIds: [facility.id],
          allowedUnitIds: row.unitId ? [row.unitId] : [],
          allowedHours: { windows: [] },
          bypassCurfew: true,
          validFrom: from.toISOString(),
          expiresAt: until.toISOString(),
        },
        facilityScope: args.facilityScope,
        meta: args.meta,
        maxUses: 1,
        source: 'collections_pickup',
      });
      credentialId = created.id;
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      const res = await tx.delinquencyPickupRequest.updateMany({
        where: { id: pickup.id, status: 'pending' },
        data: {
          status: 'approved',
          approvedFrom: from,
          approvedUntil: until,
          credentialId,
          resolutionNote: input.notes?.trim() || null,
          resolvedByUserId: args.userId,
          resolvedAt: new Date(),
        },
      });
      if (res.count === 0) return false;
      await this.recordEvent(
        tx,
        tenantId,
        args.caseId,
        'pickup_approved',
        { pickupId: pickup.id, from: from.toISOString(), until: until.toISOString() },
        args.userId,
      );
      return true;
    }, tenantId);
    if (!updated) {
      // Otra persona la resolvió a la vez: el código sobra.
      if (credentialId) await this.revokeCode(tenantId, args.userId, credentialId);
      throw new ConflictException({
        code: 'pickup_not_pending',
        message: 'Esa cita ya está resuelta',
      });
    }
    await this.writeAudit(tenantId, args.userId, 'collections.pickup_approved', args.caseId, {
      pickupId: pickup.id,
      from: from.toISOString(),
      until: until.toISOString(),
    });
    await this.notifyPickup(tenantId, row, {
      subject: 'Tu cita para retirar tus bienes',
      lines: [
        `Te esperamos el ${formatDateLong(from, tz)} entre las ${input.from} y las ${input.to}${
          goodsInUnit
            ? facility
              ? ` en ${facility.name}`
              : ''
            : row.custodyLocation
              ? ` en ${row.custodyLocation}, donde están tus bienes`
              : ''
        }.`,
        credentialId
          ? 'El código para entrar está en tu área de clientes y sirve una sola vez, en esa franja.'
          : 'Ven en esa franja: te atenderá alguien del equipo.',
        ...(input.notes?.trim() ? [input.notes.trim()] : []),
      ],
    });
  }

  async rejectPickup(args: {
    tenantId: string;
    userId: string;
    caseId: string;
    pickupId: string;
    input: RejectPickupInput;
    facilityScope: string[] | null;
  }): Promise<void> {
    const { tenantId } = args;
    const row = await this.prisma.withTenant(async (tx) => {
      const row = await this.findCase(tx, tenantId, args.caseId, args.facilityScope);
      const pickup = await this.pickupRow(tx, args.caseId, args.pickupId);
      const res = await tx.delinquencyPickupRequest.updateMany({
        where: { id: pickup.id, status: 'pending' },
        data: {
          status: 'rejected',
          resolutionNote: args.input.reason,
          resolvedByUserId: args.userId,
          resolvedAt: new Date(),
        },
      });
      if (res.count === 0) {
        throw new ConflictException({
          code: 'pickup_not_pending',
          message: 'Esa cita ya está resuelta',
        });
      }
      await this.recordEvent(
        tx,
        tenantId,
        args.caseId,
        'pickup_rejected',
        { pickupId: pickup.id, reason: args.input.reason },
        args.userId,
      );
      return row;
    }, tenantId);
    await this.notifyPickup(tenantId, row, {
      subject: 'Sobre tu cita para retirar tus bienes',
      lines: [
        'No podemos darte la cita que pediste:',
        args.input.reason,
        'Puedes pedir otro día desde tu área de clientes.',
      ],
    });
  }

  /** El inquilino retiró sus bienes en la cita. */
  async completePickup(args: {
    tenantId: string;
    userId: string;
    caseId: string;
    pickupId: string;
    facilityScope: string[] | null;
  }): Promise<void> {
    const { tenantId } = args;
    const credentialId = await this.prisma.withTenant(async (tx) => {
      await this.findCase(tx, tenantId, args.caseId, args.facilityScope);
      const pickup = await this.pickupRow(tx, args.caseId, args.pickupId);
      const res = await tx.delinquencyPickupRequest.updateMany({
        where: { id: pickup.id, status: 'approved' },
        data: { status: 'done' },
      });
      if (res.count === 0) {
        throw new ConflictException({
          code: 'pickup_not_approved',
          message: 'Solo se da por hecha una cita concedida',
        });
      }
      await this.recordEvent(
        tx,
        tenantId,
        args.caseId,
        'pickup_done',
        { pickupId: pickup.id },
        args.userId,
      );
      return pickup.credentialId;
    }, tenantId);
    // El código ya no hace falta.
    if (credentialId) await this.revokeCode(tenantId, args.userId, credentialId);
  }

  /** Sin bienes que retirar (se dispuso de ellos): las citas abiertas se anulan. */
  async cancelOpenPickups(tenantId: string, caseId: string): Promise<void> {
    const credentialIds = await this.prisma.withTenant(async (tx) => {
      const open = await tx.delinquencyPickupRequest.findMany({
        where: { caseId, status: { in: ['pending', 'approved'] } },
        select: { id: true, credentialId: true },
      });
      if (open.length === 0) return [];
      await tx.delinquencyPickupRequest.updateMany({
        where: { id: { in: open.map((o) => o.id) } },
        data: { status: 'cancelled', resolvedAt: new Date() },
      });
      return open.flatMap((o) => (o.credentialId ? [o.credentialId] : []));
    }, tenantId);
    for (const id of credentialIds) await this.revokeCode(tenantId, null, id);
  }

  /** Revoca el código de una cita, también en los terminales (si sigue vivo). */
  private async revokeCode(
    tenantId: string,
    userId: string | null,
    credentialId: string,
  ): Promise<void> {
    await this.access
      .revoke({ tenantId, userId, id: credentialId, meta: {} })
      .catch((err: unknown) => {
        // Ya revocada o caducada: no hay nada que hacer.
        if (!(err instanceof ConflictException)) {
          this.logger.warn(`collections pickup revoke: ${(err as Error).message}`);
        }
      });
  }

  /** Correo al inquilino sobre su cita (sin el código: está en su área de clientes). */
  private async notifyPickup(
    tenantId: string,
    row: CaseRow,
    msg: { subject: string; lines: string[] },
  ): Promise<void> {
    const email = row.customer?.email;
    if (!email) return;
    try {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true, customDomain: true, customDomainVerifiedAt: true },
      });
      const portal = tenant
        ? tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant)
        : null;
      const first = row.customer?.customerType === 'business' ? null : row.customer?.firstName;
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: email,
        customerId: row.customerId,
        contractId: row.contractId,
        subject: msg.subject,
        bodyText: [
          `Hola${first ? ` ${first}` : ''},`,
          '',
          ...msg.lines,
          ...(portal ? ['', `Tu área de clientes: ${portal}`] : []),
        ].join('\n'),
        source: 'collections.pickup',
      });
    } catch (err) {
      this.logger.warn(`collections pickup email: ${(err as Error).message}`);
    }
  }

  /** Las citas de un expediente; `withCode` solo para el inquilino. */
  async pickupsOf(
    tx: Tx,
    tenantId: string,
    caseId: string,
    withCode: boolean,
  ): Promise<DelinquencyPickupDto[]> {
    const rows = await tx.delinquencyPickupRequest.findMany({
      where: { caseId },
      include: {
        credential: { select: { secretEncrypted: true, status: true, usesCount: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const now = Date.now();
    return rows.map((p) => {
      let code: string | null = null;
      const cred = p.credential;
      if (
        withCode &&
        p.status === 'approved' &&
        cred?.secretEncrypted &&
        cred.status === 'active' &&
        cred.usesCount === 0 &&
        p.approvedUntil &&
        p.approvedUntil.getTime() > now
      ) {
        try {
          code = this.crypto.decryptString(cred.secretEncrypted, tenantId);
        } catch {
          code = null;
        }
      }
      return {
        id: p.id,
        preferredDate: p.preferredDate.toISOString().slice(0, 10),
        preferredTime: p.preferredTime as PickupTime,
        note: p.note,
        status: p.status as PickupStatus,
        approvedFrom: p.approvedFrom?.toISOString() ?? null,
        approvedUntil: p.approvedUntil?.toISOString() ?? null,
        code,
        hasCode: !!p.credentialId,
        resolutionNote: p.resolutionNote,
        createdAt: p.createdAt.toISOString(),
        resolvedAt: p.resolvedAt?.toISOString() ?? null,
      };
    });
  }

  // ---- área de clientes ----

  /** Los expedientes abiertos del inquilino, para su área de clientes. */
  async portalCases(tenantId: string, customerId: string): Promise<PortalCollectionsCaseDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.delinquencyCase.findMany({
        where: {
          tenantId,
          customerId,
          OR: [
            { status: { notIn: CLOSED_CASE_STATUSES } },
            // Cerrado (pagó, se anuló la deuda…) con una cita aún por hacer.
            {
              pickupRequests: {
                some: {
                  OR: [
                    { status: 'pending' },
                    { status: 'approved', approvedUntil: { gt: new Date() } },
                  ],
                },
              },
            },
          ],
        },
        include: caseInclude,
        orderBy: { openedAt: 'desc' },
      });
      const out: PortalCollectionsCaseDto[] = [];
      for (const row of rows) {
        const tz = row.contract.unit?.facility?.timezone ?? 'Europe/Madrid';
        const today = todayInTimezone(tz);
        const invoices = await tx.invoice.findMany({
          where: {
            tenantId,
            contractId: row.contractId,
            kind: 'invoice',
            deletedAt: null,
            OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: today } }],
          },
          select: { total: true, amountPaid: true },
        });
        const pickups = await this.pickupsOf(tx, tenantId, row.id, true);
        out.push({
          id: row.id,
          status: row.status,
          unitCode: row.unit?.code ?? null,
          facilityName: row.contract.unit?.facility?.name ?? null,
          debtCents: invoices.reduce(
            (sum, i) => sum + Math.max(0, toCents(i.total) - toCents(i.amountPaid)),
            0,
          ),
          finalNoticeDeadline: row.finalNoticeDeadline?.toISOString() ?? null,
          contractResolvedAt: row.contractResolvedAt?.toISOString() ?? null,
          goodsMovedAt: row.goodsMovedAt?.toISOString() ?? null,
          custodyLocation: row.custodyLocation,
          canRequestPickup:
            PICKUP_STATUSES.includes(row.status) && !pickups.some((p) => p.status === 'pending'),
          pickups,
        });
      }
      return out;
    }, tenantId);
  }

  /** El inquilino pide cita para retirar sus bienes. */
  async requestPickup(
    tenantId: string,
    customerId: string,
    caseId: string,
    input: RequestPickupInput,
  ): Promise<void> {
    const row = await this.prisma.withTenant(async (tx) => {
      const row = await tx.delinquencyCase.findFirst({
        where: { id: caseId, tenantId, customerId },
        include: caseInclude,
      });
      if (!row) {
        throw new NotFoundException({ code: 'case_not_found', message: 'No encontrado' });
      }
      if (!PICKUP_STATUSES.includes(row.status)) {
        throw new BadRequestException({
          code: 'pickup_not_available',
          message: 'Todavía no hace falta pedir cita: si pagas lo que debes, recuperas el acceso.',
        });
      }
      const tz = row.contract.unit?.facility?.timezone ?? 'Europe/Madrid';
      const today = todayInTimezone(tz).toISOString().slice(0, 10);
      const limit = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
      if (input.preferredDate < today || input.preferredDate > limit) {
        throw new BadRequestException({
          code: 'invalid_preferred_date',
          message: 'Elige un día entre hoy y los próximos dos meses',
        });
      }
      try {
        await tx.delinquencyPickupRequest.create({
          data: {
            tenantId,
            caseId,
            customerId,
            preferredDate: new Date(`${input.preferredDate}T00:00:00.000Z`),
            preferredTime: input.preferredTime,
            note: input.note?.trim() || null,
          },
        });
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
          throw new ConflictException({
            code: 'pickup_already_requested',
            message: 'Ya tienes una cita pedida: espera a que te respondamos.',
          });
        }
        throw err;
      }
      await this.recordEvent(
        tx,
        tenantId,
        caseId,
        'pickup_requested',
        { preferredDate: input.preferredDate, preferredTime: input.preferredTime },
        null,
      );
      return row;
    }, tenantId);
    await this.notifications
      .create(tenantId, {
        type: 'collections.pickup_requested',
        title: `${customerName(row.customer)} pide cita para retirar sus bienes`,
        body: `Para el ${formatDateLong(new Date(`${input.preferredDate}T12:00:00Z`), 'UTC')}. Concédela o propón otro día desde el expediente.`,
        link: `/collections/${caseId}`,
        facilityId: row.facilityId,
      })
      .catch((err: unknown) =>
        this.logger.warn(`collections.pickup_requested: ${(err as Error).message}`),
      );
  }

  // ---- avisos ----

  /** Lo que piden los expedientes hoy, uno por expediente (para «Hoy»). */
  async todayItems(
    tenantId: string,
    facilityScope: string[] | null,
    facilityId?: string,
  ): Promise<TodayAttentionItemDto[]> {
    const now = Date.now();
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.delinquencyCase.findMany({
        where: {
          tenantId,
          ...(facilityId
            ? { facilityId }
            : facilityScope
              ? { facilityId: { in: facilityScope } }
              : {}),
          OR: [
            { status: { notIn: CLOSED_CASE_STATUSES } },
            // Cerrados que dejan algo por hacer: el candado o devolver dinero.
            { overlockedAt: { not: null }, overlockRemovedAt: null },
            { surplusCents: { gt: 0 }, surplusReturnedAt: null },
          ],
        },
        include: {
          ...caseInclude,
          events: { orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
          pickupRequests: { where: { status: 'pending' }, select: { id: true } },
        },
        take: 300,
      });
      const items: TodayAttentionItemDto[] = [];
      for (const row of rows) {
        const reasons: string[] = [];
        const open = !(CLOSED_CASE_STATUSES as string[]).includes(row.status);
        if (row.pickupRequests.length > 0) reasons.push('Pide cita para retirar sus bienes');
        if (
          row.status === 'final_notice' &&
          row.finalNoticeDeadline &&
          row.finalNoticeDeadline.getTime() > now &&
          row.finalNoticeDeadline.getTime() <= now + DEADLINE_SOON_DAYS * DAY
        ) {
          reasons.push(
            `El plazo del requerimiento vence el ${formatDateLong(row.finalNoticeDeadline)}`,
          );
        }
        if (
          row.status === 'goods_moved' &&
          row.goodsMovedAt &&
          row.goodsMovedAt.getTime() + CUSTODY_WEEKS_BEFORE_ABANDONMENT * 7 * DAY <= now
        ) {
          reasons.push('Ya se pueden dar por abandonados los bienes');
        }
        if (row.overlockedAt && !row.overlockRemovedAt && (!open || row.pausedAt)) {
          reasons.push(
            row.pausedAt ? 'Tiene un plan de pagos: quita el candado' : 'Quita el candado',
          );
        }
        if (row.surplusCents && row.surplusCents > 0 && !row.surplusReturnedAt) {
          reasons.push(`Devuélvele ${formatEur(row.surplusCents / 100)}`);
        }
        const last = row.events[0]?.occurredAt ?? row.updatedAt;
        if (open && !row.pausedAt && last.getTime() < now - STALLED_DAYS * DAY) {
          reasons.push(`Sin movimiento desde el ${formatDateLong(last)}`);
        }
        if (reasons.length === 0) continue;
        items.push({
          kind: 'collections_case',
          refId: row.id,
          label: `${customerName(row.customer)}${row.unit?.code ? ` · ${row.unit.code}` : ''}`,
          detail: reasons.join(' · '),
          date: null,
          href: `/collections/${row.id}`,
        });
      }
      return items;
    }, tenantId);
  }

  @Cron('30 8 * * *', { name: 'collections.alerts', timeZone: 'Europe/Madrid' })
  async cron(): Promise<void> {
    if (!(await claimDailyCronRun(this.admin, 'collections.alerts'))) return;
    await this.sendAlerts().catch((err: unknown) =>
      this.logger.warn(`collections.alerts: ${(err as Error).message}`),
    );
  }

  /**
   * Avisos al móvil del equipo, una vez por asunto: el plazo del requerimiento
   * vence en 3 días, ya se pueden dar por abandonados los bienes y un
   * expediente lleva 14 días parado (se repite cada 14 días).
   */
  async sendAlerts(now = new Date()): Promise<{ sent: number }> {
    const rows = await this.admin.delinquencyCase.findMany({
      where: { status: { notIn: CLOSED_CASE_STATUSES } },
      include: {
        ...caseInclude,
        events: { orderBy: { occurredAt: 'desc' }, take: 1, select: { occurredAt: true } },
      },
      take: 2000,
    });
    let sent = 0;
    const t = now.getTime();
    for (const row of rows) {
      const already = (row.alertsSent ?? {}) as Record<string, string>;
      const due: { key: string; mark: string; type: string; title: string; body: string }[] = [];
      const name = customerName(row.customer);
      if (
        row.status === 'final_notice' &&
        row.finalNoticeDeadline &&
        row.finalNoticeDeadline.getTime() > t &&
        row.finalNoticeDeadline.getTime() <= t + DEADLINE_SOON_DAYS * DAY
      ) {
        const mark = row.finalNoticeDeadline.toISOString().slice(0, 10);
        if (already.deadline_soon !== mark) {
          due.push({
            key: 'deadline_soon',
            mark,
            type: 'collections.deadline_soon',
            title: `Vence el plazo del requerimiento — ${name}`,
            body: `El ${formatDateLong(row.finalNoticeDeadline)}. Si no paga, el contrato queda resuelto.`,
          });
        }
      }
      if (
        row.status === 'goods_moved' &&
        row.goodsMovedAt &&
        row.goodsMovedAt.getTime() + CUSTODY_WEEKS_BEFORE_ABANDONMENT * 7 * DAY <= t &&
        !already.abandonment
      ) {
        due.push({
          key: 'abandonment',
          mark: now.toISOString().slice(0, 10),
          type: 'collections.abandonment_possible',
          title: `Ya se pueden dar por abandonados los bienes — ${name}`,
          body: 'Han pasado 8 semanas de custodia. Con el acta del abandono, se puede empezar la disposición.',
        });
      }
      const last = row.events[0]?.occurredAt ?? row.updatedAt;
      const lastStalled = already.stalled ? new Date(already.stalled).getTime() : 0;
      if (
        !row.pausedAt &&
        last.getTime() < t - STALLED_DAYS * DAY &&
        lastStalled < t - STALLED_DAYS * DAY
      ) {
        due.push({
          key: 'stalled',
          mark: now.toISOString().slice(0, 10),
          type: 'collections.stalled',
          title: `Expediente de impago parado — ${name}`,
          body: `Sin movimiento desde el ${formatDateLong(last)}.`,
        });
      }
      if (due.length === 0) continue;
      // Se reserva el aviso antes de enviarlo: dos réplicas no lo mandan dos veces.
      const next = { ...already, ...Object.fromEntries(due.map((d) => [d.key, d.mark])) };
      const claimed = await this.admin.delinquencyCase.updateMany({
        where: { id: row.id, alertsSent: { equals: already as Prisma.InputJsonValue } },
        data: { alertsSent: next as Prisma.InputJsonValue },
      });
      if (claimed.count === 0) continue;
      for (const d of due) {
        await this.notifications
          .create(row.tenantId, {
            type: d.type,
            title: d.title,
            body: d.body,
            link: `/collections/${row.id}`,
            facilityId: row.facilityId,
          })
          .then(() => {
            sent++;
          })
          .catch((err: unknown) => this.logger.warn(`${d.type}: ${(err as Error).message}`));
      }
    }
    return { sent };
  }
}
