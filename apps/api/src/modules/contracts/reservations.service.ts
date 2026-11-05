import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { CreateContractSchema, rentTax } from '@storageos/shared';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { toCents } from '../../common/money';
import { isReservationOverlap } from '../../common/reservation-overlap';
import { releaseReservedUnit, unitHeldByOther } from '../../common/unit-holds';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { ContractsService } from './contracts.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DomainEventPayload, UnitAvailablePayload } from '../automations/domain-events';
import type { Prisma, Reservation, ReservationStatus } from '@storageos/database';
import type {
  CancelReservationInput,
  ContractDto,
  ConvertReservationInput,
  CreateReservationInput,
  ReservationDto,
  ReservationStatusValue,
} from '@storageos/shared';

type ReservationWithRelations = Reservation & {
  unit: {
    code: string;
    facilityId: string;
    basePriceMonthly: Prisma.Decimal;
    facility: { name: string; timezone: string };
  };
  customer: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: 'individual' | 'business';
  } | null;
};

const RESERVATION_INCLUDE = {
  unit: {
    select: {
      code: true,
      facilityId: true,
      basePriceMonthly: true,
      facility: { select: { name: true, timezone: true } },
    },
  },
  customer: {
    select: { firstName: true, lastName: true, companyName: true, customerType: true },
  },
} satisfies Prisma.ReservationInclude;

/** Día de calendario de una fecha en la zona del local. */
function dayInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

