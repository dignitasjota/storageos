import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  NON_CASH_PAYMENT_METHODS,
  withdrawalKeptCents,
  withdrawalUsedDays,
  type ContractDto,
  type ContractWithdrawalDto,
  type WithdrawalBlockReason,
  type WithdrawContractInput,
} from '@storageos/shared';

import { assertFacilityAllowed } from '../../common/facility-scope';
import { formatDateLong, formatEur, todayInTimezone } from '../../common/format';
import { toCents } from '../../common/money';
import { isPendingPreOpening } from '../../common/pre-opening';
import { AuditService } from '../auth/audit.service';
import { InvoicesService } from '../billing/invoices.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { ContractRefundsService } from './contract-refunds.service';
import { ContractsService } from './contracts.service';

import type { RequestMeta } from '../auth/auth.service';

const ymd = (d: Date) => d.toISOString().slice(0, 10);

const BLOCK_MESSAGES: Record<WithdrawalBlockReason, string> = {
  not_applicable:
    'Este contrato no lo firmó a distancia un particular: se da de baja como cualquier otro',
  deadline_passed:
    'Han pasado los 14 días para desistir: se da de baja con el preaviso del contrato',
  not_signed: 'El contrato aún no está firmado: se cancela sin más',
  pre_opening: 'Es una reserva antes de la apertura: se cancela como reserva',
  closed: 'El contrato ya está cerrado',
};

interface RentDocument {
  id: string;
  invoiceNumber: string | null;
  status: string;
  /** Dinero cobrado alguna vez (sin compensaciones ni retenciones), en céntimos. */
  collectedCents: number;
  /** Lo ya devuelto, en céntimos. */
  refundedCents: number;
  /** Lo que se queda el arrendador por los días usados, en céntimos. */
  keptCents: number;
  /** Lo que queda por devolver, en céntimos. */
  refundCents: number;
}

/**
 * Desistimiento de los contratos que un particular firma a distancia (art. 102
 * y siguientes del TRLGDCU): en los 14 días naturales siguientes a la firma se
 * devuelve lo pagado (menos los días usados, si pidió empezar antes) y la fianza
 * entera, y el contrato se cancela.
 */
