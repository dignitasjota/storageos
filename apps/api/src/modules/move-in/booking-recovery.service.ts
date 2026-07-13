import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { Env } from '../../config/env.schema';

/** Espera mínima antes de recordar (deja terminar a los que van lentos). */
const MIN_AGE_MS = 60 * 60 * 1000; // 1 h
/** Ventana máxima: pasado esto el lead ya no es «reciente» y no se recuerda. */
const MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72 h

/**
 * Recuperación de reservas abandonadas: el booking self-service captura el email
 * (`captureLead`) en cuanto el visitante lo teclea, pero si abandona sin firmar
 * no se hacía NADA con ese lead. Este servicio envía un recordatorio de nurture
 * (email) a los leads de booking `new` sin convertir (1-72 h), una sola vez
 * (idempotente vía `bookingReminderSentAt`). Recupera un % de reservas iniciadas.
 */
@Injectable()
export class BookingRecoveryService {
  private readonly logger = new Logger(BookingRecoveryService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Cross-tenant: recuerda a todos los leads de booking abandonados pendientes. */
  async sendDueReminders(now = new Date()): Promise<{ reminded: number }> {
    const from = new Date(now.getTime() - MAX_AGE_MS);
    const to = new Date(now.getTime() - MIN_AGE_MS);
    const leads = await this.admin.lead.findMany({
      where: {
        status: 'new',
        source: 'widget',
        deletedAt: null,
        email: { not: null },
        bookingReminderSentAt: null,
        createdAt: { gte: from, lte: to },
        metadata: { path: ['origin'], equals: 'booking' },
      },
      select: { id: true, tenantId: true, email: true, firstName: true },
      take: 500,
    });

    let reminded = 0;
    for (const lead of leads) {
      try {
        await this.remindOne(lead.tenantId, lead.id, lead.email as string, lead.firstName);
        reminded += 1;
      } catch (err) {
        this.logger.warn(
          `[booking-recovery] lead ${lead.id} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { reminded };
  }

  /**
   * Marca el lead ANTES de encolar (idempotencia entre réplicas / reintentos:
   * si otro proceso ya lo marcó, `updateMany count 0` → no reenvía).
   */
  private async remindOne(
    tenantId: string,
    leadId: string,
    email: string,
    firstName: string | null,
  ): Promise<void> {
    const { count } = await this.prisma.withTenant(
      (tx) =>
        tx.lead.updateMany({
          where: { id: leadId, bookingReminderSentAt: null },
          data: { bookingReminderSentAt: new Date() },
        }),
      tenantId,
    );
    if (count === 0) return; // ya recordado por otro proceso

    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    const businessName = tenant?.name ?? 'tu trastero';
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const bookingUrl = tenant?.slug ? `${webBase}/book/${tenant.slug}` : webBase;
    const hi = firstName?.trim() ? `Hola ${firstName.trim()},` : 'Hola,';

    const subject = `¿Seguimos con tu reserva en ${businessName}?`;
    const bodyText =
      `${hi}\n\nVimos que empezaste a reservar un trastero pero no llegaste a terminar. ` +
      `Tu sitio sigue disponible: puedes completar la reserva en un par de minutos aquí:\n\n${bookingUrl}\n\n` +
      `Si tienes cualquier duda, respóndenos a este correo. ¡Te esperamos!`;
    const bodyHtml =
      `<p>${hi}</p><p>Vimos que empezaste a reservar un trastero pero no llegaste a terminar. ` +
      `Tu sitio sigue disponible: puedes completar la reserva en un par de minutos.</p>` +
      `<p><a href="${bookingUrl}">Completar mi reserva</a></p>` +
      `<p>Si tienes cualquier duda, respóndenos a este correo. ¡Te esperamos!</p>`;

    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: email,
      subject,
      bodyText,
      bodyHtml,
      leadId,
      source: 'booking_recovery',
    });
  }
}
