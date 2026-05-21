import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { VerifactuService } from './verifactu.service';

/**
 * Cron que recupera facturas con `aeat_status='pending'` cuyo envio quedo
 * huerfano (timeout, respuesta sin `EstadoRegistro`, etc.) y consulta a
 * AEAT el estado actual. Se ejecuta cada 15 minutos.
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

  constructor(
    private readonly verifactu: VerifactuService,
    private readonly admin: PrismaAdminService,
  ) {}

  @Cron('*/15 * * * *', { name: 'verifactu-status.poll-orphans' })
  async pollOrphans(): Promise<void> {
    const cutoff = new Date(Date.now() - VerifactuStatusPollerCron.COOLDOWN_MS);
    const pending = await this.admin.invoice.findMany({
      where: {
        aeatStatus: 'pending',
        aeatSentAt: { lt: cutoff },
      },
      select: { id: true, tenantId: true },
      take: VerifactuStatusPollerCron.BATCH_SIZE,
    });

    if (pending.length === 0) return;

    this.logger.debug(`[verifactu-status.poll] ${pending.length} pendiente(s) a consultar`);

    for (const inv of pending) {
      try {
        await this.verifactu.refreshStatus(inv.id, inv.tenantId);
      } catch (err) {
        this.logger.warn(
          `[verifactu-status.poll] error consultando invoice ${inv.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
