import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_VERIFACTU_SEND, QUEUE_VERIFACTU } from '../queues/queues.module';

import { VerifactuService } from './verifactu.service';

export interface VerifactuSendJobData {
  invoiceId: string;
  tenantId: string;
}

/**
 * Worker de la cola `verifactu`. Procesa el envio de facturas a AEAT
 * de forma asincrona, fuera del request original que emite la factura.
 *
 * Politica de retry:
 *   - `accepted` / `accepted_with_warnings`: exito, no se reintenta.
 *   - `rejected`: decision firme de AEAT (datos invalidos, NIF incorrecto,
 *     etc.). NO se reintenta: requiere intervencion manual (corregir y
 *     usar `POST /billing/invoices/:id/resend-aeat`).
 *   - `error`: fallo tecnico (timeout, 5xx, problema de red). Lanzamos
 *     excepcion para que BullMQ aplique el backoff exponencial
 *     configurado al encolar (1m, 5m, 25m con 3 attempts).
 *
 * El estado `aeat_*` en BD ya se ha actualizado dentro de `sendToAeat`
 * antes de devolver el resultado, asi que el ultimo intento siempre deja
 * la BD coherente con lo ocurrido.
 */
@Processor(QUEUE_VERIFACTU, { concurrency: 2 })
export class VerifactuProcessor extends WorkerHost {
  private readonly logger = new Logger(VerifactuProcessor.name);

  constructor(private readonly verifactu: VerifactuService) {
    super();
  }

  async process(job: Job<VerifactuSendJobData>): Promise<void> {
    if (job.name !== JOB_VERIFACTU_SEND) {
      this.logger.warn(`Job desconocido en cola verifactu: ${job.name}`);
      return;
    }
    const { invoiceId, tenantId } = job.data;
    const result = await this.verifactu.sendToAeat(invoiceId, tenantId);
    if (!result) {
      // Factura no enviable (faltan campos). No reintentamos.
      this.logger.warn(`[verifactu] invoice ${invoiceId} sin datos suficientes, no se reintenta`);
      return;
    }
    if (result.status === 'error') {
      // Solo los errores tecnicos detonan el retry exponencial de BullMQ.
      throw new Error(result.message ?? 'aeat_error');
    }
    // accepted / accepted_with_warnings / rejected: el job termina con
    // exito desde la perspectiva de la cola.
  }
}
