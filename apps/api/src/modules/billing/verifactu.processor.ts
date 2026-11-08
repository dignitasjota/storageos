import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_VERIFACTU_SEND, QUEUE_VERIFACTU } from '../queues/queues.module';

import { VerifactuService } from './verifactu.service';

import type { VerifactuSendJobData } from './verifactu-dispatcher.service';

export type { VerifactuSendJobData } from './verifactu-dispatcher.service';

/**
 * Worker de la cola `verifactu`: envía a la AEAT lo pendiente de un emisor (el
 * negocio o un propietario) fuera de la petición que emite la factura.
 *
 * Cada trabajo es un emisor y una hora de salida (`VerifactuDispatcher`): las
 * facturas que se emiten mientras se espera van en el mismo envío.
 * `sendPending` guarda el resultado de cada registro y programa el siguiente
 * envío (la espera que pide la AEAT o el reintento tras un fallo), así que el
 * trabajo no lanza por un fallo de la AEAT; solo por uno inesperado (la base de
 * datos caída…), y entonces lo reintenta la cola.
 *
 * Varios a la vez: cada emisor va de uno en uno (lo reserva el propio envío) y
 * emisores distintos no se esperan entre sí.
 */
@Processor(QUEUE_VERIFACTU, { concurrency: 4 })
export class VerifactuProcessor extends WorkerHost {
  private readonly logger = new Logger(VerifactuProcessor.name);

  constructor(
    private readonly verifactu: VerifactuService,
    private readonly admin: PrismaAdminService,
  ) {
    super();
  }

  async process(job: Job<VerifactuSendJobData>): Promise<void> {
    if (job.name !== JOB_VERIFACTU_SEND) {
      this.logger.warn(`Job desconocido en cola verifactu: ${job.name}`);
      return;
    }
    const { tenantId } = job.data;
    let ownerId = job.data.ownerId;
    if (ownerId === undefined) {
      // Trabajo de antes de enviar en lotes (uno por factura): su emisor.
      if (!job.data.invoiceId) return;
      const invoice = await this.admin.invoice.findUnique({
        where: { id: job.data.invoiceId },
        select: { tenantId: true, ownerId: true },
      });
      if (!invoice || invoice.tenantId !== tenantId) return;
      ownerId = invoice.ownerId;
    }
    await this.verifactu.sendPending(tenantId, ownerId ?? null);
  }
}
