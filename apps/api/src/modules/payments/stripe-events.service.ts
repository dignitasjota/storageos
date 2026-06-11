import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaAdminService } from '../database/prisma-admin.service';

const RETENTION_DAYS = 30;

/**
 * Dedup de eventos Stripe entrantes sobre `processed_stripe_events`.
 *
 * Stripe garantiza entrega at-least-once: reintentos y duplicados (incluso
 * concurrentes) son normales. `markProcessed` inserta el `event.id` ANTES de
 * que el controller procese el evento; la PK convierte el duplicado en un
 * P2002 que se traduce a `false` (descartar). Si el handler falla,
 * `release` borra la fila para que el retry de Stripe vuelva a entrar.
 *
 * Tabla global (sin tenant_id, sin RLS): el webhook llega antes de resolver
 * tenant context, asi que se accede via `PrismaAdminService`.
 */
@Injectable()
export class StripeEventsService {
  private readonly logger = new Logger(StripeEventsService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /**
   * Marca el evento como procesado. Devuelve `false` si ya existia
   * (duplicado: el caller debe descartar el evento sin procesarlo).
   */
  async markProcessed(eventId: string, eventType: string): Promise<boolean> {
    try {
      await this.admin.processedStripeEvent.create({
        data: { id: eventId, eventType },
      });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Libera el evento tras un fallo de procesamiento, para que el retry
   * de Stripe (mismo `event.id`) no sea descartado como duplicado.
   */
  async release(eventId: string): Promise<void> {
    await this.admin.processedStripeEvent.deleteMany({ where: { id: eventId } });
  }

  /** Borra registros > 30 dias. Stripe deja de reintentar mucho antes. */
  async cleanupOldEvents(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.admin.processedStripeEvent.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Limpiados ${count} processed_stripe_events > ${RETENTION_DAYS}d`);
    }
    return count;
  }
}
