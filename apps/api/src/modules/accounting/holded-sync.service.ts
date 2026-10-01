import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  DOMAIN_EVENTS,
  type DomainEventPayload,
  type InvoiceCancelledPayload,
} from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { HoldedSettingsService, type HoldedResolved } from './holded-settings.service';
import { HoldedClient, type HoldedLine } from './holded.client';

/** Contacto de Holded al que van las facturas simplificadas (sin cliente identificado). */
export const HOLDED_GENERIC_CONTACT = 'Clientes varios (facturas simplificadas)';

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Copia contable de las facturas en Holded (API v2). La app EMITE la factura y
 * la registra en Veri*Factu; Holded solo la recibe para la contabilidad, en una
 * serie marcada «No enviar a Verifactu» (si no, la registraría otra vez en la
 * AEAT). El número legal de TrasterOS va en la descripción del documento.
 *
 * - emitida → factura aprobada en su serie (rectificativa con importe negativo
 *   → rectificativa de Holded); simplificada → contacto genérico;
 * - cobrada → cobros registrados en Holded;
 * - anulada → cancelada en Holded.
 *
 * Los listeners son best-effort: un fallo se guarda en `lastError` y se puede
 * reintentar con «Enviar pendientes».
 */
@Injectable()
export class HoldedSyncService {
  private readonly logger = new Logger(HoldedSyncService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly settings: HoldedSettingsService,
  ) {}

  @OnEvent(DOMAIN_EVENTS.invoice_issued, { async: true, promisify: true })
  async handleInvoiceIssued(payload: DomainEventPayload): Promise<void> {
    await this.pushInvoice(payload.tenantId, payload.entityId, false);
  }

  @OnEvent(DOMAIN_EVENTS.invoice_paid, { async: true, promisify: true })
  async handleInvoicePaid(payload: DomainEventPayload): Promise<void> {
    await this.run(payload.tenantId, false, (cfg) =>
      this.pushPayments(payload.tenantId, payload.entityId, cfg),
    );
  }

  @OnEvent(DOMAIN_EVENTS.invoice_cancelled, { async: true, promisify: true })
  async handleInvoiceCancelled(payload: InvoiceCancelledPayload): Promise<void> {
    await this.run(payload.tenantId, false, (cfg) =>
      this.cancelInHolded(payload.tenantId, payload.invoiceId, cfg),
    );
  }

  /**
   * Copia una factura a Holded (y sus cobros si ya está cobrada).
   * `throwOnError` true para la sincronización manual; false para el listener.
   */
  async pushInvoice(tenantId: string, invoiceId: string, throwOnError: boolean): Promise<void> {
    await this.run(tenantId, throwOnError, async (cfg) => {
      const created = await this.pushDocument(tenantId, invoiceId, cfg, throwOnError);
      if (created) await this.pushPayments(tenantId, invoiceId, cfg);
    });
  }

  /** Reenvía lo pendiente: facturas sin copiar, cobros y anulaciones. */
  async backfill(tenantId: string): Promise<{ synced: number }> {
    const cfg = await this.settings.resolve(tenantId);
    if ('reason' in cfg) {
      throw new BadRequestException({ code: 'holded_not_ready', message: cfg.reason });
    }
    const pending = await this.admin.invoice.findMany({
      where: {
        tenantId,
        deletedAt: null,
        holdedDocumentId: null,
        status: { in: ['issued', 'paid', 'overdue', 'refunded', 'partially_refunded'] },
      },
      select: { id: true },
      take: 50,
      orderBy: { issueDate: 'asc' },
    });
    let synced = 0;
    for (const inv of pending) {
      try {
        if (await this.pushDocument(tenantId, inv.id, cfg, false)) synced += 1;
        await this.pushPayments(tenantId, inv.id, cfg);
      } catch (err) {
        await this.fail(tenantId, inv.id, err);
      }
    }
    // Cobros y anulaciones de facturas que ya estaban en Holded.
    const withPending = await this.admin.invoice.findMany({
      where: {
        tenantId,
        holdedDocumentId: { not: null },
        OR: [
          { payments: { some: { status: 'succeeded', holdedSyncedAt: null } } },
          { status: 'cancelled', holdedCancelledAt: null },
        ],
      },
      select: { id: true, status: true },
      take: 100,
    });
    for (const inv of withPending) {
      try {
        if (inv.status === 'cancelled') await this.cancelInHolded(tenantId, inv.id, cfg);
        else await this.pushPayments(tenantId, inv.id, cfg);
      } catch (err) {
        await this.fail(tenantId, inv.id, err);
      }
    }
    return { synced };
  }

  // -------------------------------------------------------------------------

