import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { InvoicePdfService } from '../billing/invoice-pdf.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type { PaymentMethodTypeValue } from '@storageos/shared';

/** Línea de la factura de suscripción (importes con IVA ya repartidos). */
export interface OwnTenantLine {
  description: string;
  quantity: number;
  baseAmount: number;
  taxRate: number;
}

export interface OwnTenantIssued {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: Date;
  subtotal: number;
  taxAmount: number;
  total: number;
  /** Clave del PDF en el bucket de facturas (null si no se pudo generar). */
  pdfKey: string | null;
}

const SYSTEM_META = {};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Tipo de documento del NIF (DNI, NIE o CIF) para la ficha del cliente. */
function documentTypeFor(taxId: string | null): string | null {
  if (!taxId) return null;
  const c = taxId.trim().toUpperCase()[0] ?? '';
  if (/[0-9]/.test(c)) return 'dni';
  if ('XYZ'.includes(c)) return 'nie';
  return 'cif';
}

/** Forma de pago de la factura según el origen del cobro de la suscripción. */
function methodFor(provider: string): PaymentMethodTypeValue {
  switch (provider) {
    case 'stripe':
      return 'card';
    case 'sepa':
      return 'sepa_debit';
    case 'cash':
      return 'cash';
    case 'bank_transfer':
      return 'bank_transfer';
    default:
      return 'other';
  }
}

/**
 * Emite la factura de suscripción como factura NORMAL del tenant propio de la
 * sociedad emisora (el «negocio propio» de los ajustes): mismo NIF, misma
 * cadena Veri*Factu, mismo modo de emisión (app o Holded) y misma exportación
 * para la asesoría que sus facturas de trasteros. El tenant cobrado es un
 * cliente de ese tenant propio.
 *
 * Usa `ModuleRef` para no importar `BillingModule` (ciclo Billing → Payments →
 * BillingSaas).
 */
@Injectable()
export class PlatformOwnTenantInvoicingService {
  private readonly logger = new Logger(PlatformOwnTenantInvoicingService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly moduleRef: ModuleRef,
    private readonly files: FilesService,
  ) {}

  private get invoices(): InvoicesService {
    return this.moduleRef.get(InvoicesService, { strict: false });
  }

  private get pdf(): InvoicePdfService {
    return this.moduleRef.get(InvoicePdfService, { strict: false });
  }

