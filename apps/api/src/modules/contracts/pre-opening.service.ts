import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { addMonthsYmd, preOpeningCancelOutcome } from '@storageos/shared';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { subtractAmounts } from '../../common/money';
import { isPendingPreOpening } from '../../common/pre-opening';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS } from '../automations/domain-events';
import { InvoicesService } from '../billing/invoices.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { ContractsService } from './contracts.service';

import type { RequestMeta } from '../auth/auth.service';
import type { ContractPreOpeningStartedPayload } from '../automations/domain-events';
import type {
  ContractDto,
  FacilityOpeningDto,
  FacilityOpeningResultDto,
  PreOpeningCancelPreviewDto,
  UpdateFacilityOpeningInput,
} from '@storageos/shared';

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
/** Una fecha DATE (medianoche UTC) en palabras: «1 de diciembre de 2026». */
const dayLabel = (d: Date) => formatDateLong(d, 'UTC');

/**
 * Reservas anticipadas en locales por abrir: fecha de apertura (opcional,
 * se puede poner, cambiar o quitar), arranque de los contratos el día de
 * apertura y cancelación antes de empezar (14 días de desistimiento; después,
 * se devuelve la mensualidad y se retiene la fianza).
 */
@Injectable()
export class PreOpeningService {
  private readonly logger = new Logger(PreOpeningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly contracts: ContractsService,
    private readonly invoices: InvoicesService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------------
  // Fecha de apertura del local
  // ---------------------------------------------------------------------------

  async getOpening(
    tenantId: string,
    facilityId: string,
    facilityScope?: string[] | null,
  ): Promise<FacilityOpeningDto> {
    assertFacilityAllowed(facilityScope, facilityId);
    const facility = await this.findFacility(tenantId, facilityId);
    return {
      preOpening: facility.preOpening,
      openingDate: facility.openingDate ? ymd(facility.openingDate) : null,
      maxMonths: facility.preOpeningMaxMonths,
      reservations: await this.pendingCount(tenantId, facilityId),
    };
  }

  async updateOpening(args: {
    tenantId: string;
    userId: string;
    facilityId: string;
    facilityScope?: string[] | null;
    input: UpdateFacilityOpeningInput;
    meta: RequestMeta;
  }): Promise<FacilityOpeningResultDto> {
    assertFacilityAllowed(args.facilityScope, args.facilityId);
    const before = await this.findFacility(args.tenantId, args.facilityId);
    const today = ymd(todayInTimezone(before.timezone));
    const { preOpening, maxMonths } = args.input;
    const openingDate = preOpening ? args.input.openingDate : null;
    await this.admin.facility.update({
      where: { id: args.facilityId },
      data: {
        preOpening,
        openingDate: openingDate ? asDate(openingDate) : null,
        preOpeningMaxMonths: maxMonths,
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'facility.opening_changed',
      entityType: 'Facility',
      entityId: args.facilityId,
      changes: { preOpening, openingDate, maxMonths },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    let moved = 0;
    let started = 0;
    // Sin «próxima apertura» (el local ya abre) o con la fecha de hoy o pasada:
    // las reservas empiezan ya.
    if (!preOpening || (openingDate && openingDate <= today)) {
      started = await this.startFacility(args.tenantId, args.facilityId, openingDate ?? today);
    } else {
      const previous = before.openingDate ? ymd(before.openingDate) : null;
      if (previous !== openingDate) {
        moved = await this.moveReservations(args.tenantId, args.facilityId, openingDate);
      }
    }
    return {
      ...(await this.getOpening(args.tenantId, args.facilityId)),
      moved,
      started,
    };
  }

  /**
   * Cambia la fecha de inicio de las reservas del local y avisa a cada
   * inquilino. Sin fecha, la de inicio vuelve a ser la fecha límite.
   */
  private async moveReservations(
    tenantId: string,
    facilityId: string,
    openingDate: string | null,
  ): Promise<number> {
    const rows = await this.pendingContracts(tenantId, facilityId);
    for (const c of rows) {
      const startDate = openingDate ? asDate(openingDate) : (c.preOpeningDeadline ?? c.startDate);
      await this.admin.contract.update({
        where: { id: c.id },
        data: {
          startDate,
          preOpeningDateConfirmed: !!openingDate,
          preOpeningReminderSentAt: null,
        },
      });
      await this.admin.contractEvent.create({
        data: {
          tenantId,
          contractId: c.id,
          eventType: 'note_added',
          payload: { kind: 'pre_opening_date_changed', openingDate },
        },
      });
      if (c.status !== 'draft') {
        await this.notify(tenantId, c, {
          subject: openingDate
            ? `Fecha de apertura: ${dayLabel(asDate(openingDate))}`
            : 'Cambio en la fecha de apertura',
          body: openingDate
            ? `Ya tenemos fecha: el local ${c.unit.facility.name} abre el ${dayLabel(asDate(openingDate))}. Ese día empieza tu alquiler del trastero ${c.unit.code} y te enviaremos tu código de acceso.`
            : `La fecha de apertura del local ${c.unit.facility.name} aún no está confirmada. Te avisaremos en cuanto la tengamos. Tu reserva del trastero ${c.unit.code} sigue en pie.`,
          source: 'pre_opening.date_changed',
        });
      }
    }
    return rows.length;
  }

  /** Cada día: arranca las reservas de los locales que abren hoy y recuerda las que abren pronto. */
  async runDue(): Promise<{ started: number; reminded: number }> {
    const facilities = await this.admin.facility.findMany({
      where: { preOpening: true, deletedAt: null, openingDate: { not: null } },
      select: { id: true, tenantId: true, timezone: true, openingDate: true },
    });
    let started = 0;
    let reminded = 0;
    for (const f of facilities) {
      const today = ymd(todayInTimezone(f.timezone));
      const opening = ymd(f.openingDate!);
      try {
        if (opening <= today) {
          started += await this.startFacility(f.tenantId, f.id, opening);
        } else {
          reminded += await this.remindSoon(f.tenantId, f.id, today, opening);
        }
      } catch (err) {
        this.logger.warn(`pre-opening ${f.id}: ${(err as Error).message}`);
      }
    }
    return { started, reminded };
  }

  /** Aviso 3 días antes de abrir (una vez por reserva). */
  private async remindSoon(
    tenantId: string,
    facilityId: string,
    today: string,
    opening: string,
  ): Promise<number> {
    const threeDays = new Date(asDate(today).getTime() + 3 * 86_400_000);
    if (asDate(opening) > threeDays) return 0;
    const rows = (await this.pendingContracts(tenantId, facilityId)).filter(
      (c) => c.status !== 'draft' && !c.preOpeningReminderSentAt,
    );
    let sent = 0;
    for (const c of rows) {
      const claim = await this.admin.contract.updateMany({
        where: { id: c.id, preOpeningReminderSentAt: null },
        data: { preOpeningReminderSentAt: new Date() },
      });
      if (claim.count === 0) continue;
      await this.notify(tenantId, c, {
        subject: `Tu trastero estará listo el ${dayLabel(asDate(opening))}`,
        body: `El local ${c.unit.facility.name} abre el ${dayLabel(asDate(opening))}. Ese día te enviaremos tu código de acceso al trastero ${c.unit.code}.`,
        source: 'pre_opening.reminder',
      });
      sent += 1;
    }
    return sent;
  }

  /**
   * El local abre: sus reservas empiezan. El trastero pasa a ocupado, la
   * facturación recurrente sigue al mes siguiente (la primera mensualidad ya
   * está pagada) y llega el acceso. El local deja de estar en «próxima apertura».
   */
  private async startFacility(
    tenantId: string,
    facilityId: string,
    openingDay: string,
  ): Promise<number> {
    await this.admin.facility.update({
      where: { id: facilityId },
      data: { preOpening: false, openingDate: asDate(openingDay) },
    });
    const rows = await this.pendingContracts(tenantId, facilityId);
    let started = 0;
    for (const c of rows) {
      const claim = await this.admin.contract.updateMany({
        where: { id: c.id, preOpeningStartedAt: null },
        data: {
          preOpeningStartedAt: new Date(),
          preOpeningDateConfirmed: true,
          startDate: asDate(openingDay),
          billingStartsOn: asDate(addMonthsYmd(openingDay, 1)),
        },
      });
      if (claim.count === 0) continue;
      started += 1;
      // Un borrador (reserva sin firmar) sigue su curso como un alta normal.
      if (c.status === 'draft') continue;
      const unit = await this.admin.unit.findUnique({
        where: { id: c.unitId },
        select: { status: true },
      });
      if (unit?.status === 'reserved') {
        await this.admin.unit.update({ where: { id: c.unitId }, data: { status: 'occupied' } });
        await this.admin.unitStatusHistory.create({
          data: {
            tenantId,
            unitId: c.unitId,
            previousStatus: 'reserved',
            newStatus: 'occupied',
            reason: `Apertura del local: empieza el contrato ${c.contractNumber}`,
          },
        });
      }
      await this.admin.contractEvent.create({
        data: {
          tenantId,
          contractId: c.id,
          eventType: 'note_added',
          payload: { kind: 'pre_opening_started', openingDay },
        },
      });
      this.events.emit(DOMAIN_EVENTS.contract_pre_opening_started, {
        tenantId,
        contractId: c.id,
        customerId: c.customerId,
      } satisfies ContractPreOpeningStartedPayload);
      await this.notify(tenantId, c, {
        subject: `¡Ya hemos abierto! Tu trastero ${c.unit.code} está listo`,
        body: `El local ${c.unit.facility.name} ya está abierto y hoy empieza tu alquiler del trastero ${c.unit.code}. Si ya has pagado tu reserva, en unos minutos recibirás tu código de acceso (también lo verás en tu área de clientes).`,
        source: 'pre_opening.started',
      });
    }
    if (started > 0) this.logger.log(`Local ${facilityId} abierto: ${started} reservas empiezan`);
    return started;
  }

  // ---------------------------------------------------------------------------
  // Cancelación antes de empezar
  // ---------------------------------------------------------------------------

  async cancelPreview(
    tenantId: string,
    contractId: string,
    opts: { customerId?: string; facilityScope?: string[] | null } = {},
  ): Promise<PreOpeningCancelPreviewDto> {
    const c = await this.loadForCancel(tenantId, contractId, opts);
    return c.preview;
  }

  async cancel(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    customerId?: string;
    facilityScope?: string[] | null;
    reason?: string;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const { contract, preview, rentInvoice } = await this.loadForCancel(
      args.tenantId,
      args.contractId,
      args,
    );
    if (!preview.allowed) {
      throw new BadRequestException({
        code: 'pre_opening_started',
        message: 'El alquiler ya ha empezado: se da de baja como cualquier contrato',
      });
    }
    const why =
      preview.reason === 'withdrawal'
        ? 'Desistimiento dentro de los 14 días'
        : preview.reason === 'not_opened_in_time'
          ? 'El local no abrió en el plazo máximo'
          : 'Cancelación de la reserva antes de la apertura';
    // 1. La primera mensualidad: se devuelve si se cobró; si no, se anula.
    if (rentInvoice) {
      const paid = subtractAmounts(rentInvoice.amountPaid, rentInvoice.amountRefunded);
      if (paid > 0) {
        await this.invoices.refund({
          tenantId: args.tenantId,
          userId: args.userId,
          invoiceId: rentInvoice.id,
          input: { amount: paid, reason: why },
          meta: args.meta,
        });
      } else if (rentInvoice.status === 'issued' || rentInvoice.status === 'overdue') {
        await this.invoices.cancel({
          tenantId: args.tenantId,
          userId: args.userId,
          invoiceId: rentInvoice.id,
          input: { reason: why },
          meta: args.meta,
        });
      }
    }
    // 2. La fianza: se devuelve entera o se retiene (arras) con constancia.
    if (contract.depositStatus === 'held') {
      await this.contracts.settleDeposit({
        tenantId: args.tenantId,
        userId: args.userId,
        contractId: args.contractId,
        input: preview.refundDeposit
          ? { returnedAmount: Number(contract.depositAmount) }
          : {
              returnedAmount: 0,
              retentionReason:
                'Cancelación de la reserva anticipada pasados los 14 días de desistimiento (arras penitenciales, art. 1454 del Código Civil)',
            },
        meta: args.meta,
      });
    } else {
      await this.cancelUnpaidDeposit(args.tenantId, args.contractId, why, args);
    }
    // 3. El contrato se cancela y el trastero vuelve a estar libre.
    const dto = await this.contracts.cancel({
      tenantId: args.tenantId,
      userId: args.userId,
      contractId: args.contractId,
      input: { reason: args.reason?.trim() || why },
      meta: args.meta,
    });
    // Aviso al equipo: la fianza (y lo cobrado en efectivo o por transferencia)
    // se devuelve a mano.
    const toReturn = [
      preview.rentAmount > 0 ? `primera mensualidad ${formatEur(preview.rentAmount)}` : null,
      preview.refundDeposit && preview.depositAmount > 0
        ? `fianza ${formatEur(preview.depositAmount)}`
        : null,
    ].filter(Boolean);
    await this.admin.notification
      .create({
        data: {
          tenantId: args.tenantId,
          facilityId: contract.unit.facilityId,
          type: 'contract.pre_opening_cancelled',
          title: `Reserva cancelada antes de la apertura — ${contract.contractNumber}`,
          body: toReturn.length
            ? `${why}. A devolver: ${toReturn.join(' y ')}. Los cobros con tarjeta se devuelven solos; la fianza y los cobros en efectivo o por transferencia, a mano.`
            : `${why}.`,
          link: `/contracts/${args.contractId}`,
        },
      })
      .catch(() => undefined);
    await this.admin.contractEvent.create({
      data: {
        tenantId: args.tenantId,
        contractId: args.contractId,
        eventType: 'note_added',
        payload: {
          kind: 'pre_opening_cancelled',
          reason: preview.reason,
          refundRent: preview.refundRent,
          refundDeposit: preview.refundDeposit,
          by: args.customerId ? 'customer' : 'staff',
        },
      },
    });
    return dto;
  }

  /** Justificante de fianza sin cobrar: se anula para que no quede como deuda. */
  private async cancelUnpaidDeposit(
    tenantId: string,
    contractId: string,
    reason: string,
    args: { userId: string | null; meta: RequestMeta },
  ): Promise<void> {
    const receipts = await this.admin.invoice.findMany({
      where: {
        tenantId,
        contractId,
        kind: 'deposit_receipt',
        status: { in: ['draft', 'issued', 'overdue'] },
        deletedAt: null,
      },
      select: { id: true },
    });
    for (const r of receipts) {
      await this.invoices
        .cancel({
          tenantId,
          userId: args.userId,
          invoiceId: r.id,
          input: { reason },
          meta: args.meta,
        })
        .catch((err: unknown) =>
          this.logger.warn(`fianza ${r.id} sin anular: ${(err as Error).message}`),
        );
    }
  }

  private async loadForCancel(
    tenantId: string,
    contractId: string,
    opts: { customerId?: string; facilityScope?: string[] | null },
  ) {
    const contract = await this.admin.contract.findFirst({
      where: {
        id: contractId,
        tenantId,
        deletedAt: null,
        ...(opts.customerId ? { customerId: opts.customerId } : {}),
      },
      include: { unit: { select: { facilityId: true, facility: { select: { timezone: true } } } } },
    });
    if (!contract) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    assertFacilityAllowed(opts.facilityScope, contract.unit.facilityId);
    if (!contract.preOpening || contract.status === 'cancelled' || contract.status === 'ended') {
      throw new BadRequestException({
        code: 'not_pre_opening',
        message: 'No es una reserva antes de la apertura',
      });
    }
    const tz = contract.unit.facility.timezone;
    const signedOn = ymd(todayInTimezone(tz, contract.signedAt ?? contract.createdAt));
    const outcome = preOpeningCancelOutcome({
      signedOn,
      today: ymd(todayInTimezone(tz)),
      deadline: contract.preOpeningDeadline ? ymd(contract.preOpeningDeadline) : null,
      started: !isPendingPreOpening(contract),
    });
    const rentInvoice = await this.admin.invoice.findFirst({
      where: { tenantId, contractId, kind: 'invoice', deletedAt: null, rectifiesInvoiceId: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, total: true, amountPaid: true, amountRefunded: true },
    });
    const rentAmount = rentInvoice
      ? subtractAmounts(rentInvoice.amountPaid, rentInvoice.amountRefunded)
      : 0;
    const depositAmount = contract.depositStatus === 'held' ? Number(contract.depositAmount) : 0;
    const preview: PreOpeningCancelPreviewDto = { ...outcome, rentAmount, depositAmount };
    return { contract, preview, rentInvoice };
  }

  // ---------------------------------------------------------------------------

  private async findFacility(tenantId: string, facilityId: string) {
    const f = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({
          where: { id: facilityId, deletedAt: null },
          select: {
            id: true,
            timezone: true,
            preOpening: true,
            openingDate: true,
            preOpeningMaxMonths: true,
          },
        }),
      tenantId,
    );
    if (!f)
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    return f;
  }

  private pendingCount(tenantId: string, facilityId: string): Promise<number> {
    return this.admin.contract.count({
      where: {
        tenantId,
        preOpening: true,
        preOpeningStartedAt: null,
        status: { in: ['active', 'ending'] },
        deletedAt: null,
        unit: { facilityId },
      },
    });
  }

  /** Reservas sin empezar del local (firmadas y borradores). */
  private pendingContracts(tenantId: string, facilityId: string) {
    return this.admin.contract.findMany({
      where: {
        tenantId,
        preOpening: true,
        preOpeningStartedAt: null,
        status: { in: ['draft', 'active', 'ending'] },
        deletedAt: null,
        unit: { facilityId },
      },
      select: {
        id: true,
        contractNumber: true,
        status: true,
        unitId: true,
        customerId: true,
        startDate: true,
        preOpeningDeadline: true,
        preOpeningReminderSentAt: true,
        unit: { select: { code: true, facility: { select: { name: true } } } },
        customer: { select: { email: true, firstName: true, companyName: true } },
      },
    });
  }

  private async notify(
    tenantId: string,
    c: {
      id: string;
      customerId: string;
      customer: { email: string | null; firstName: string | null; companyName: string | null };
    },
    msg: { subject: string; body: string; source: string },
  ): Promise<void> {
    if (!c.customer.email) return;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const name = c.customer.firstName || c.customer.companyName || '';
    await this.communications
      .enqueue({
        tenantId,
        channel: 'email',
        recipient: c.customer.email,
        subject: msg.subject,
        bodyText: `Hola${name ? ` ${name}` : ''},\n\n${msg.body}\n\nGracias por confiar en ${tenant?.name ?? 'nosotros'}.`,
        source: msg.source,
        customerId: c.customerId,
        contractId: c.id,
      })
      .catch((err: unknown) =>
        this.logger.warn(`aviso de apertura sin enviar: ${(err as Error).message}`),
      );
  }
}