  /** Crea el documento en Holded. Devuelve true si estaba (o queda) copiado. */
  private async pushDocument(
    tenantId: string,
    invoiceId: string,
    cfg: HoldedResolved,
    throwOnError: boolean,
  ): Promise<boolean> {
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, deletedAt: null },
      include: {
        items: { orderBy: { position: 'asc' } },
        customer: true,
        rectifiesInvoice: { select: { invoiceNumber: true } },
      },
    });
    if (!invoice) {
      if (throwOnError) {
        throw new NotFoundException({
          code: 'invoice_not_found',
          message: 'Factura no encontrada',
        });
      }
      return false;
    }
    if (invoice.holdedDocumentId) return true;
    if (invoice.status === 'draft' || invoice.status === 'cancelled') return false;

    // Rectificativa con importe negativo → rectificativa (credit note) en Holded.
    const isCreditNote = Number(invoice.total) < 0;
    if (isCreditNote && !cfg.creditNoteSeriesId) {
      throw new Error(
        'Elige en Ajustes la serie de rectificativas de Holded (marcada «No enviar a Verifactu»)',
      );
    }

    const client = new HoldedClient(cfg.apiKey);
    const contactId = invoice.customer
      ? await this.contactFor(client, invoice.customer)
      : await this.genericContact(client);

    const lines: HoldedLine[] = [];
    for (const it of invoice.items) {
      const price = Number(it.unitPrice);
      lines.push({
        name: it.description,
        units: Number(it.quantity),
        // En Holded la rectificativa ya resta: sus líneas van en positivo.
        price: isCreditNote ? -price : price,
        taxes: [await client.taxKeyFor(Number(it.taxRate))],
      });
    }

    const number = invoice.invoiceNumber;
    const description = invoice.rectifiesInvoice
      ? `Factura rectificativa ${number} de TrasterOS (rectifica la ${invoice.rectifiesInvoice.invoiceNumber})`
      : `Factura ${number} de TrasterOS`;
    const holdedId = await client.createDocument(isCreditNote ? 'creditnote' : 'invoice', {
      contactId,
      date: day(invoice.issueDate ?? invoice.createdAt),
      dueDate: invoice.dueDate ? day(invoice.dueDate) : null,
      seriesId: isCreditNote ? cfg.creditNoteSeriesId! : cfg.invoiceSeriesId,
      description,
      notes: `Número legal: ${number}. Emitida y registrada en Veri*Factu por TrasterOS; copia contable.`,
      lines,
    });

    await this.admin.invoice.update({
      where: { id: invoiceId },
      data: { holdedDocumentId: holdedId },
    });
    return true;
  }

  /** Copia a Holded los cobros de la factura aún no copiados. */
  private async pushPayments(
    tenantId: string,
    invoiceId: string,
    cfg: HoldedResolved,
  ): Promise<void> {
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: {
        holdedDocumentId: true,
        total: true,
        invoiceNumber: true,
        payments: {
          where: { status: 'succeeded', holdedSyncedAt: null },
          select: { id: true, amount: true, paidAt: true, createdAt: true },
        },
      },
    });
    // Sin copia en Holded (o rectificativa negativa) no hay cobro que registrar.
    if (!invoice?.holdedDocumentId || Number(invoice.total) <= 0) return;
    if (invoice.payments.length === 0) return;
    const client = new HoldedClient(cfg.apiKey);
    for (const p of invoice.payments) {
      await client.addInvoicePayment(invoice.holdedDocumentId, {
        amount: Number(p.amount),
        date: day(p.paidAt ?? p.createdAt),
        description: `Cobro de la factura ${invoice.invoiceNumber} (TrasterOS)`,
      });
      await this.admin.payment.update({
        where: { id: p.id },
        data: { holdedSyncedAt: new Date() },
      });
    }
  }

  /** Cancela en Holded una factura anulada en la app. */
  private async cancelInHolded(
    tenantId: string,
    invoiceId: string,
    cfg: HoldedResolved,
  ): Promise<void> {
    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { holdedDocumentId: true, holdedCancelledAt: true, total: true, status: true },
    });
    if (
      !invoice?.holdedDocumentId ||
      invoice.holdedCancelledAt ||
      invoice.status !== 'cancelled' ||
      Number(invoice.total) < 0
    ) {
      return;
    }
    await new HoldedClient(cfg.apiKey).cancelInvoice(invoice.holdedDocumentId);
    await this.admin.invoice.update({
      where: { id: invoiceId },
      data: { holdedCancelledAt: new Date() },
    });
  }

  private async contactFor(
    client: HoldedClient,
    customer: {
      customerType: string;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      documentNumber: string | null;
      email: string | null;
    },
  ): Promise<string> {
    const code = customer.documentNumber ?? undefined;
    const email = customer.email ?? undefined;
    return (
      (await client.findContact(code, email)) ??
      (await client.createContact({
        name: customerName(customer),
        ...(code ? { code } : {}),
        ...(email ? { email } : {}),
        isPerson: customer.customerType !== 'business',
      }))
    );
  }

  private async genericContact(client: HoldedClient): Promise<string> {
    return (
      (await client.findContactByName(HOLDED_GENERIC_CONTACT)) ??
      (await client.createContact({ name: HOLDED_GENERIC_CONTACT, isPerson: true }))
    );
  }

  /**
   * Ejecuta una operación con la configuración resuelta. Sin configuración
   * lista, en manual lanza el motivo y en automático lo deja en `lastError`.
   */
  private async run(
    tenantId: string,
    throwOnError: boolean,
    op: (cfg: HoldedResolved) => Promise<void>,
  ): Promise<void> {
    const cfg = await this.settings.resolve(tenantId);
    if ('reason' in cfg) {
      if (throwOnError) {
        throw new BadRequestException({ code: 'holded_not_ready', message: cfg.reason });
      }
      return;
    }
    try {
      await op(cfg);
      await this.settings.recordResult(tenantId, null);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      const message = await this.fail(tenantId, null, err);
      if (throwOnError) {
        throw new BadRequestException({ code: 'holded_sync_failed', message });
      }
    }
  }

  private async fail(tenantId: string, invoiceId: string | null, err: unknown): Promise<string> {
    const message = err instanceof Error ? err.message : 'Error copiando a Holded';
    this.logger.error(
      `[holded] tenant ${tenantId}${invoiceId ? ` factura ${invoiceId}` : ''}: ${message}`,
    );
    await this.settings.recordResult(tenantId, message);
    return message;
  }
}