@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly contracts: ContractsService,
    private readonly invoices: InvoicesService,
    private readonly refunds: ContractRefundsService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
  ) {}

  async preview(
    tenantId: string,
    contractId: string,
    opts: { customerId?: string; facilityScope?: string[] | null; communicatedOn?: string } = {},
  ): Promise<ContractWithdrawalDto> {
    const { preview } = await this.load(tenantId, contractId, opts);
    return preview;
  }

  async withdraw(args: {
    tenantId: string;
    userId: string | null;
    contractId: string;
    customerId?: string;
    facilityScope?: string[] | null;
    input: WithdrawContractInput;
    meta: RequestMeta;
  }): Promise<ContractDto> {
    const { contract, preview, rent, deposit } = await this.load(args.tenantId, args.contractId, {
      ...(args.customerId ? { customerId: args.customerId } : {}),
      ...(args.facilityScope !== undefined ? { facilityScope: args.facilityScope } : {}),
      ...(args.input.communicatedOn ? { communicatedOn: args.input.communicatedOn } : {}),
    });
    if (!preview.allowed && preview.reason) {
      throw new BadRequestException({
        code: 'withdrawal_not_allowed',
        message: BLOCK_MESSAGES[preview.reason],
        details: { reason: preview.reason },
      });
    }
    // Se reserva antes de devolver nada: dos peticiones a la vez (doble clic,
    // inquilino y equipo) no devuelven el dinero dos veces.
    const claim = await this.admin.contract.updateMany({
      where: {
        id: args.contractId,
        tenantId: args.tenantId,
        withdrawnAt: null,
        status: { in: ['active', 'ending'] },
      },
      data: { withdrawnAt: new Date() },
    });
    if (claim.count === 0) {
      throw new ConflictException({
        code: 'already_withdrawn',
        message: 'El desistimiento ya se ha registrado',
      });
    }

    const why = `Desistimiento comunicado el ${formatDateLong(new Date(`${preview.communicatedOn}T00:00:00Z`), 'UTC')}`;
    const automatic: string[] = [];
    const manual: string[] = [];
    const bank: string[] = [];
    const review: string[] = [];
    const push = (how: 'gateway' | 'manual' | 'bank', what: string) =>
      (how === 'gateway' ? automatic : how === 'bank' ? bank : manual).push(what);
    let dto: ContractDto;
    try {
      // 1. Cuotas: se devuelve lo cobrado menos los días usados; lo que no se
      //    cobró se anula. Una factura con un cobro parcial se revisa a mano.
      for (const doc of rent) {
        const label = doc.invoiceNumber ? `factura ${doc.invoiceNumber}` : 'factura';
        if (doc.status === 'draft') {
          await this.cancelInvoice(args, doc.id, why);
        } else if (doc.status === 'issued' || doc.status === 'overdue') {
          if (doc.collectedCents === 0) await this.cancelInvoice(args, doc.id, why);
          else review.push(`${label} (tiene un cobro parcial)`);
        } else if (doc.refundCents > 0) {
          const how = await this.refunds.refundDocument(args, doc.id, doc.refundCents / 100, why);
          push(how, `${label} ${formatEur(doc.refundCents / 100)}`);
        }
      }
      // 2. Fianza: entera, por el mismo medio por el que se cobró.
      if (deposit.receiptId && deposit.refundCents > 0) {
        const how = await this.refunds.refundDocument(
          args,
          deposit.receiptId,
          deposit.refundCents / 100,
          why,
          true,
        );
        push(how, `fianza ${formatEur(deposit.refundCents / 100)}`);
      }
      await this.refunds.cancelUnpaidDeposit(args.tenantId, args.contractId, why, args);
      if (contract.depositStatus === 'held') {
        await this.contracts.settleDeposit({
          tenantId: args.tenantId,
          userId: args.userId,
          contractId: args.contractId,
          closeUncollected: true,
          input: { returnedAmount: Number(contract.depositAmount) },
          meta: args.meta,
        });
      }
      // 3. El contrato se cancela: libera el trastero y retira los accesos. Lo
      //    pagado por adelantado ya se ha devuelto aquí, sin abono aparte.
      dto = await this.contracts.cancel({
        tenantId: args.tenantId,
        userId: args.userId,
        contractId: args.contractId,
        input: { reason: why },
        skipPrepaidCredit: true,
        meta: args.meta,
      });
    } catch (err) {
      // Lo devuelto queda devuelto (repetirlo solo devuelve lo que falte).
      await this.admin.contract
        .updateMany({
          where: { id: args.contractId, tenantId: args.tenantId, status: { not: 'cancelled' } },
          data: { withdrawnAt: null },
        })
        .catch(() => undefined);
      throw err;
    }

    const by = args.customerId ? 'customer' : 'staff';
    const parts = [
      automatic.length ? `Devuelto por la pasarela: ${automatic.join(', ')}.` : null,
      manual.length
        ? `A devolver a mano (efectivo, transferencia o tarjeta del TPV): ${manual.join(', ')}.`
        : null,
      bank.length
        ? `A devolver desde el TPV de Redsys y registrar en la factura: ${bank.join(', ')}.`
        : null,
      review.length ? `Revisar: ${review.join(', ')}.` : null,
    ].filter(Boolean);
    await this.admin.notification
      .create({
        data: {
          tenantId: args.tenantId,
          facilityId: contract.unit.facilityId,
          type: 'contract.withdrawn',
          title: `Desistimiento — ${contract.contractNumber}`,
          body: [
            `${by === 'customer' ? 'El inquilino ha desistido desde su área de clientes' : 'Desistimiento registrado'} (${why.toLowerCase()}).`,
            ...parts,
            'Plazo para devolverlo: 14 días.',
          ].join(' '),
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
          kind: 'withdrawn',
          by,
          communicatedOn: preview.communicatedOn,
          immediateStartRequested: preview.immediateStartRequested,
          usedDays: preview.usedDays,
          rentRefund: preview.rentRefund,
          rentKept: preview.rentKept,
          depositRefund: preview.depositRefund,
          note: args.input.note?.trim() || null,
        },
        createdByUserId: args.userId,
      },
    });
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.withdrawn',
      entityType: 'Contract',
      entityId: args.contractId,
      changes: {
        by,
        communicatedOn: preview.communicatedOn,
        rentRefund: preview.rentRefund,
        rentKept: preview.rentKept,
        depositRefund: preview.depositRefund,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    await this.acknowledge(args.tenantId, contract, preview);
    return dto;
  }

  /**
   * Acuse de recibo en un soporte duradero (art. 106.3 TRLGDCU): el desistimiento
   * queda registrado y se dice cuánto se devuelve.
   */
  private async acknowledge(
    tenantId: string,
    contract: Awaited<ReturnType<WithdrawalService['load']>>['contract'],
    preview: ContractWithdrawalDto,
  ): Promise<void> {
    const email = contract.customer.email;
    if (!email) return;
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const en = contract.customer.locale === 'en';
    const name = contract.customer.firstName || contract.customer.companyName || '';
    const total = preview.rentRefund + preview.depositRefund;
    const lang = en ? 'en' : 'es';
    const day = formatDateLong(new Date(`${preview.communicatedOn}T00:00:00Z`), 'UTC', lang);
    const amount = (n: number) => formatEur(n, lang);
    const lines = en
      ? [
          `We have registered your withdrawal from contract ${contract.contractNumber} (storage unit ${contract.unit.code} at ${contract.unit.facility.name}), notified on ${day}.`,
          total > 0
            ? `We will refund ${amount(total)} (${[
                preview.rentRefund > 0 ? `payments: ${amount(preview.rentRefund)}` : null,
                preview.depositRefund > 0 ? `deposit: ${amount(preview.depositRefund)}` : null,
              ]
                .filter(Boolean)
                .join('; ')}) using the same payment method, within 14 days at the latest.`
            : 'You have nothing to pay and nothing is pending refund.',
          preview.rentKept > 0
            ? `${amount(preview.rentKept)} is deducted for ${preview.usedDays === 1 ? 'the day' : `the ${preview.usedDays} days`} you had the unit, because you asked to start before the withdrawal period ended.`
            : null,
          'Your access to the facility has been cancelled.',
        ]
      : [
          `Hemos registrado tu desistimiento del contrato ${contract.contractNumber} (trastero ${contract.unit.code} en ${contract.unit.facility.name}), comunicado el ${day}.`,
          total > 0
            ? `Te devolvemos ${amount(total)} (${[
                preview.rentRefund > 0 ? `cuotas: ${amount(preview.rentRefund)}` : null,
                preview.depositRefund > 0 ? `fianza: ${amount(preview.depositRefund)}` : null,
              ]
                .filter(Boolean)
                .join('; ')}) por el mismo medio de pago, en un plazo máximo de 14 días.`
            : 'No tienes nada que pagar ni nada pendiente de devolver.',
          preview.rentKept > 0
            ? `Se descuentan ${amount(preview.rentKept)} por ${preview.usedDays === 1 ? 'el día' : `los ${preview.usedDays} días`} que has tenido el trastero, porque pediste empezar antes de que acabara el plazo para desistir.`
            : null,
          'Tu acceso al local queda dado de baja.',
        ];
    const greeting = en ? `Hello${name ? ` ${name}` : ''},` : `Hola${name ? ` ${name}` : ''},`;
    const signoff = en
      ? `Thank you, ${tenant?.name ?? 'the team'}.`
      : `Gracias, ${tenant?.name ?? 'el equipo'}.`;
    await this.communications
      .enqueue({
        tenantId,
        channel: 'email',
        recipient: email,
        subject: en
          ? `We have received your withdrawal — ${contract.contractNumber}`
          : `Hemos recibido tu desistimiento — ${contract.contractNumber}`,
        bodyText: [greeting, '', ...lines.filter(Boolean), '', signoff].join('\n'),
        source: 'contract.withdrawal',
        customerId: contract.customerId,
        contractId: contract.id,
      })
      .catch((err: unknown) =>
        this.logger.warn(`acuse de desistimiento sin enviar: ${(err as Error).message}`),
      );
  }

  private async cancelInvoice(
    args: { tenantId: string; userId: string | null; meta: RequestMeta },
    invoiceId: string,
    reason: string,
  ): Promise<void> {
    await this.invoices.cancel({
      tenantId: args.tenantId,
      userId: args.userId,
      invoiceId,
      input: { reason },
      meta: args.meta,
    });
  }

  private async load(
    tenantId: string,
    contractId: string,
    opts: { customerId?: string; facilityScope?: string[] | null; communicatedOn?: string },
  ) {
    const contract = await this.admin.contract.findFirst({
      where: {
        id: contractId,
        tenantId,
        deletedAt: null,
        ...(opts.customerId ? { customerId: opts.customerId } : {}),
      },
      select: {
        id: true,
        contractNumber: true,
        status: true,
        customerId: true,
        startDate: true,
        signedAt: true,
        withdrawalDeadline: true,
        immediateStartRequestedAt: true,
        withdrawnAt: true,
        preOpening: true,
        preOpeningStartedAt: true,
        depositStatus: true,
        depositAmount: true,
        unit: {
          select: {
            code: true,
            facilityId: true,
            facility: { select: { name: true, timezone: true } },
          },
        },
        customer: {
          select: { email: true, firstName: true, companyName: true, locale: true },
        },
      },
    });
    if (!contract) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    assertFacilityAllowed(opts.facilityScope, contract.unit.facilityId);

    const tz = contract.unit.facility.timezone;
    const today = ymd(todayInTimezone(tz));
    const communicatedOn = opts.communicatedOn ?? today;
    if (communicatedOn > today) {
      throw new BadRequestException({
        code: 'invalid_communicated_on',
        message: 'La fecha en que lo comunicó no puede ser posterior a hoy',
      });
    }
    const signedOn = contract.signedAt ? ymd(todayInTimezone(tz, contract.signedAt)) : null;
    if (signedOn && communicatedOn < signedOn) {
      throw new BadRequestException({
        code: 'invalid_communicated_on',
        message: 'La fecha en que lo comunicó no puede ser anterior a la firma',
      });
    }
    const deadline = contract.withdrawalDeadline ? ymd(contract.withdrawalDeadline) : null;
    const reason: WithdrawalBlockReason | null =
      contract.withdrawnAt || contract.status === 'ended' || contract.status === 'cancelled'
        ? 'closed'
        : contract.status === 'draft'
          ? 'not_signed'
          : !deadline
            ? 'not_applicable'
            : isPendingPreOpening(contract)
              ? 'pre_opening'
              : communicatedOn > deadline
                ? 'deadline_passed'
                : null;

    const startDate = ymd(contract.startDate);
    const immediateStartRequested = contract.immediateStartRequestedAt !== null;
    const invoices = await this.admin.invoice.findMany({
      where: {
        tenantId,
        contractId,
        deletedAt: null,
        rectifiesInvoiceId: null,
        status: { notIn: ['cancelled', 'rectified'] },
      },
      select: {
        id: true,
        kind: true,
        invoiceNumber: true,
        status: true,
        amountRefunded: true,
        periodStart: true,
        periodEnd: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const payments = invoices.length
      ? await this.admin.payment.findMany({
          where: {
            invoiceId: { in: invoices.map((i) => i.id) },
            status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
            methodType: { notIn: [...NON_CASH_PAYMENT_METHODS] },
          },
          select: { invoiceId: true, amount: true },
        })
      : [];
    const collected = new Map<string, number>();
    for (const p of payments) {
      if (!p.invoiceId) continue;
      collected.set(p.invoiceId, (collected.get(p.invoiceId) ?? 0) + toCents(p.amount));
    }

    const rent: RentDocument[] = [];
    let depositReceiptId: string | null = null;
    let depositRefundCents = 0;
    for (const inv of invoices) {
      const collectedCents = collected.get(inv.id) ?? 0;
      const refundedCents = toCents(inv.amountRefunded);
      if (inv.kind === 'deposit_receipt') {
        if (collectedCents - refundedCents > 0) {
          depositReceiptId = inv.id;
          depositRefundCents += collectedCents - refundedCents;
        }
        continue;
      }
      if (inv.kind !== 'invoice') continue;
      // Lo que se queda por los días usados sale de lo cobrado de esa factura;
      // sin periodo (p. ej. un recargo) no hay días que descontar.
      const keptCents =
        inv.periodStart && inv.periodEnd
          ? withdrawalKeptCents({
              paidCents: collectedCents,
              periodStart: ymd(inv.periodStart),
              periodEnd: ymd(inv.periodEnd),
              startDate,
              communicatedOn,
              immediateStartRequested,
            })
          : 0;
      rent.push({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        collectedCents,
        refundedCents,
        keptCents,
        refundCents: Math.max(0, collectedCents - keptCents - refundedCents),
      });
    }

    const paidCents = rent.reduce((s, d) => s + Math.max(0, d.collectedCents - d.refundedCents), 0);
    const refundCents = rent.reduce((s, d) => s + d.refundCents, 0);
    const preview: ContractWithdrawalDto = {
      allowed: reason === null,
      reason,
      deadline,
      communicatedOn,
      immediateStartRequested,
      usedDays: withdrawalUsedDays({ startDate, communicatedOn }),
      rentPaid: paidCents / 100,
      rentKept: Math.max(0, paidCents - refundCents) / 100,
      rentRefund: refundCents / 100,
      depositRefund: depositRefundCents / 100,
    };
    return {
      contract,
      preview,
      rent,
      deposit: { receiptId: depositReceiptId, refundCents: depositRefundCents },
    };
  }
}
