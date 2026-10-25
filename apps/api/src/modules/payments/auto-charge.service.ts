import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';

import { RELEASABLE_TENANT } from '../../common/tenant-suspension';
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
      select: { autoChargeOnIssue: true, status: true },
    });
    if (!tenant?.autoChargeOnIssue) {
      return this.skip(invoiceId, 'flag_disabled');
    }
    // Con el tenant suspendido no se cobra a sus inquilinos: queda en espera
    // y `releaseHeld` lo intenta cuando vuelve a estar al día.
    if (tenant.status === 'suspended') {
      await this.admin.invoice.updateMany({
        where: { id: invoiceId, tenantId, chargeHeldAt: null },
        data: { chargeHeldAt: new Date() },
      });
      return this.skip(invoiceId, 'tenant_suspended');
    }
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, deletedAt: null },
      select: {
        id: true,
        status: true,
        customerId: true,
        total: true,
        amountPaid: true,
        productSale: { select: { id: true } },
      },
    });
    if (!invoice) return this.skip(invoiceId, 'invoice_not_found');
    // Las ventas de productos se cobran en el mostrador o desde el portal en el
    // momento: cobrarlas aquí otra vez sería un doble cargo.
    if (invoice.productSale) return this.skip(invoiceId, 'product_sale');
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
      notifyCustomerOnFailure: true,
      meta: {},
    });
    this.logger.log(
      `[auto-charge] invoice ${invoiceId} -> payment ${payment.id} (${payment.status})`,
    );
    return { charged: true };
  }

  /**
   * Cobros retenidos de tenants que ya pagaron su suscripción: se vuelven a
   * encolar (el proceso re-comprueba todo). Cada factura se reclama de forma
   * atómica para no encolarla dos veces entre réplicas.
   */
  async releaseHeld(): Promise<number> {
    const held = await this.admin.invoice.findMany({
      where: { chargeHeldAt: { not: null }, tenant: RELEASABLE_TENANT },
      select: { id: true, tenantId: true },
      take: 500,
    });
    let released = 0;
    for (const inv of held) {
      const claimed = await this.admin.invoice.updateMany({
        where: { id: inv.id, chargeHeldAt: { not: null } },
        data: { chargeHeldAt: null },
      });
      if (claimed.count === 0) continue;
      await this.queue.add(JOB_PAYMENTS_AUTO_CHARGE, {
        tenantId: inv.tenantId,
        invoiceId: inv.id,
      } satisfies AutoChargeJobData);
      released += 1;
    }
    return released;
  }

  private skip(invoiceId: string, reason: string): { charged: false; reason: string } {
    this.logger.log(`[auto-charge] skip invoice ${invoiceId}: ${reason}`);
    return { charged: false, reason };
  }
}
