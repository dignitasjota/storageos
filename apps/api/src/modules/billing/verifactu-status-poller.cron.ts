import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { PENDING_RECORD_WHERE, VerifactuDispatcher } from './verifactu-dispatcher.service';
import { VerifactuService } from './verifactu.service';

/**
 * Crons de Veri*Factu, cada 15 minutos:
 *   - `requeue`: vuelve a programar el envío de los emisores con registros
 *     atascados (ver `requeueStalled`).
 *   - `poll-orphans`: consulta a la AEAT las facturas con un registro
 *     `pending` que ya salió sin respuesta clara.
 *
 * Politica:
 *   - Solo consideramos pendientes con `aeat_sent_at` mas viejo de 5 min
 *     (para dar margen al envio normal antes de inundarlo con consultas).
 *   - Batch de 50 facturas por iteracion: si quedan mas pendientes, el
 *     siguiente tick las recoge.
 *   - Los errores por factura se loguean pero NO interrumpen al resto:
 *     queremos que un certificado expirado en el tenant A no bloquee al
 *     tenant B.
 *
 * Se registra solo cuando `WORKERS_ENABLED_IN_API=true` (igual que el
 * resto de Crons/Processors) para evitar que el cron corra dos veces en
 * produccion (API + worker).
 */
@Injectable()
export class VerifactuStatusPollerCron {
  private readonly logger = new Logger(VerifactuStatusPollerCron.name);

  /** No re-consultamos AEAT durante los primeros 5 min tras el ultimo envio. */
  private static readonly COOLDOWN_MS = 5 * 60_000;

  /** Batch maximo de facturas por tick para acotar la carga. */
  private static readonly BATCH_SIZE = 50;

  /** Emisores que se vuelven a programar como mucho en cada vuelta. */
  private static readonly EMITTERS_PER_TICK = 200;

  constructor(
    private readonly verifactu: VerifactuService,
    private readonly admin: PrismaAdminService,
    private readonly dispatcher: VerifactuDispatcher,
  ) {}

  /**
   * Red de seguridad: vuelve a programar los emisores con registros por enviar
   * que llevan un rato quietos (un trabajo perdido, Redis reiniciado…). Respeta
   * la espera que pidió la AEAT y la del reintento tras un fallo, que como
   * mucho es de una hora (art. 16.4 de la Orden HAC/1177/2024).
   */
  @Cron('*/15 * * * *', { name: 'verifactu-status.requeue' })
  async requeueStalled(): Promise<void> {
    const cutoff = new Date(Date.now() - VerifactuStatusPollerCron.COOLDOWN_MS);
    const stalled = await this.admin.verifactuRecord.groupBy({
      by: ['tenantId', 'ownerId'],
      where: { ...PENDING_RECORD_WHERE, updatedAt: { lt: cutoff } },
      orderBy: [{ tenantId: 'asc' }, { ownerId: 'asc' }],
      take: VerifactuStatusPollerCron.EMITTERS_PER_TICK,
    });
    for (const e of stalled) {
      try {
        await this.dispatcher.schedule(e.tenantId, e.ownerId);
      } catch (err) {
        this.logger.warn(
          `[verifactu-status.requeue] no se pudo programar el envío del tenant ${e.tenantId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  @Cron('*/15 * * * *', { name: 'verifactu-status.poll-orphans' })
  async pollOrphans(): Promise<void> {
    const cutoff = new Date(Date.now() - VerifactuStatusPollerCron.COOLDOWN_MS);
    const pending = await this.admin.verifactuRecord.findMany({
      where: { status: 'pending', sentAt: { lt: cutoff } },
      select: { invoiceId: true, tenantId: true },
      distinct: ['invoiceId'],
      take: VerifactuStatusPollerCron.BATCH_SIZE,
    });

    if (pending.length === 0) return;

    this.logger.debug(`[verifactu-status.poll] ${pending.length} pendiente(s) a consultar`);

    for (const rec of pending) {
      try {
        await this.verifactu.refreshStatus(rec.invoiceId, rec.tenantId);
      } catch (err) {
        this.logger.warn(
          `[verifactu-status.poll] error consultando invoice ${rec.invoiceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