interface ListFilters {
  unitId?: string;
  customerId?: string;
  status?: ReservationStatusValue;
  facilityId?: string;
  /** Permisos por local: si está, solo reservas de unidades de esos locales. */
  facilityScope?: string[] | null;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly contracts: ContractsService,
    private readonly eventBus: EventEmitter2,
    private readonly invoices: InvoicesService,
  ) {}

  private readonly logger = new Logger(ReservationsService.name);

  async list(tenantId: string, filters: ListFilters): Promise<ReservationDto[]> {
    const where: Prisma.ReservationWhereInput = {};
    if (filters.unitId) where.unitId = filters.unitId;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.status) where.status = filters.status as ReservationStatus;
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return []; // local pedido fuera del scope del usuario
    if (facFilter) where.unit = { facilityId: { in: facFilter } };
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.reservation.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          include: RESERVATION_INCLUDE,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<ReservationDto> {
    return this.toDto(await this.findOrThrow(tenantId, id, facilityScope));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateReservationInput;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ReservationDto> {
    const validFrom = new Date(args.input.validFrom);
    const validUntil = new Date(args.input.validUntil);
    if (validUntil.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'invalid_valid_until',
        message: 'La reserva tiene que durar hasta una fecha futura',
      });
    }
    if (args.input.depositAmount > 0 && !args.input.customerId) {
      throw new BadRequestException({
        code: 'customer_required',
        message: 'Para cobrar una señal, la reserva necesita un inquilino',
      });
    }

    const created = await this.prisma.withTenant(async (tx) => {
      const unit = await tx.unit.findFirst({
        where: { id: args.input.unitId, facility: { deletedAt: null } },
      });
      if (!unit) {
        throw new NotFoundException({ code: 'unit_not_found', message: 'Trastero no encontrado' });
      }
      // Alcance por local: no se puede reservar una unidad de un local ajeno.
      assertFacilityAllowed(args.facilityScope, unit.facilityId);
      if (
        unit.status === 'occupied' ||
        unit.status === 'maintenance' ||
        unit.status === 'blocked'
      ) {
        throw new ConflictException({
          code: 'unit_not_reservable',
          message: `El trastero esta en estado ${unit.status}`,
        });
      }
      // Las reservas entre sí las separa la restricción de solape.
      if (
        await unitHeldByOther(tx, {
          unitId: unit.id,
          ignoreReservations: true,
          ...(args.input.customerId ? { customerId: args.input.customerId } : {}),
        })
      ) {
        throw this.unitHeld();
      }
      if (args.input.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: args.input.customerId, deletedAt: null },
        });
        if (!customer) {
          throw new NotFoundException({
            code: 'customer_not_found',
            message: 'Inquilino no encontrado',
          });
        }
      }
      // Reserva manual directa (desde la ficha del trastero): nace `confirmed`
      // y el trastero pasa a `reserved` en la misma transacción.
      const immediate = args.input.confirmImmediately === true;
      try {
        const row = await tx.reservation.create({
          data: {
            tenantId: args.tenantId,
            unitId: args.input.unitId,
            ...(args.input.customerId ? { customerId: args.input.customerId } : {}),
            status: immediate ? 'confirmed' : 'pending',
            validFrom,
            validUntil,
            depositAmount: args.input.depositAmount,
            notes: args.input.notes?.trim() || null,
          },
          include: RESERVATION_INCLUDE,
        });
        if (immediate && unit.status === 'available') {
          await this.reserveUnitInTx(
            tx,
            args.tenantId,
            unit.id,
            args.userId,
            `Reserva ${row.id} para un cliente`,
          );
        }
        return row;
      } catch (err) {
        if (isReservationOverlap(err)) {
          throw new ConflictException({
            code: 'reservation_overlap',
            message: 'Ya existe una reserva activa que solapa con este rango',
          });
        }
        throw err;
      }
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.created',
      entityType: 'Reservation',
      entityId: created.id,
      changes: {
        unitId: args.input.unitId,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil.toISOString(),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    if (created.status === 'confirmed') {
      this.emitReservationConfirmed(args.tenantId, created);
      const withDeposit = await this.autoDepositInvoice(args.tenantId, args.userId, created.id);
      if (withDeposit) return withDeposit;
    }
    return this.toDto(created);
  }

  /** `reservation_confirmed` → automatizaciones (la plantilla «Reserva confirmada»). */
  private emitReservationConfirmed(
    tenantId: string,
    r: {
      id: string;
      customerId: string | null;
      validFrom: Date;
      validUntil: Date;
      unit: { code: string; facility: { name: string; timezone: string } };
    },
  ): void {
    if (!r.customerId) return;
    const payload: DomainEventPayload = {
      tenantId,
      entityType: 'reservation',
      entityId: r.id,
      customerId: r.customerId,
      recipientEmail: null,
      scope: {
        reservation: {
          validFrom: dayInZone(r.validFrom, r.unit.facility.timezone),
          validUntil: dayInZone(r.validUntil, r.unit.facility.timezone),
        },
        unit: { code: r.unit.code },
        facility: { name: r.unit.facility.name },
      },
    };
    this.eventBus.emit(DOMAIN_EVENTS.reservation_confirmed, payload);
  }

  async confirm(args: {
    tenantId: string;
    userId: string;
    reservationId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ReservationDto> {
    const existing = await this.findOrThrow(args.tenantId, args.reservationId, args.facilityScope);
    this.assertTransition(existing.status, 'confirmed');
    if (existing.validUntil.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'reservation_expired',
        message: 'Esta reserva ya ha vencido: crea una nueva',
      });
    }

    const updated = await this.prisma.withTenant(async (tx) => {
      // Desde que se creó pudo alquilarse o quedar fuera de servicio.
      const current = await tx.unit.findUniqueOrThrow({ where: { id: existing.unitId } });
      if (
        current.status === 'occupied' ||
        current.status === 'maintenance' ||
        current.status === 'blocked'
      ) {
        throw new ConflictException({
          code: 'unit_not_reservable',
          message: `El trastero está en estado ${current.status}: no se puede confirmar la reserva`,
        });
      }
      if (
        await unitHeldByOther(tx, {
          unitId: existing.unitId,
          ignoreReservations: true,
          ...(existing.customerId ? { customerId: existing.customerId } : {}),
        })
      ) {
        throw this.unitHeld();
      }
      let row;
      try {
        // Reclamo: de dos confirmaciones a la vez solo una sigue adelante.
        await this.claimStatus(tx, args.reservationId, existing.status, { status: 'confirmed' });
        row = await tx.reservation.findUniqueOrThrow({
          where: { id: args.reservationId },
          include: RESERVATION_INCLUDE,
        });
      } catch (err) {
        // El EXCLUDE gist de `reservations_no_overlap_exclude` (pending/
        // confirmed) también se revalida en este UPDATE, no solo en el
        // INSERT de `create()` — por construcción no debería poder saltar
        // aquí (dos reservas pending/confirmed del mismo unit ya no pueden
        // solaparse desde que se crearon), pero si alguna vez lo hiciera
        // (p. ej. una fila creada por otra vía que sortee `create()`), que
        // dé el mismo 409 claro en vez de un 500 crudo.
        if (isReservationOverlap(err)) {
          throw new ConflictException({
            code: 'reservation_overlap',
            message: 'Ya existe una reserva activa que solapa con este rango',
          });
        }
        throw err;
      }
      // Marcar la unit como reserved si estaba available.
      const unit = await tx.unit.findUniqueOrThrow({ where: { id: existing.unitId } });
      if (unit.status === 'available') {
        await tx.unit.update({
          where: { id: unit.id },
          data: { status: 'reserved' },
        });
        await tx.unitStatusHistory.create({
          data: {
            tenantId: args.tenantId,
            unitId: unit.id,
            previousStatus: 'available',
            newStatus: 'reserved',
            changedByUserId: args.userId,
            reason: `Reserva ${row.id} confirmada`,
          },
        });
      }
      return row;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.confirmed',
      entityType: 'Reservation',
      entityId: updated.id,
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    this.emitReservationConfirmed(args.tenantId, updated);
    const withDeposit = await this.autoDepositInvoice(args.tenantId, args.userId, updated.id);
    return withDeposit ?? this.toDto(updated);
  }

  /** Señal al confirmar (best-effort: si no se puede, se emite a mano). */
  private async autoDepositInvoice(
    tenantId: string,
    userId: string | null,
    reservationId: string,
  ): Promise<ReservationDto | null> {
    try {
      const r = await this.prisma.withTenant(
        (tx) =>
          tx.reservation.findFirst({
            where: { id: reservationId },
            select: { depositAmount: true, customerId: true, depositInvoiceId: true },
          }),
        tenantId,
      );
      if (!r || Number(r.depositAmount) <= 0 || !r.customerId || r.depositInvoiceId) return null;
      return await this.issueDepositInvoice({ tenantId, userId, reservationId, meta: {} });
    } catch (err) {
      this.logger.warn(`Señal de la reserva ${reservationId} sin emitir: ${String(err)}`);
      await this.admin.notification
        .create({
          data: {
            tenantId,
            type: 'reservation.signal_not_issued',
            title: 'Señal sin facturar',
            body: 'No se ha podido emitir la factura de la señal de una reserva. Puedes volver a intentarlo desde Reservas.',
            link: '/reservations',
          },
        })
        .catch(() => undefined);
      return null;
    }
  }

  /**
   * Emite la factura de la señal de una reserva (lo que el cliente paga para
   * guardar el trastero). Al convertirla en contrato, lo cobrado se descuenta
   * de su primera factura. Idempotente: si ya tiene señal, la devuelve.
   */
  async issueDepositInvoice(args: {
    tenantId: string;
    userId: string | null;
    reservationId: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<ReservationDto> {
    const existing = await this.findOrThrow(args.tenantId, args.reservationId, args.facilityScope);
    if (existing.depositInvoiceId) {
      // Quedó en borrador por un fallo anterior: se termina de emitir.
      const invoice = await this.invoices.detail(args.tenantId, existing.depositInvoiceId);
      if (invoice.status === 'draft') {
        await this.invoices.issue({
          tenantId: args.tenantId,
          userId: args.userId,
          invoiceId: invoice.id,
          meta: args.meta,
        });
      }
      return this.detail(args.tenantId, args.reservationId);
    }
    if (existing.status !== 'pending' && existing.status !== 'confirmed') {
      throw new BadRequestException({
        code: 'reservation_not_active',
        message: 'Solo se cobra la señal de una reserva pendiente o confirmada',
      });
    }
    const amount = Number(existing.depositAmount);
    if (amount <= 0) {
      throw new BadRequestException({
        code: 'no_deposit',
        message: 'La reserva no tiene señal',
      });
    }
    if (!existing.customerId) {
      throw new BadRequestException({
        code: 'customer_required',
        message: 'La reserva no tiene inquilino: asígnale uno para facturar la señal',
      });
    }
    const unit = await this.prisma.withTenant(
      (tx) =>
        tx.unit.findUniqueOrThrow({
          where: { id: existing.unitId },
          select: { code: true, unitType: { select: { propertyKind: true } } },
        }),
      args.tenantId,
    );
    const draft = await this.invoices.create({
      tenantId: args.tenantId,
      userId: args.userId,
      meta: args.meta,
      input: {
        invoiceType: 'F1',
        customerId: existing.customerId,
        items: [
          {
            description: `Señal de reserva — trastero ${unit.code} (se descuenta del alquiler)`,
            quantity: 1,
            unitPrice: amount,
            ...rentTax(unit.unitType?.propertyKind),
            relatedUnitId: existing.unitId,
          },
        ],
        verifactuMode: 'verifactu',
      },
    });
    const claimed = await this.prisma.withTenant(
      (tx) =>
        tx.reservation.updateMany({
          where: { id: args.reservationId, depositInvoiceId: null },
          data: { depositInvoiceId: draft.id },
        }),
      args.tenantId,
    );
    if (claimed.count === 0) {
      // Otra petición la emitió a la vez: se descarta este borrador.
      await this.invoices
        .cancel({
          tenantId: args.tenantId,
          userId: args.userId,
          invoiceId: draft.id,
          input: { reason: 'Señal duplicada' },
          meta: args.meta,
        })
        .catch(() => undefined);
      return this.detail(args.tenantId, args.reservationId);
    }
    try {
      await this.invoices.issue({
        tenantId: args.tenantId,
        userId: args.userId,
        invoiceId: draft.id,
        meta: args.meta,
      });
    } catch (err) {
      // Sin emitir no es una señal: se suelta para poder intentarlo de nuevo.
      await this.prisma.withTenant(
        (tx) =>
          tx.reservation.updateMany({
            where: { id: args.reservationId, depositInvoiceId: draft.id },
            data: { depositInvoiceId: null },
          }),
        args.tenantId,
      );
      await this.invoices
        .cancel({
          tenantId: args.tenantId,
          userId: args.userId,
          invoiceId: draft.id,
          input: { reason: 'Señal sin emitir' },
          meta: args.meta,
        })
        .catch(() => undefined);
      throw err;
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.deposit_invoiced',
      entityType: 'Reservation',
      entityId: args.reservationId,
      changes: { invoiceId: draft.id, amount },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.detail(args.tenantId, args.reservationId);
  }

  /** Al cobrarse la factura de una señal, la reserva queda con la señal pagada. */
  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async onInvoicePaid(p: DomainEventPayload): Promise<void> {
    if (p.entityType !== 'invoice') return;
    try {
      const reservation = await this.admin.reservation.findFirst({
        where: { tenantId: p.tenantId, depositInvoiceId: p.entityId, depositPaid: false },
        select: { id: true, convertedContractId: true },
      });
      if (!reservation) return;
      const claimed = await this.admin.reservation.updateMany({
        where: { id: reservation.id, depositPaid: false },
        data: { depositPaid: true },
      });
      // Reserva ya convertida: la señal se descuenta de la próxima factura.
      if (claimed.count === 0 || !reservation.convertedContractId) return;
      const invoice = await this.admin.invoice.findFirst({
        where: { id: p.entityId },
        select: { invoiceNumber: true, items: { select: { total: true, taxAmount: true } } },
      });
      const baseCents = (invoice?.items ?? []).reduce(
        (acc, it) => acc + toCents(Number(it.total) - Number(it.taxAmount)),
        0,
      );
      if (baseCents > 0) {
        await this.admin.contract.update({
          where: { id: reservation.convertedContractId },
          data: {
            pendingCreditAmount: { increment: baseCents / 100 },
            pendingCreditReason: `señal ${invoice?.invoiceNumber ?? ''}`.trim(),
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Señal cobrada sin marcar (factura ${p.entityId}): ${String(err)}`);
    }
  }

  async cancel(args: {
    tenantId: string;
    userId: string;
    reservationId: string;
    facilityScope?: string[] | null;
    input: CancelReservationInput;
    meta: RequestMeta;
  }): Promise<ReservationDto> {
    const existing = await this.findOrThrow(args.tenantId, args.reservationId, args.facilityScope);
    this.assertTransition(existing.status, 'cancelled');
    let releasedUnit = false;
    const updated = await this.prisma.withTenant(async (tx) => {
      await this.claimStatus(tx, args.reservationId, existing.status, {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: args.input.reason?.trim() || null,
      });
      const row = await tx.reservation.findUniqueOrThrow({
        where: { id: args.reservationId },
        include: RESERVATION_INCLUDE,
      });
      if (existing.status === 'confirmed') {
        releasedUnit = await releaseReservedUnit(tx, {
          tenantId: args.tenantId,
          unitId: existing.unitId,
          userId: args.userId,
          reservationId: existing.id,
          reason: `Reserva ${row.id} cancelada`,
        });
      }
      return row;
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.cancelled',
      entityType: 'Reservation',
      entityId: updated.id,
      changes: { reason: args.input.reason ?? null },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    await this.settleSignal(args.tenantId, args.userId, updated, 'Reserva cancelada');
    if (releasedUnit) {
      this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
        tenantId: args.tenantId,
        unitId: existing.unitId,
      } satisfies UnitAvailablePayload);
    }
    return this.toDto(updated);
  }

  /**
   * La reserva se cae con una señal facturada. Sin cobrar, la factura se anula
   * (si no, seguiría en impagos). Cobrada, queda un abono en borrador para que
   * el equipo decida: se revisa, se emite y se devuelve a mano. Best-effort.
   */
  private async settleSignal(
    tenantId: string,
    userId: string | null,
    r: { id: string; depositInvoiceId: string | null; unit: { code: string; facilityId: string } },
    reason: string,
  ): Promise<void> {
    if (!r.depositInvoiceId) return;
    try {
      const invoice = await this.invoices.detail(tenantId, r.depositInvoiceId);
      if (invoice.status === 'paid') {
        const credit = await this.invoices.rectify({
          originalInvoiceId: invoice.id,
          tenantId,
          userId,
          input: {
            rectificationType: 'R1',
            reason: `${reason}: abono de la señal`,
            correctionMethod: 'by_differences',
            items: invoice.items.map((i) => ({
              description: `Abono de la señal — ${i.description}`,
              quantity: 1,
              unitPrice: -Number(i.unitPrice) * Number(i.quantity),
              taxRate: i.taxRate,
              taxCategory: i.taxCategory,
            })),
          },
          meta: {},
        });
        await this.admin.notification.create({
          data: {
            tenantId,
            type: 'reservation.signal_credit_pending',
            title: `Señal por devolver — trastero ${r.unit.code}`,
            body: `${reason}. La señal estaba cobrada: revisa el abono en borrador, emítelo y devuelve el importe si corresponde.`,
            link: `/invoices/${credit.id}`,
            facilityId: r.unit.facilityId,
          },
        });
      } else if (invoice.amountPaid > 0) {
        // Cobrada en parte no se puede anular: lo decide el equipo.
        await this.admin.notification.create({
          data: {
            tenantId,
            type: 'reservation.signal_partially_paid',
            title: `Señal cobrada en parte — trastero ${r.unit.code}`,
            body: `${reason}. La factura de la señal tiene un cobro parcial: revísala y devuelve lo cobrado si corresponde.`,
            link: `/invoices/${invoice.id}`,
            facilityId: r.unit.facilityId,
          },
        });
      } else if (['draft', 'issued', 'overdue'].includes(invoice.status)) {
        await this.invoices.cancel({
          tenantId,
          userId,
          invoiceId: invoice.id,
          input: { reason },
          meta: {},
        });
      }
    } catch (err) {
      this.logger.warn(`Señal de la reserva ${r.id} sin resolver: ${String(err)}`);
    }
  }

  async convertToContract(args: {
    tenantId: string;
    userId: string;
    reservationId: string;
    facilityScope?: string[] | null;
    input: ConvertReservationInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const existing = await this.findOrThrow(args.tenantId, args.reservationId, args.facilityScope);
    if (existing.status !== 'pending' && existing.status !== 'confirmed') {
      throw new BadRequestException({
        code: 'reservation_not_convertible',
        message: 'Solo se pueden convertir reservas pending o confirmed',
      });
    }
    const customerId = args.input.customerId ?? existing.customerId;
    if (!customerId) {
      throw new BadRequestException({
        code: 'customer_required',
        message: 'La reserva no tiene customer; envia customerId',
      });
    }

    // Mismo camino que un alta normal: propietario del local, local por abrir,
    // inquilino sin fianza… y la reserva queda convertida en la misma transacción.
    const contract = await this.contracts.create({
      tenantId: args.tenantId,
      userId: args.userId,
      facilityScope: args.facilityScope ?? null,
      meta: args.meta,
      input: CreateContractSchema.parse({
        customerId,
        unitId: existing.unitId,
        startDate: args.input.startDate,
        ...(args.input.endDate ? { endDate: args.input.endDate } : {}),
        priceMonthly: args.input.priceMonthly,
        discountAmount: args.input.discountAmount,
        ...(args.input.discountReason ? { discountReason: args.input.discountReason } : {}),
        depositAmount: args.input.depositAmount,
        billingCycle: args.input.billingCycle,
        reservationId: args.reservationId,
      }),
    });

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'reservation.converted',
      entityType: 'Reservation',
      entityId: args.reservationId,
      changes: { contractId: contract.id, contractNumber: contract.contractNumber },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.contracts.detail(args.tenantId, contract.id);
  }

  /** Pone el trastero en `reserved` (asume que el caller validó que estaba
   * available) + deja rastro en el historial de estados. */
  private async reserveUnitInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    unitId: string,
    userId: string | null,
    reason: string,
  ): Promise<void> {
    await tx.unit.update({ where: { id: unitId }, data: { status: 'reserved' } });
    await tx.unitStatusHistory.create({
      data: {
        tenantId,
        unitId,
        previousStatus: 'available',
        newStatus: 'reserved',
        changedByUserId: userId,
        reason,
      },
    });
  }

  /**
   * Marca como `expired` las reservas pending/confirmed cuyo `valid_until` ya
   * pasó Y **libera el trastero** (reserved → available) si la reserva lo tenía
   * retenido y no queda otra reserva viva. Antes solo marcaba el estado sin
   * soltar la unidad → quedaba `reserved` para siempre. Llamado por el cron.
   */
  async expireDue(tenantId: string): Promise<{ expired: number }> {
    const { expired, releasedUnitIds } = await this.prisma.withTenant(async (tx) => {
      const due = await tx.reservation.findMany({
        where: { status: { in: ['pending', 'confirmed'] }, validUntil: { lt: new Date() } },
        select: {
          id: true,
          unitId: true,
          status: true,
          depositInvoiceId: true,
          unit: { select: { code: true, facilityId: true } },
        },
      });
      const released: string[] = [];
      for (const r of due) {
        await tx.reservation.update({ where: { id: r.id }, data: { status: 'expired' } });
        if (r.status === 'confirmed') {
          const didRelease = await releaseReservedUnit(tx, {
            tenantId,
            unitId: r.unitId,
            reservationId: r.id,
            reason: `Reserva ${r.id} caducada`,
          });
          if (didRelease) released.push(r.unitId);
        }
      }
      return { expired: due, releasedUnitIds: released };
    }, tenantId);
    for (const r of expired) await this.settleSignal(tenantId, null, r, 'Reserva caducada');
    // Tras el commit: el trastero liberado queda disponible → avisar a la lista
    // de espera de su tipo (el listener corre en el worker, donde vive el cron).
    for (const unitId of releasedUnitIds) {
      this.eventBus.emit(DOMAIN_EVENTS.unit_available, {
        tenantId,
        unitId,
      } satisfies UnitAvailablePayload);
    }
    return { expired: expired.length };
  }

  /**
   * Versión cross-tenant para el cron: expira las reservas caducadas de TODOS
   * los tenants que tengan alguna. Resuelve los tenants con `PrismaAdminService`
   * y delega en `expireDue(tenantId)` (con RLS) por cada uno.
   */
  async expireDueAll(): Promise<{ expired: number }> {
    const tenants = await this.admin.reservation.findMany({
      where: { status: { in: ['pending', 'confirmed'] }, validUntil: { lt: new Date() } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    let expired = 0;
    for (const t of tenants) {
      const res = await this.expireDue(t.tenantId);
      expired += res.expired;
    }
    return { expired };
  }

  private async findOrThrow(
    tenantId: string,
    reservationId: string,
    facilityScope?: string[] | null,
  ): Promise<ReservationWithRelations> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.reservation.findUnique({
          where: { id: reservationId },
          include: RESERVATION_INCLUDE,
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'reservation_not_found',
        message: 'Reserva no encontrada',
      });
    }
    assertFacilityAllowed(facilityScope, row.unit.facilityId);
    return row;
  }

  private assertTransition(from: ReservationStatus, to: ReservationStatusValue): void {
    const allowed: Record<ReservationStatusValue, ReservationStatusValue[]> = {
      pending: ['confirmed', 'cancelled', 'expired'],
      confirmed: ['cancelled', 'expired', 'converted'],
      expired: [],
      converted: [],
      cancelled: [],
    };
    if (!allowed[from as ReservationStatusValue].includes(to)) {
      throw new BadRequestException({
        code: 'invalid_reservation_transition',
        message: `Transicion invalida: ${from} -> ${to}`,
      });
    }
  }

  private unitHeld(): ConflictException {
    return new ConflictException({
      code: 'unit_held_by_other',
      message: 'Este trastero está guardado para otra persona: elige otro o espera a que se libere',
    });
  }

  /** Cambia el estado solo si sigue como se leyó: dos clics no hacen la acción dos veces. */
  private async claimStatus(
    tx: Prisma.TransactionClient,
    id: string,
    from: ReservationStatus,
    data: Prisma.ReservationUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await tx.reservation.updateMany({ where: { id, status: from }, data });
    if (count === 0) {
      throw new ConflictException({
        code: 'reservation_changed',
        message: 'Esta reserva acaba de cambiar: recarga la página',
      });
    }
  }

  private toDto(row: ReservationWithRelations): ReservationDto {
    const customerName = row.customer
      ? row.customer.customerType === 'business'
        ? (row.customer.companyName ?? 'Empresa')
        : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre'
      : null;
    return {
      id: row.id,
      unitId: row.unitId,
      unitCode: row.unit.code,
      facilityId: row.unit.facilityId,
      facilityName: row.unit.facility.name,
      customerId: row.customerId,
      customerName,
      status: row.status as ReservationStatusValue,
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil.toISOString(),
      depositPaid: row.depositPaid,
      depositAmount: Number(row.depositAmount),
      depositInvoiceId: row.depositInvoiceId,
      unitPriceMonthly: Number(row.unit.basePriceMonthly),
      notes: row.notes,
      convertedContractId: row.convertedContractId,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      cancelReason: row.cancelReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
