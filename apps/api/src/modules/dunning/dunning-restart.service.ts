import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type InvoicePaymentRevertedPayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { dunningCalendar } from './dunning-calendar';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Escalado de impagos desde cero tras un cobro devuelto. Un contracargo, una
 * devolución SEPA o una devolución del banco (N43) vuelven a dejar vencida una
 * factura que ya estaba pagada; sus acciones del escalado ya estaban ejecutadas
 * o canceladas y no se volvía a reclamar ni a cortar el acceso. Aquí las del
 * ciclo anterior pasan a historial y se programa el calendario completo contando
 * desde hoy.
 *
 * Siempre registrado (no depende de los workers): el evento lo emiten los
 * webhooks y la conciliación del API. Solo escribe en la BD; el cron diario del
 * escalado despacha las acciones cuando les toca.
 */
@Injectable()
export class DunningRestartService {
  private readonly logger = new Logger(DunningRestartService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
  ) {}

  @OnEvent(DOMAIN_EVENTS.invoice_payment_reverted, { async: true, promisify: true })
  async onPaymentReverted(p: InvoicePaymentRevertedPayload): Promise<void> {
    try {
      await this.restart(p.tenantId, p.invoiceId);
    } catch (err) {
      this.logger.warn(
        `No se pudo reiniciar el escalado de la factura ${p.invoiceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Devuelve cuántas acciones se programaron (0 si la factura no está vencida). */
  async restart(tenantId: string, invoiceId: string, now = new Date()): Promise<number> {
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, deletedAt: null },
      select: {
        status: true,
        kind: true,
        total: true,
        invoiceNumber: true,
        lateFeeInvoice: { select: { id: true } },
        tenant: { select: { lateFeeEnabled: true, lateFeeGraceDays: true } },
      },
    });
    // Solo una factura que vuelve a deber (vencida). Si aún no ha vencido, el
    // cron la marcará vencida a su fecha y programará el calendario normal.
    if (!invoice || invoice.status !== 'overdue' || invoice.kind !== 'invoice') return 0;
    if (Number(invoice.total) <= 0) return 0;

    const calendar = dunningCalendar({
      enabled: invoice.tenant.lateFeeEnabled,
      graceDays: invoice.tenant.lateFeeGraceDays,
    })
      // El recargo ya emitido no se vuelve a emitir.
      .filter((s) => !(s.type === 'late_fee' && invoice.lateFeeInvoice));

    const created = await this.admin.$transaction(async (tx) => {
      // Ciclo anterior → historial. Lo pendiente se cancela; lo ejecutado se
      // conserva tal cual, solo marcado como de un ciclo pasado.
      await tx.dunningAction.updateMany({
        where: { tenantId, invoiceId, supersededAt: null, status: 'scheduled' },
        data: { status: 'cancelled', supersededAt: now, notes: 'Cobro devuelto: nuevo ciclo' },
      });
      await tx.dunningAction.updateMany({
        where: { tenantId, invoiceId, supersededAt: null },
        data: { supersededAt: now },
      });
      const res = await tx.dunningAction.createMany({
        data: calendar.map((s) => ({
          tenantId,
          invoiceId,
          actionType: s.type,
          status: 'scheduled' as const,
          scheduledFor: new Date(now.getTime() + s.daysAfter * DAY_MS),
        })),
        // Dos devoluciones casi a la vez: la segunda no duplica el calendario.
        skipDuplicates: true,
      });
      return res.count;
    });

    await this.audit.write({
      tenantId,
      userId: null,
      action: 'dunning.restarted',
      entityType: 'Invoice',
      entityId: invoiceId,
      changes: { reason: 'payment_reverted', scheduled: created },
    });
    this.logger.log(
      `Cobro devuelto de ${invoice.invoiceNumber}: escalado reiniciado (${created} acciones)`,
    );
    return created;
  }
}
