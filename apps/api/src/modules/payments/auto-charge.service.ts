import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_PAYMENTS_AUTO_CHARGE, QUEUE_PAYMENTS } from '../queues/queues.module';

import { PaymentsService } from './payments.service';

export interface AutoChargeJobData {
  tenantId: string;
  invoiceId: string;
}

/**
 * Cobro automatico al emitir factura (opt-in por tenant via
 * `tenants.auto_charge_on_issue`).
 *
 * El listener `@OnEvent` corre SIEMPRE en el API (los eventos de dominio se
 * emiten in-process por `InvoicesService.issue`); solo encola. El cobro
 * real lo hace `processAutoCharge` desde la cola BullMQ `payments`
 * (consumida por el worker en produccion, o por el API con
 * `ENABLE_WORKERS_IN_API=true`), para no bloquear el issue con Stripe.
 *
 * Filosofia de skips: cualquier factura no cobrable (F2 sin customer, sin
 * metodo de pago default, pendiente <= 0, flag apagado entre el encolado y
 * el proceso) se salta con log y el job termina OK. Un cobro RECHAZADO por
 * el gateway tampoco lanza: el payment queda `failed` y entra el dunning;
 * los retries de BullMQ quedan reservados para errores de infraestructura.
 */
@Injectable()
export class AutoChargeService {
  private readonly logger = new Logger(AutoChargeService.name);

  constructor(
    @InjectQueue(QUEUE_PAYMENTS) private readonly queue: Queue,
    private readonly admin: PrismaAdminService,
    private readonly payments: PaymentsService,
  ) {}

  @OnEvent(DOMAIN_EVENTS.invoice_issued)
  async onInvoiceIssued(payload: DomainEventPayload): Promise<void> {
    try {
      const tenant = await this.admin.tenant.findUnique({
        where: { id: payload.tenantId },
        select: { autoChargeOnIssue: true },
      });
      if (!tenant?.autoChargeOnIssue) return;
      await this.queue.add(JOB_PAYMENTS_AUTO_CHARGE, {
        tenantId: payload.tenantId,
        invoiceId: payload.entityId,
      } satisfies AutoChargeJobData);
      this.logger.log(
        `[auto-charge] encolado cobro para invoice ${payload.entityId} (tenant ${payload.tenantId})`,
      );
    } catch (err) {
      // Defensivo: un fallo aqui no debe romper el issue ni el resto de
      // listeners del evento.
      this.logger.error(
        `[auto-charge] error encolando invoice ${payload.entityId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  async processAutoCharge(data: AutoChargeJobData): Promise<{ charged: boolean; reason?: string }> {
    const { tenantId, invoiceId } = data;
    // Re-chequear el flag: pudo apagarse entre el encolado y el proceso.
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { autoChargeOnIssue: true },
    });
    if (!tenant?.autoChargeOnIssue) {
      return this.skip(invoiceId, 'flag_disabled');
    }
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, deletedAt: null },
      select: { id: true, status: true, customerId: true, total: true, amountPaid: true },
    });
    if (!invoice) return this.skip(invoiceId, 'invoice_not_found');
    if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
      return this.skip(invoiceId, `status_${invoice.status}`);
    }
    if (!invoice.customerId) return this.skip(invoiceId, 'no_customer'); // F2
    if (Number(invoice.total) - Number(invoice.amountPaid) <= 0) {
      return this.skip(invoiceId, 'nothing_pending');
    }
    const defaultPm = await this.admin.paymentMethod.findFirst({
      where: {
        tenantId,
        customerId: invoice.customerId,
        isDefault: true,
        deletedAt: null,
        type: { in: ['card', 'sepa_debit'] },
      },
      select: { id: true },
    });
    if (!defaultPm) return this.skip(invoiceId, 'no_payment_method');

    const payment = await this.payments.chargeInvoice({
      tenantId,
      userId: null,
      invoiceId,
      input: {},
      meta: {},
    });
    this.logger.log(
      `[auto-charge] invoice ${invoiceId} -> payment ${payment.id} (${payment.status})`,
    );
    return { charged: true };
  }

  private skip(invoiceId: string, reason: string): { charged: false; reason: string } {
    this.logger.log(`[auto-charge] skip invoice ${invoiceId}: ${reason}`);
    return { charged: false, reason };
  }
}
