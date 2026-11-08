import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_VERIFACTU_SEND, QUEUE_VERIFACTU } from '../queues/queues.module';

import { emitterKey, sendJobId } from './verifactu-flow';

import type { Prisma } from '@storageos/database';

/** Un trabajo de la cola `verifactu`: enviar lo pendiente de un emisor. */
export interface VerifactuSendJobData {
  tenantId: string;
  /** Emisor propietario (plan Administrador); null = el propio negocio. */
  ownerId?: string | null;
  /** Los trabajos encolados antes de enviar en lotes eran por factura. */
  invoiceId?: string;
}

/**
 * Los reintentos de la cola son solo para fallos inesperados (la base de datos
 * caída…): los de la AEAT los gestiona el propio envío, que programa el
 * siguiente intento.
 */
const JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 86_400 },
};

/** Registros de Veri*Factu que aún hay que enviar. */
export const PENDING_RECORD_WHERE: Prisma.InvoiceWhereInput = {
  hash: { not: null },
  issuedBy: 'app',
  aeatStatus: { in: ['pending', 'error'] },
};

/**
 * Programa los envíos a la AEAT. Cada emisor tiene un único envío en marcha
 * y lo que se emite mientras espera va en el mismo (control de flujo, art.
 * 16.2 de la Orden HAC/1177/2024).
 */
@Injectable()
export class VerifactuDispatcher {
  constructor(
    private readonly admin: PrismaAdminService,
    @InjectQueue(QUEUE_VERIFACTU) private readonly queue: Queue<VerifactuSendJobData>,
  ) {}

  /**
   * Envía lo pendiente del emisor en cuanto se pueda: ya, o cuando acabe la
   * espera que pidió la AEAT o la del reintento tras un fallo. Con `retryNow`
   * (un reenvío a mano, un certificado nuevo) no se espera al reintento.
   */
  async schedule(
    tenantId: string,
    ownerId: string | null,
    opts: { retryNow?: boolean; notBefore?: Date } = {},
  ): Promise<Date> {
    const where = { tenantId_emitterKey: { tenantId, emitterKey: emitterKey(ownerId) } };
    const state = await this.admin.verifactuEmitter.findUnique({
      where,
      select: { nextSendAt: true, retryAt: true },
    });
    let retryAt = state?.retryAt ?? null;
    if (opts.retryNow && retryAt) {
      await this.admin.verifactuEmitter.update({ where, data: { retryAt: null } });
      retryAt = null;
    }
    const now = Date.now();
    const at = Math.max(
      now,
      state?.nextSendAt?.getTime() ?? 0,
      retryAt?.getTime() ?? 0,
      opts.notBefore?.getTime() ?? 0,
    );
    const runAt = new Date(at);
    await this.queue.add(
      JOB_VERIFACTU_SEND,
      { tenantId, ownerId },
      { ...JOB_OPTS, jobId: sendJobId(tenantId, ownerId, runAt), delay: at - now },
    );
    return runAt;
  }

  /** Programa todos los emisores del negocio con registros por enviar. */
  async scheduleTenant(tenantId: string, opts: { retryNow?: boolean } = {}): Promise<number> {
    const emitters = await this.admin.invoice.findMany({
      where: { tenantId, ...PENDING_RECORD_WHERE },
      distinct: ['ownerId'],
      select: { ownerId: true },
    });
    for (const e of emitters) await this.schedule(tenantId, e.ownerId, opts);
    return emitters.length;
  }
}
