import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';

import { JOB_BILLING_INVOICE_PDF, QUEUE_BILLING } from '../queues/queues.module';

import { INVOICE_PDF_REQUESTED, type InvoicePdfRequestedPayload } from './invoices.service';

/**
 * Cada factura emitida (y cada justificante de fianza) tiene su PDF sin que
 * nadie lo pida: sale en el correo, en el área de clientes y en el ZIP anual.
 * Se genera en el worker (Chromium), con reintentos.
 *
 * En las pruebas no se genera (cada emisión abriría un navegador), salvo con
 * `INVOICE_PDF_IN_TESTS=true`.
 */
@Injectable()
export class InvoicePdfJobsService {
  private readonly logger = new Logger(InvoicePdfJobsService.name);

  constructor(@InjectQueue(QUEUE_BILLING) private readonly queue: Queue) {}

  @OnEvent(INVOICE_PDF_REQUESTED, { async: true })
  async onRequested(p: InvoicePdfRequestedPayload): Promise<void> {
    if (process.env.NODE_ENV === 'test' && process.env.INVOICE_PDF_IN_TESTS !== 'true') return;
    try {
      await this.queue.add(JOB_BILLING_INVOICE_PDF, p, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 7 * 86_400 },
      });
    } catch (err) {
      this.logger.warn(`PDF de ${p.invoiceId} sin encolar: ${String(err)}`);
    }
  }
}
