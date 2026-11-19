import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DEMO_TENANT_TAG, type PortalDemoCardPaymentResultDto } from '@storageos/shared';

import { subtractAmounts } from '../../common/money';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

/** Nota del cobro simulado: deja claro en el panel que no se cobró nada. */
export const DEMO_CARD_PAYMENT_NOTE =
  'Pago con tarjeta simulado (cuenta de demostración): no se ha cobrado nada';

/**
 * Pago con tarjeta SIMULADO de la cuenta de demostración de los comerciales.
 *
 * No habla con ninguna pasarela (ni Stripe ni Redsys ni ningún banco): apunta el
 * cobro de la factura (y de la fianza que va con ella) como pagado a mano dentro
 * de la propia demo, igual que el equipo cuando cobra en el local. Así se enseña
 * el final de una reserva («pagas y te llega el código de acceso») sin dinero de
 * por medio. Cualquier otro negocio recibe 403.
 */
@Injectable()
export class DemoCardPaymentService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly invoices: InvoicesService,
  ) {}

  /** ¿Es la cuenta de demostración? (la etiqueta la pone su alta). */
  async isDemo(tenantId: string): Promise<boolean> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { tags: true },
    });
    return !!tenant?.tags.includes(DEMO_TENANT_TAG);
  }

  async pay(
    tenantId: string,
    customerId: string,
    invoiceId: string,
  ): Promise<PortalDemoCardPaymentResultDto> {
    if (!(await this.isDemo(tenantId))) {
      throw new ForbiddenException({
        code: 'demo_only',
        message: 'El pago simulado solo existe en la cuenta de demostración',
      });
    }
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, customerId, deletedAt: null },
      select: { id: true, status: true, issueOnPayment: true, total: true, amountPaid: true },
    });
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    const payable =
      invoice.status === 'issued' ||
      invoice.status === 'overdue' ||
      (invoice.status === 'draft' && invoice.issueOnPayment);
    const pending = subtractAmounts(invoice.total, invoice.amountPaid);
    if (!payable || pending <= 0) {
      throw new BadRequestException({ code: 'nothing_to_pay', message: 'No hay nada que pagar' });
    }
    await this.invoices.markPaidManually({
      tenantId,
      userId: null,
      invoiceId,
      input: {
        amount: pending,
        methodType: 'card',
        notes: DEMO_CARD_PAYMENT_NOTE,
        // Con su fianza, en un solo pago (como la reserva online real).
        includeBundledDeposit: true,
        overridePaymentInFlight: true,
      },
      meta: {},
    });
    return { status: 'succeeded' };
  }
}
