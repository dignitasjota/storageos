import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { formatDateLong, formatEur } from '../../common/format';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { SignaturesService } from './signatures.service';

import type { Env } from '../../config/env.schema';

/** Espera mínima antes de recordar (deja terminar a los que van lentos). */
const MIN_AGE_MS = 60 * 60 * 1000; // 1 h
/** Ventana máxima: pasado esto el lead ya no es «reciente» y no se recuerda. */
const MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72 h

/** Reserva enviada sin terminar: se recuerda pasadas 12 h… */
const BOOKING_MIN_AGE_MS = 12 * 60 * 60 * 1000;
/** …y solo si quedan al menos 6 h antes de que se libere el trastero. */
const BOOKING_MIN_LEFT_MS = 6 * 60 * 60 * 1000;

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
    private readonly signatures: SignaturesService,
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
    const bookings = await this.remindPendingBookings(now);
    return { reminded: reminded + bookings };
  }

  /**
   * Reservas online ENVIADAS pero sin terminar: el trastero queda retenido
   * (`firstPaymentDeadline`, 72 h) y luego se libera solo. Se recuerda una vez:
   * - sin firmar → enlace de firma nuevo;
   * - firmada pero sin pagar la primera factura → enlace al área de clientes.
   */
  private async remindPendingBookings(now: Date): Promise<number> {
    const contracts = await this.admin.contract.findMany({
      where: {
        deletedAt: null,
        status: { in: ['draft', 'active'] },
        bookingReminderSentAt: null,
        firstPaymentDeadline: { gt: new Date(now.getTime() + BOOKING_MIN_LEFT_MS) },
        createdAt: { lte: new Date(now.getTime() - BOOKING_MIN_AGE_MS) },
        customer: { email: { not: null }, deletedAt: null },
      },
      select: { id: true, tenantId: true },
      take: 500,
    });
    let reminded = 0;
    for (const c of contracts) {
      try {
        if (await this.remindBooking(c.tenantId, c.id)) reminded += 1;
      } catch (err) {
        this.logger.warn(
          `[booking-recovery] contrato ${c.id} falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return reminded;
  }

  private async remindBooking(tenantId: string, contractId: string): Promise<boolean> {
    const contract = await this.admin.contract.findFirst({
      where: { id: contractId, tenantId },
      select: {
        status: true,
        signedAt: true,
        firstPaymentDeadline: true,
        customer: { select: { email: true, firstName: true } },
        unit: { select: { code: true, facility: { select: { name: true } } } },
        invoices: {
          where: { status: { in: ['issued', 'overdue'] } },
          select: { total: true, amountPaid: true },
          take: 1,
        },
      },
    });
    if (!contract?.customer.email || !contract.firstPaymentDeadline) return false;
    const signed = contract.status === 'active' && !!contract.signedAt;
    const unpaid = contract.invoices[0];
    // Firmada y sin factura pendiente: ya está pagada, nada que recordar.
    if (signed && !unpaid) return false;

    // Se marca ANTES de enviar: con varias réplicas, solo una lo envía.
    const { count } = await this.admin.contract.updateMany({
      where: { id: contractId, bookingReminderSentAt: null },
      data: { bookingReminderSentAt: new Date() },
    });
    if (count === 0) return false;

    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
    });
    if (!tenant) return false;
    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const deadline = formatDateLong(contract.firstPaymentDeadline);
    const hour = new Intl.DateTimeFormat('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Madrid',
    }).format(contract.firstPaymentDeadline);
    const unit = `${contract.unit.code} (${contract.unit.facility.name})`;
    const hi = contract.customer.firstName?.trim()
      ? `Hola ${contract.customer.firstName.trim()},`
      : 'Hola,';

    let step: string;
    let url: string;
    let cta: string;
    if (!signed) {
      const { token } = await this.signatures.generateSigningToken(contractId);
      const base =
        tenant.customDomain && tenant.customDomainVerifiedAt
          ? `https://${tenant.customDomain}`
          : webBase;
      url = `${base}/sign/${token}`;
      cta = 'Firmar el contrato';
      step = 'Solo te falta firmar el contrato y pagar la primera cuota.';
    } else {
      url = tenantPortalLoginUrl(webBase, tenant);
      cta = 'Pagar ahora';
      const pending = Number(unpaid!.total) - Number(unpaid!.amountPaid);
      step = `Ya has firmado; solo te falta pagar la primera factura (${formatEur(pending)}) para activar tu acceso.`;
    }
    const subject = `Tu trastero ${contract.unit.code} sigue reservado`;
    const keep = `Lo tenemos reservado para ti hasta el ${deadline} a las ${hour}; después se libera para otros clientes.`;
    const bodyText = `${hi}\n\nTu trastero ${unit} está reservado a tu nombre. ${step}\n\n${keep}\n\n${cta}: ${url}\n\nSi tienes cualquier duda, responde a este correo.\n\nUn saludo,\nEl equipo de ${tenant.name}`;
    const esc = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const bodyHtml =
      `<p>${esc(hi)}</p><p>Tu trastero <strong>${esc(unit)}</strong> está reservado a tu nombre. ${esc(step)}</p>` +
      `<p>${esc(keep)}</p>` +
      `<p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:8px;text-decoration:none">${esc(cta)}</a></p>` +
      `<p>Si tienes cualquier duda, responde a este correo.</p>`;

    await this.communications.enqueue({
      tenantId,
      channel: 'email',
      recipient: contract.customer.email,
      subject,
      bodyText,
      bodyHtml,
      contractId,
      source: signed ? 'booking_recovery.unpaid' : 'booking_recovery.unsigned',
    });
    return true;
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
