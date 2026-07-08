import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaAdminService } from '../../database/prisma-admin.service';

const RETENTION_DAYS = 30;

/**
 * Dedup de eventos GoCardless entrantes sobre `processed_gocardless_events`
 * (mismo patrón que `StripeEventsService`).
 *
 * GoCardless reentrega el LOTE completo si el endpoint no responde 2xx a algún
 * evento, y puede entregar desordenado: sin dedup, un `confirmed` repetido
 * sumaba dos veces al `amountPaid`. `markProcessed` inserta el `event.id` ANTES
 * de procesar; la PK convierte el duplicado en P2002 → `false` (descartar).
 * `release` borra la fila si el procesamiento falla, para que el reintento entre.
 *
 * Tabla global (sin tenant, sin RLS): se accede via `PrismaAdminService`.
 */
@Injectable()
export class GoCardlessEventsService {
  private readonly logger = new Logger(GoCardlessEventsService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /** Devuelve `false` si el evento ya se procesó (duplicado → descartar). */
  async markProcessed(eventId: string, eventType: string): Promise<boolean> {
    try {
      await this.admin.processedGoCardlessEvent.create({ data: { id: eventId, eventType } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return false;
      }
      throw err;
    }
  }

  /** Libera el evento tras un fallo para que el reintento no se descarte. */
  async release(eventId: string): Promise<void> {
    await this.admin.processedGoCardlessEvent.deleteMany({ where: { id: eventId } });
  }

  /** Borra registros > 30 días (GoCardless deja de reintentar mucho antes). */
  async cleanupOldEvents(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.admin.processedGoCardlessEvent.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Limpiados ${count} processed_gocardless_events > ${RETENTION_DAYS}d`);
    }
    return count;
  }
}
