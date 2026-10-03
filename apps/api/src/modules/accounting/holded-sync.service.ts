import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  DOMAIN_EVENTS,
  type DomainEventPayload,
  type InvoiceCancelledPayload,
} from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { HoldedSettingsService, type HoldedResolved } from './holded-settings.service';
import { HoldedApiError, HoldedClient, type HoldedLine } from './holded.client';

import type { Prisma } from '@storageos/database';
import type { HoldedReviewItemDto, ResolveHoldedReviewInput } from '@storageos/shared';

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
 * Margen antes de dar por «sin confirmar» un envío reservado: una petición a
 * Holded en curso tarda segundos (tiempo máximo 15 s por llamada).
 */
const REVIEW_AFTER_MS = 5 * 60_000;

const reviewWhere = (tenantId: string, before: Date) => ({
  invoices: {
    tenantId,
    holdedSyncState: 'creating',
    holdedSyncStartedAt: { lt: before },
  } satisfies Prisma.InvoiceWhereInput,
  unconfirmedPayments: {
    tenantId,
    holdedSyncedAt: null,
    holdedSyncStartedAt: { lt: before },
  } satisfies Prisma.PaymentWhereInput,
  reversedPayments: {
    tenantId,
    holdedSyncedAt: { not: null },
    holdedReviewedAt: null,
    status: { in: ['failed', 'refunded', 'partially_refunded'] },
  } satisfies Prisma.PaymentWhereInput,
});

/**
 * ¿Holded respondió con un error (no se creó nada)? Un error de red o un
 * tiempo agotado (`status` 0) NO lo es: Holded pudo crear el documento y
 * reintentar lo duplicaría.
 */
