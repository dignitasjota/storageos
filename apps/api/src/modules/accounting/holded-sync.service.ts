import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { HoldedSettingsService } from './holded-settings.service';
import { HoldedClient } from './holded.client';

function customerName(c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

@Injectable()
export class HoldedSyncService {
  private readonly logger = new Logger(HoldedSyncService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly settings: HoldedSettingsService,
  ) {}

  /** Empuja la factura a Holded cuando se emite (best-effort, no bloquea). */
  @OnEvent(DOMAIN_EVENTS.invoice_issued, { async: true, promisify: true })
  async handleInvoiceIssued(payload: DomainEventPayload): Promise<void> {
    await this.pushInvoice(payload.tenantId, payload.entityId, false);
  }

  /**
   * Exporta una factura a Holded (crea/asocia contacto + documento).
   * `throwOnError` true para la sincronización manual; false para el listener.
   */
  async pushInvoice(tenantId: string, invoiceId: string, throwOnError: boolean): Promise<void> {
    const apiKey = await this.settings.getApiKey(tenantId);
    const settings = await this.settings.get(tenantId);
    if (!settings.enabled || !apiKey) {
      if (throwOnError) {
        throw new BadRequestException({
          code: 'holded_not_enabled',
          message: 'La integración con Holded no está activa',
        });
      }
      return;
    }

    const invoice = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, deletedAt: null },
      include: { items: true, customer: true },
    });
    if (!invoice) {
      if (throwOnError) {
        throw new NotFoundException({
          code: 'invoice_not_found',
          message: 'Factura no encontrada',
        });
      }
      return;
    }
    if (invoice.holdedDocumentId) return; // ya sincronizada
    if (!invoice.customer) {
      if (throwOnError) {
        throw new BadRequestException({
          code: 'invoice_without_customer',
          message: 'No se puede exportar a Holded una factura sin cliente (F2)',
        });
      }
      return;
    }

    try {
      const client = new HoldedClient(apiKey);
      const customer = invoice.customer;
      const code = customer.documentNumber ?? undefined;
      const email = customer.email ?? undefined;
      const contactId =
        (await client.findContact(code, email)) ??
        (await client.createContact({
          name: customerName(customer),
          ...(code ? { code } : {}),
          ...(email ? { email } : {}),
          isPerson: customer.customerType !== 'business',
        }));

      const issueDate = invoice.issueDate ?? invoice.createdAt;
      const holdedId = await client.createInvoice({
        contactId,
        date: Math.floor(issueDate.getTime() / 1000),
        items: invoice.items.map((it) => ({
          name: it.description,
          units: Number(it.quantity),
          price: Number(it.unitPrice),
          tax: Number(it.taxRate),
        })),
        notes: `StorageOS ${invoice.invoiceNumber}`,
      });

      await this.prisma.withTenant(async (tx) => {
        await tx.invoice.update({
          where: { id: invoiceId },
          data: { holdedDocumentId: holdedId },
        });
        await tx.holdedSettings.update({
          where: { tenantId },
          data: { lastSyncAt: new Date(), lastError: null },
        });
      }, tenantId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error exportando a Holded';
      this.logger.error(`[holded] factura ${invoiceId}: ${message}`);
      await this.prisma
        .withTenant(
          (tx) => tx.holdedSettings.update({ where: { tenantId }, data: { lastError: message } }),
          tenantId,
        )
        .catch(() => undefined);
      if (throwOnError) {
        throw new BadRequestException({ code: 'holded_sync_failed', message });
      }
    }
  }

  /** Reintenta exportar las facturas emitidas aún sin documento en Holded. */
  async backfill(tenantId: string): Promise<{ synced: number }> {
    const settings = await this.settings.get(tenantId);
    if (!settings.enabled) {
      throw new BadRequestException({
        code: 'holded_not_enabled',
        message: 'La integración con Holded no está activa',
      });
    }
    const pending = await this.admin.invoice.findMany({
      where: {
        tenantId,
        deletedAt: null,
        holdedDocumentId: null,
        customerId: { not: null },
        status: { in: ['issued', 'paid', 'overdue'] },
      },
      select: { id: true },
      take: 50,
      orderBy: { issueDate: 'asc' },
    });
    let synced = 0;
    for (const inv of pending) {
      const before = await this.admin.invoice.findUnique({
        where: { id: inv.id },
        select: { holdedDocumentId: true },
      });
      await this.pushInvoice(tenantId, inv.id, false);
      const after = await this.admin.invoice.findUnique({
        where: { id: inv.id },
        select: { holdedDocumentId: true },
      });
      if (!before?.holdedDocumentId && after?.holdedDocumentId) synced += 1;
    }
    return { synced };
  }
}