  /**
   * Factura el pago en el tenant propio. Idempotente: si el pago ya tiene su
   * factura (`invoices.platform_payment_id`), la retoma donde se quedó
   * (borrador sin emitir, emitida sin cobrar).
   */
  async issue(args: {
    ownTenantId: string;
    payment: {
      id: string;
      provider: string;
      paidAt: Date | null;
      periodStart: Date | null;
      periodEnd: Date | null;
      tenantId: string;
    };
    lines: OwnTenantLine[];
  }): Promise<OwnTenantIssued> {
    const { ownTenantId, payment } = args;
    if (payment.tenantId === ownTenantId) {
      throw new BadRequestException({
        code: 'own_tenant_self_invoice',
        message: 'El negocio propio no se factura a sí mismo',
      });
    }

    let invoice = await this.admin.invoice.findUnique({
      where: { platformPaymentId: payment.id },
      select: { id: true, status: true },
    });

    if (!invoice) {
      // Reserva del pago: dos procesos (webhook + pago manual) no crean dos facturas.
      const claimed = await this.admin.tenantSubscriptionPayment.updateMany({
        where: {
          id: payment.id,
          OR: [
            { invoicingClaimedAt: null },
            { invoicingClaimedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
          ],
        },
        data: { invoicingClaimedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'invoicing_in_progress',
          message: 'Este pago se está facturando',
        });
      }
      try {
        const customerId = await this.ensureCustomer(ownTenantId, payment.tenantId);
        const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);
        const periodStart = day(payment.periodStart);
        const periodEnd = day(payment.periodEnd);
        const draft = await this.invoices.create({
          tenantId: ownTenantId,
          userId: null,
          meta: SYSTEM_META,
          input: {
            invoiceType: 'F1',
            verifactuMode: 'verifactu',
            customerId,
            ...(periodStart ? { periodStart } : {}),
            ...(periodEnd ? { periodEnd } : {}),
            items: args.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity || 1,
              unitPrice: round2(l.baseAmount / (l.quantity || 1)),
              taxRate: l.taxRate,
            })),
          },
        });
        await this.admin.invoice.update({
          where: { id: draft.id },
          data: { platformPaymentId: payment.id },
        });
        invoice = { id: draft.id, status: 'draft' };
      } finally {
        await this.admin.tenantSubscriptionPayment.update({
          where: { id: payment.id },
          data: { invoicingClaimedAt: null },
        });
      }
    }

    if (invoice.status === 'draft') {
      await this.invoices.issue({
        tenantId: ownTenantId,
        userId: null,
        invoiceId: invoice.id,
        meta: SYSTEM_META,
      });
    }

    let row = await this.admin.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    if (row.status === 'draft') {
      throw new BadRequestException({
        code: 'own_tenant_invoice_not_issued',
        message: 'La factura de suscripción no se ha podido emitir en el negocio propio',
      });
    }
    // Ya está cobrada: se registra el cobro en la factura.
    const pending = round2(
      Number(row.total) - Number(row.amountPaid) + Number(row.amountRefunded ?? 0),
    );
    if ((row.status === 'issued' || row.status === 'overdue') && pending > 0) {
      await this.invoices.markPaidManually({
        tenantId: ownTenantId,
        userId: null,
        invoiceId: row.id,
        meta: SYSTEM_META,
        input: {
          amount: pending,
          methodType: methodFor(payment.provider),
          ...(payment.paidAt ? { paidAt: payment.paidAt.toISOString() } : {}),
          notes: 'Cobro de la suscripción a TrasterOS',
          allowPartialNonCash: true,
          overridePaymentInFlight: true,
          allowInSepaRemittance: true,
        },
      });
      row = await this.admin.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    }

    return {
      invoiceId: row.id,
      invoiceNumber: row.invoiceNumber,
      issueDate: row.issueDate ?? new Date(),
      subtotal: Number(row.subtotal),
      taxAmount: Number(row.taxAmount),
      total: Number(row.total),
      pdfKey: await this.pdfKeyFor(ownTenantId, row.id),
    };
  }

  /** Clave del PDF de una factura del tenant propio (lo genera si hace falta). */
  async pdfKeyFor(ownTenantId: string, invoiceId: string): Promise<string | null> {
    try {
      let row = await this.admin.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select: { pdfUrl: true },
      });
      if (!row.pdfUrl) {
        await this.pdf.generate(ownTenantId, invoiceId);
        row = await this.admin.invoice.findUniqueOrThrow({
          where: { id: invoiceId },
          select: { pdfUrl: true },
        });
      }
      const prefix = this.files.buildPublicUrl('invoices', '');
      return row.pdfUrl?.startsWith(prefix) ? row.pdfUrl.slice(prefix.length) : null;
    } catch (err) {
      this.logger.warn(
        `PDF de la factura ${invoiceId} del negocio propio: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Cliente del tenant propio que representa al tenant cobrado, creado o
   * actualizado con sus datos de facturación actuales.
   */
  async ensureCustomer(ownTenantId: string, tenantId: string): Promise<string> {
    const t = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        name: true,
        billingLegalName: true,
        taxId: true,
        billingEmail: true,
        billingAddress: true,
        billingCity: true,
        billingPostalCode: true,
        country: true,
      },
    });
    const data = {
      customerType: 'business' as const,
      companyName: t.billingLegalName?.trim() || t.name,
      documentType: documentTypeFor(t.taxId),
      documentNumber: t.taxId,
      email: t.billingEmail,
      address: t.billingAddress,
      city: t.billingCity,
      postalCode: t.billingPostalCode,
      country: t.country,
    };
    const existing = await this.admin.customer.findFirst({
      where: { tenantId: ownTenantId, platformTenantId: tenantId, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.admin.customer.update({ where: { id: existing.id }, data });
      return existing.id;
    }
    const created = await this.admin.customer.create({
      data: { ...data, tenantId: ownTenantId, platformTenantId: tenantId, tags: ['suscripcion'] },
      select: { id: true },
    });
    return created.id;
  }
}