export function holdedRejected(err: unknown): boolean {
  return err instanceof HoldedApiError && err.status > 0;
}

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
        kind: 'invoice', // los justificantes de fianza no van a la contabilidad como facturas
        status: {
          in: ['issued', 'paid', 'overdue', 'refunded', 'partially_refunded', 'rectified'],
        },
        // Sin copia y sin reserva, o creadas en Holded pero sin aprobar. Las que
        // se quedaron «creando» (Holded no respondió) van a «para revisar».
        OR: [{ holdedDocumentId: null, holdedSyncState: null }, { holdedSyncState: 'approving' }],
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
          {
            payments: {
              some: {
                status: 'succeeded',
                holdedSyncedAt: null,
                holdedSyncStartedAt: null,
                methodType: { not: 'credit_note' },
              },
            },
          },
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

  /** Cuántos elementos hay que revisar a mano en Holded. */
  async reviewCount(tenantId: string): Promise<number> {
    const w = reviewWhere(tenantId, new Date(Date.now() - REVIEW_AFTER_MS));
    const [a, b, c] = await Promise.all([
      this.admin.invoice.count({ where: w.invoices }),
      this.admin.payment.count({ where: w.unconfirmedPayments }),
      this.admin.payment.count({ where: w.reversedPayments }),
    ]);
    return a + b + c;
  }

  /** Envíos sin confirmar y cobros copiados que luego se devolvieron. */
  async listReview(tenantId: string): Promise<HoldedReviewItemDto[]> {
    const w = reviewWhere(tenantId, new Date(Date.now() - REVIEW_AFTER_MS));
    const paymentSelect = {
      id: true,
      invoiceId: true,
      amount: true,
      status: true,
      holdedSyncStartedAt: true,
      updatedAt: true,
      invoice: { select: { invoiceNumber: true } },
    } as const;
    const [invoices, unconfirmed, reversed] = await Promise.all([
      this.admin.invoice.findMany({
        where: w.invoices,
        select: { id: true, invoiceNumber: true, total: true, holdedSyncStartedAt: true },
        orderBy: { holdedSyncStartedAt: 'asc' },
        take: 100,
      }),
      this.admin.payment.findMany({
        where: w.unconfirmedPayments,
        select: paymentSelect,
        orderBy: { holdedSyncStartedAt: 'asc' },
        take: 100,
      }),
      this.admin.payment.findMany({
        where: w.reversedPayments,
        select: paymentSelect,
        orderBy: { updatedAt: 'asc' },
        take: 100,
      }),
    ]);
    return [
      ...invoices.map(
        (i): HoldedReviewItemDto => ({
          kind: 'invoice_unconfirmed',
          id: i.id,
          invoiceId: i.id,
          invoiceNumber: i.invoiceNumber,
          amount: Number(i.total),
          date: (i.holdedSyncStartedAt ?? new Date()).toISOString(),
          paymentStatus: null,
        }),
      ),
      ...unconfirmed.map(
        (p): HoldedReviewItemDto => ({
          kind: 'payment_unconfirmed',
          id: p.id,
          invoiceId: p.invoiceId,
          invoiceNumber: p.invoice?.invoiceNumber ?? null,
          amount: Number(p.amount),
          date: (p.holdedSyncStartedAt ?? p.updatedAt).toISOString(),
          paymentStatus: p.status,
        }),
      ),
      ...reversed.map(
        (p): HoldedReviewItemDto => ({
          kind: 'payment_reversed',
          id: p.id,
          invoiceId: p.invoiceId,
          invoiceNumber: p.invoice?.invoiceNumber ?? null,
          amount: Number(p.amount),
          date: p.updatedAt.toISOString(),
          paymentStatus: p.status,
        }),
      ),
    ];
  }

  /** Resuelve una factura sin confirmar tras comprobarla en Holded. */
  async resolveInvoiceReview(
    tenantId: string,
    invoiceId: string,
    input: ResolveHoldedReviewInput,
  ): Promise<void> {
    const data: Prisma.InvoiceUpdateManyMutationInput =
      input.action === 'retry'
        ? { holdedSyncState: null, holdedSyncStartedAt: null }
        : input.action === 'already_in_holded'
          ? {
              holdedDocumentId: this.requireDocumentId(input),
              holdedSyncState: null,
              holdedSyncStartedAt: null,
            }
          : this.invalidAction();
    const r = await this.admin.invoice.updateMany({
      where: { id: invoiceId, tenantId, holdedSyncState: 'creating' },
      data,
    });
    if (r.count === 0) this.reviewNotFound();
  }

  /** Resuelve un cobro sin confirmar o devuelto tras comprobarlo en Holded. */
  async resolvePaymentReview(
    tenantId: string,
    paymentId: string,
    input: ResolveHoldedReviewInput,
  ): Promise<void> {
    const now = new Date();
    const [where, data]: [Prisma.PaymentWhereInput, Prisma.PaymentUpdateManyMutationInput] =
      input.action === 'reviewed'
        ? [{ holdedSyncedAt: { not: null }, holdedReviewedAt: null }, { holdedReviewedAt: now }]
        : [
            { holdedSyncedAt: null, holdedSyncStartedAt: { not: null } },
            input.action === 'retry'
              ? { holdedSyncStartedAt: null }
              : { holdedSyncedAt: now, holdedSyncStartedAt: null },
          ];
    const r = await this.admin.payment.updateMany({
      where: { id: paymentId, tenantId, ...where },
      data,
    });
    if (r.count === 0) this.reviewNotFound();
  }

  private requireDocumentId(input: ResolveHoldedReviewInput): string {
    if (!input.holdedDocumentId) {
      throw new BadRequestException({
        code: 'holded_document_id_required',
        message: 'Pega el id de la factura en Holded para enlazarla',
      });
    }
    return input.holdedDocumentId;
  }

  private invalidAction(): never {
    throw new BadRequestException({
      code: 'invalid_review_action',
      message: 'Acción no válida para una factura',
    });
  }

  private reviewNotFound(): never {
    throw new NotFoundException({
      code: 'holded_review_not_found',
      message: 'No hay nada pendiente de revisar con ese id',
    });
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
    // Rectificativa con importe negativo → rectificativa (credit note) en Holded.
    const isCreditNote = Number(invoice.total) < 0;
    const kind = isCreditNote ? 'creditnote' : 'invoice';
    const client = new HoldedClient(cfg.apiKey);

    if (invoice.holdedDocumentId) {
      // Creada pero sin aprobar (falló la aprobación): solo falta aprobarla.
      if (invoice.holdedSyncState === 'approving') {
        await this.approve(client, kind, invoiceId, invoice.holdedDocumentId);
      }
      return true;
    }
    if (invoice.status === 'draft' || invoice.status === 'cancelled') return false;
    if (invoice.kind === 'deposit_receipt') return false;
    // Otra copia en curso (o pendiente de revisar): no se crea una segunda.
    if (invoice.holdedSyncState) return false;
    if (isCreditNote && !cfg.creditNoteSeriesId) {
      throw new Error(
        'Elige en Ajustes la serie de rectificativas de Holded (marcada «No enviar a Verifactu»)',
      );
    }

    // Reserva atómica: solo un envío crea la copia (aviso al emitir, al cobrar,
    // «Enviar pendientes» y la sincronización manual pueden coincidir). Se toma
    // antes del contacto para no crear tampoco contactos duplicados.
    const claimed = await this.admin.invoice.updateMany({
      where: { id: invoiceId, tenantId, holdedDocumentId: null, holdedSyncState: null },
      data: { holdedSyncState: 'creating', holdedSyncStartedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    let holdedId: string;
    let sent = false;
    try {
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
      sent = true;
      holdedId = await client.createDocument(kind, {
        contactId,
        date: day(invoice.issueDate ?? invoice.createdAt),
        dueDate: invoice.dueDate ? day(invoice.dueDate) : null,
        seriesId: isCreditNote ? cfg.creditNoteSeriesId! : cfg.invoiceSeriesId,
        description,
        notes: `Número legal: ${number}. Emitida y registrada en Veri*Factu por TrasterOS; copia contable.`,
        lines,
      });
    } catch (err) {
      // Antes de crear el documento, o si Holded lo rechazó, no existe: se
      // libera para reintentar. Si Holded no respondió, la reserva se queda y
      // la factura sale «para revisar en Holded» (pudo crearse).
      if (!sent || holdedRejected(err)) {
        await this.admin.invoice.update({
          where: { id: invoiceId },
          data: { holdedSyncState: null, holdedSyncStartedAt: null },
        });
      }
      throw err;
    }

    // Se guarda el id ANTES de aprobar: si la aprobación falla, el reintento
    // solo aprueba (no crea otra copia).
    await this.admin.invoice.update({
      where: { id: invoiceId },
      data: { holdedDocumentId: holdedId, holdedSyncState: 'approving' },
    });
    await this.approve(client, kind, invoiceId, holdedId);
    return true;
  }

  private async approve(
    client: HoldedClient,
    kind: 'invoice' | 'creditnote',
    invoiceId: string,
    holdedId: string,
  ): Promise<void> {
    await client.approveDocument(kind, holdedId);
    await this.admin.invoice.update({
      where: { id: invoiceId },
      data: { holdedSyncState: null, holdedSyncStartedAt: null },
    });
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
        holdedSyncState: true,
        payments: {
          // La compensación con un abono no es un cobro: el abono ya va a Holded.
          where: {
            status: 'succeeded',
            holdedSyncedAt: null,
            holdedSyncStartedAt: null,
            methodType: { not: 'credit_note' },
          },
          select: { id: true, amount: true, paidAt: true, createdAt: true },
        },
      },
    });
    // Sin copia en Holded (o rectificativa negativa) no hay cobro que registrar.
    // Sin aprobar, Holded no admite cobros: se registran tras aprobarla.
    if (!invoice?.holdedDocumentId || invoice.holdedSyncState || Number(invoice.total) <= 0) {
      return;
    }
    if (invoice.payments.length === 0) return;
    const client = new HoldedClient(cfg.apiKey);
    for (const p of invoice.payments) {
      // Reserva atómica del cobro: dos envíos a la vez no lo registran dos veces.
      const claimed = await this.admin.payment.updateMany({
        where: { id: p.id, holdedSyncedAt: null, holdedSyncStartedAt: null },
        data: { holdedSyncStartedAt: new Date() },
      });
      if (claimed.count === 0) continue;
      try {
        await client.addInvoicePayment(invoice.holdedDocumentId, {
          amount: Number(p.amount),
          date: day(p.paidAt ?? p.createdAt),
          description: `Cobro de la factura ${invoice.invoiceNumber} (TrasterOS)`,
        });
      } catch (err) {
        if (holdedRejected(err)) {
          await this.admin.payment.update({
            where: { id: p.id },
            data: { holdedSyncStartedAt: null },
          });
        }
        throw err;
      }
      await this.admin.payment.update({
        where: { id: p.id },
        data: { holdedSyncedAt: new Date(), holdedSyncStartedAt: null },
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
      select: {
        holdedDocumentId: true,
        holdedCancelledAt: true,
        total: true,
        status: true,
        rectifiedBy: {
          where: { correctionMethod: 'by_substitution', status: { notIn: ['draft', 'cancelled'] } },
          select: { id: true },
        },
      },
    });
    // Anulada, o sustituida por otra factura (la sustitutiva se copia aparte;
    // una anulada por diferencias se compensa con su abono, no se cancela).
    const replaced = invoice?.status === 'rectified' && invoice.rectifiedBy.length > 0;
    if (
      !invoice?.holdedDocumentId ||
      invoice.holdedCancelledAt ||
      (invoice.status !== 'cancelled' && !replaced) ||
      Number(invoice.total) < 0
    ) {
      return;
    }
    const claimed = await this.admin.invoice.updateMany({
      where: { id: invoiceId, holdedCancelledAt: null },
      data: { holdedCancelledAt: new Date() },
    });
    if (claimed.count === 0) return;
    try {
      await new HoldedClient(cfg.apiKey).cancelInvoice(invoice.holdedDocumentId);
    } catch (err) {
      // Cancelar dos veces no crea nada: ante cualquier fallo se puede reintentar.
      await this.admin.invoice.update({
        where: { id: invoiceId },
        data: { holdedCancelledAt: null },
      });
      throw err;
    }
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
