import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@storageos/database';
import {
  missingFiscalData,
  normalizeTaxId,
  type RectifyPlatformInvoiceInput,
  type TenantBillingDetailsDto,
  type TenantBillingDetailsInput,
} from '@storageos/shared';
import StripeSDK from 'stripe';

import { isUniqueViolation } from '../../common/prisma-errors';
import { assertTaxIdFree } from '../../common/tax-id-unique';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { FilesService } from '../files/files.service';
import { StripeGateway } from '../payments/stripe.gateway';

import { PlatformHoldedService } from './platform-holded.service';
import { PlatformOwnTenantInvoicingService } from './platform-own-tenant-invoicing.service';

import type { Env } from '../../config/env.schema';
import type {
  PlatformBillingSettingsDto,
  PlatformInvoiceDto,
  PlatformInvoiceLineDto,
  UpdatePlatformBillingSettingsInput,
} from '@storageos/shared';

type StripeClient = InstanceType<typeof StripeSDK>;

/** Datos de una línea a persistir en `platform_invoice_lines`. */
interface LineData {
  kind: string;
  description: string;
  quantity: number;
  unitAmount: number;
  baseAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  position: number;
}

/** Relaciones que necesita el DTO de una factura de plataforma. */
const INVOICE_INCLUDE = {
  lines: { orderBy: { position: 'asc' } },
  rectifiesInvoice: { select: { id: true, fullNumber: true } },
  rectifications: {
    select: { id: true, fullNumber: true, correctionMethod: true, total: true },
    orderBy: { issuedAt: 'asc' },
  },
} satisfies Prisma.PlatformInvoiceInclude;

/** Datos que pinta el PDF de una factura (o rectificativa) de plataforma. */
interface RenderInvoice {
  fullNumber: string;
  issuedAt: Date;
  tenantName: string;
  tenantTaxId: string | null;
  tenantAddress: string | null;
  planName: string | null;
  concept: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  baseAmount: unknown;
  taxRate: unknown;
  taxAmount: unknown;
  total: unknown;
  lines?: LineRow[];
  invoiceType?: string;
  rectifies?: { fullNumber: string; issuedAt: Date } | null;
  rectificationReason?: string | null;
  correctionMethod?: string | null;
}

// Puppeteer ESM-only (ADR-023): dynamic import + type-only.
type Browser = import('puppeteer').Browser;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const eur = (n: number): string =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** Escapa un campo de texto para CSV: comillas si contiene `;`, `"` o salto de línea. */
const csvCell = (v: string): string => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Facturación del SaaS: TrasterOS emite facturas de suscripción a sus tenants.
 * Distinto de las facturas del tenant a sus inquilinos (Fase 4 / Veri*Factu).
 * v1: factura conforme (numeración por serie/año + IVA + PDF), SIN Veri*Factu.
 */
@Injectable()
export class PlatformInvoicesService {
  private readonly logger = new Logger(PlatformInvoicesService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly aeatRealMode: boolean;
  private browserPromise: Promise<Browser> | null = null;
  private readonly stripe: StripeClient;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly email: EmailService,
    private readonly stripeGateway: StripeGateway,
    private readonly holded: PlatformHoldedService,
    private readonly ownTenant: PlatformOwnTenantInvoicingService,
    config: ConfigService<Env, true>,
  ) {
    this.aeatRealMode = config.get('AEAT_MODE', { infer: true }) !== 'stub';
    this.stripe = stripeGateway.getClient();
    this.s3 = new S3Client({
      endpoint: config.get('MINIO_ENDPOINT', { infer: true }),
      region: 'us-east-1',
      credentials: {
        accessKeyId: config.get('MINIO_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('MINIO_SECRET_KEY', { infer: true }),
      },
      forcePathStyle: true,
    });
    this.bucket = config.get('MINIO_BUCKET_INVOICES', { infer: true });
  }

  // ---- config del emisor ----

  async getSettings(): Promise<PlatformBillingSettingsDto> {
    const include = { ownTenant: { select: { id: true, name: true, slug: true } } } as const;
    let row = await this.admin.platformBillingSettings.findFirst({ include });
    row ??= await this.admin.platformBillingSettings.create({ data: {}, include });
    return this.settingsToDto(row);
  }

  async updateSettings(
    input: UpdatePlatformBillingSettingsInput,
  ): Promise<PlatformBillingSettingsDto> {
    const existing = await this.admin.platformBillingSettings.findFirst();
    const data = {
      ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
      ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
      ...(input.address !== undefined ? { address: input.address || null } : {}),
      ...(input.city !== undefined ? { city: input.city || null } : {}),
      ...(input.postalCode !== undefined ? { postalCode: input.postalCode || null } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.email !== undefined ? { email: input.email || null } : {}),
      ...(input.taxRate !== undefined ? { taxRate: input.taxRate } : {}),
      ...(input.seriesPrefix !== undefined ? { seriesPrefix: input.seriesPrefix } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.pricesIncludeVat !== undefined ? { pricesIncludeVat: input.pricesIncludeVat } : {}),
    };

    // Negocio propio de la SL (para la exportación de la asesoría), por slug.
    let ownTenantId: string | null | undefined;
    if (input.ownTenantSlug !== undefined) {
      if (input.ownTenantSlug === '') {
        ownTenantId = null;
      } else {
        const t = await this.admin.tenant.findFirst({
          where: { slug: input.ownTenantSlug.toLowerCase(), deletedAt: null },
          select: { id: true, taxId: true },
        });
        if (!t) {
          throw new BadRequestException({
            code: 'own_tenant_not_found',
            message: `No hay ninguna empresa con el identificador «${input.ownTenantSlug}»`,
          });
        }
        // Emite las facturas de suscripción: debe ser la misma sociedad (mismo NIF).
        const issuerTaxId = input.taxId ?? existing?.taxId ?? '';
        if (issuerTaxId && t.taxId && normalizeTaxId(issuerTaxId) !== normalizeTaxId(t.taxId)) {
          throw new BadRequestException({
            code: 'own_tenant_tax_id_mismatch',
            message: `El negocio propio tiene el NIF ${t.taxId} y el emisor ${issuerTaxId}: deben ser la misma sociedad`,
          });
        }
        ownTenantId = t.id;
      }
    }

    // Una factura sin los datos del emisor no es válida: no se puede activar la
    // facturación con ellos incompletos.
    const enabling = input.enabled ?? existing?.enabled ?? false;
    if (enabling) {
      const missing = missingFiscalData({
        name: input.legalName ?? existing?.legalName,
        taxId: input.taxId ?? existing?.taxId,
        address: input.address !== undefined ? input.address : existing?.address,
        city: input.city !== undefined ? input.city : existing?.city,
        postalCode: input.postalCode !== undefined ? input.postalCode : existing?.postalCode,
        country: input.country ?? existing?.country,
      });
      if (missing.length > 0) {
        throw new BadRequestException({
          code: 'platform_billing_incomplete',
          message: `Para emitir facturas faltan datos del emisor: ${missing.join(', ')}`,
          details: { missing },
        });
      }
    }

    const fullData = { ...data, ...(ownTenantId !== undefined ? { ownTenantId } : {}) };
    if (existing) {
      await this.admin.platformBillingSettings.update({
        where: { id: existing.id },
        data: fullData,
      });
    } else {
      await this.admin.platformBillingSettings.create({ data: fullData });
    }
    return this.getSettings();
  }

  // ---- datos de facturación del tenant (destinatario) ----

  async getTenantBillingDetails(tenantId: string): Promise<TenantBillingDetailsDto> {
    const t = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!t) throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    return {
      legalName: t.billingLegalName,
      taxId: t.taxId,
      address: t.billingAddress,
      city: t.billingCity,
      postalCode: t.billingPostalCode,
      country: t.country,
      billingEmail: t.billingEmail,
      missing: missingFiscalData({
        name: t.billingLegalName,
        taxId: t.taxId,
        address: t.billingAddress,
        city: t.billingCity,
        postalCode: t.billingPostalCode,
        country: t.country,
      }),
    };
  }

  async updateTenantBillingDetails(
    tenantId: string,
    input: TenantBillingDetailsInput,
  ): Promise<TenantBillingDetailsDto> {
    await assertTaxIdFree(this.admin, tenantId, input.taxId);
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        billingLegalName: input.legalName,
        taxId: input.taxId,
        billingAddress: input.address,
        billingCity: input.city,
        billingPostalCode: input.postalCode,
        country: input.country,
        ...(input.billingEmail !== undefined ? { billingEmail: input.billingEmail || null } : {}),
      },
    });
    return this.getTenantBillingDetails(tenantId);
  }

  // ---- facturas ----

  async listForTenant(tenantId: string): Promise<PlatformInvoiceDto[]> {
    const rows = await this.admin.platformInvoice.findMany({
      where: { tenantId },
      orderBy: { issuedAt: 'desc' },
      include: INVOICE_INCLUDE,
    });
    return rows.map((r) => this.invoiceToDto(r));
  }

  /** Todas las facturas SaaS (cross-tenant) por fecha de emisión, para el export contable. */
  async listAll(from?: string, to?: string): Promise<PlatformInvoiceDto[]> {
    const issuedAt: { gte?: Date; lte?: Date } = {};
    if (from) issuedAt.gte = new Date(`${from}T00:00:00.000Z`);
    if (to) issuedAt.lte = new Date(`${to}T23:59:59.999Z`);
    const rows = await this.admin.platformInvoice.findMany({
      where: Object.keys(issuedAt).length ? { issuedAt } : {},
      orderBy: { issuedAt: 'asc' },
      include: INVOICE_INCLUDE,
    });
    return rows.map((r) => this.invoiceToDto(r));
  }

  /**
   * Export contable (CSV) de las facturas SaaS emitidas en un año (por
   * `issuedAt`), para la asesoría. Cabecera + filas separadas por `;` con BOM
   * UTF-8 (Excel es-ES). Devuelve solo la cabecera si el año no tiene facturas.
   */
  async exportCsvForYear(year: number): Promise<string> {
    const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));
    const rows = await this.admin.platformInvoice.findMany({
      where: { issuedAt: { gte: start, lt: end } },
      orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
    });
    const header = [
      'Nº factura',
      'Fecha emisión',
      'Concepto',
      'Tenant',
      'Base imponible',
      'IVA',
      'Total',
      'Estado',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const r of rows) {
      const concepto = r.concept ?? (r.planName ? `Suscripción ${r.planName}` : '');
      lines.push(
        [
          csvCell(r.fullNumber),
          csvCell(r.issuedAt.toISOString().slice(0, 10)),
          csvCell(concepto),
          csvCell(r.tenantName),
          Number(r.baseAmount).toFixed(2),
          Number(r.taxAmount).toFixed(2),
          Number(r.total).toFixed(2),
          csvCell(r.status),
        ].join(';'),
      );
    }
    // BOM (U+FEFF) para que Excel detecte UTF-8; se escribe con charCode (no
    // literal) por el lint `no-irregular-whitespace`.
    return String.fromCharCode(0xfeff) + lines.join('\r\n');
  }

  /** Emite la factura de un pago (idempotente por `payment_id`). */
  async issueForPayment(paymentId: string): Promise<PlatformInvoiceDto> {
    const existing = await this.admin.platformInvoice.findUnique({
      where: { paymentId },
      include: INVOICE_INCLUDE,
    });
    if (existing) return this.invoiceToDto(existing);

    const payment = await this.admin.tenantSubscriptionPayment.findUnique({
      where: { id: paymentId },
      include: { tenant: true },
    });
    if (!payment) {
      throw new NotFoundException({ code: 'payment_not_found', message: 'Pago no encontrado' });
    }
    if (payment.status !== 'paid') {
      throw new BadRequestException({
        code: 'payment_not_paid',
        message: 'Solo se factura un pago cobrado',
      });
    }
    const settings = await this.getSettings();
    if (!settings.enabled) {
      throw new BadRequestException({
        code: 'platform_billing_disabled',
        message: 'Activa la facturación del SaaS y completa los datos del emisor',
      });
    }

    const total = Number(payment.amount);
    const taxRate = settings.taxRate;
    const base = round2(total / (1 + taxRate / 100));
    const taxAmount = round2(total - base);
    // La serie va por el AÑO DE EMISIÓN de la factura (ahora), no por la fecha
    // del pago: un pago manual con `paidAt` retroactivo no debe numerarse en la
    // serie de un año anterior (rompería la secuencia y la coherencia fiscal).
    const series = String(new Date().getUTCFullYear());
    const tenant = payment.tenant;
    // Destinatario: razón social y domicilio fiscal del tenant (si los tiene).
    const recipientName = tenant.billingLegalName?.trim() || tenant.name;
    const recipientAddress = formatAddress(
      tenant.billingAddress,
      tenant.billingPostalCode,
      tenant.billingCity,
      tenant.country,
    );
    const recipientMissing = missingFiscalData({
      name: recipientName,
      taxId: tenant.taxId,
      address: tenant.billingAddress,
      city: tenant.billingCity,
      postalCode: tenant.billingPostalCode,
      country: tenant.country,
    });
    // Desglose por líneas (plan + add-ons). Se calcula ANTES de la tx (puede
    // consultar Stripe). La cabecera monolínea (base/IVA/total) no cambia.
    const lines = await this.buildLines(payment, taxRate, { total, base, taxAmount });

    // Con «negocio propio», la factura de suscripción es una factura normal de
    // ese tenant (mismo NIF, misma cadena Veri*Factu y mismo modo de emisión).
    if (settings.ownTenant) {
      return this.issueViaOwnTenant({
        ownTenantId: settings.ownTenant.id,
        payment,
        settings,
        lines,
        recipient: { name: recipientName, address: recipientAddress, missing: recipientMissing },
      });
    }
    // Sin él, la numeración propia no se registra en Veri*Factu: solo vale en
    // pruebas (en envío real a la AEAT hace falta el negocio propio).
    if (this.aeatRealMode) {
      throw new BadRequestException({
        code: 'own_tenant_required',
        message:
          'Indica en Facturación del SaaS el negocio propio que emite las facturas de suscripción (las registra en Veri*Factu)',
      });
    }

    // Numeración secuencial atómica por serie (año) + creación de la factura +
    // líneas. El bloqueo por serie serializa dos emisiones a la vez (antes las
    // dos leían el mismo último número y la segunda fallaba por el único:
    // el cobro quedaba sin factura).
    let created;
    try {
      created = await this.admin.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform_invoice:${series}`}))`;
        const last = await tx.platformInvoice.findFirst({
          where: { series },
          orderBy: { number: 'desc' },
          select: { number: true },
        });
        const number = (last?.number ?? 0) + 1;
        const fullNumber = `${settings.seriesPrefix}-${series}-${String(number).padStart(4, '0')}`;
        const invoice = await tx.platformInvoice.create({
          data: {
            series,
            number,
            fullNumber,
            tenantId: tenant.id,
            tenantName: recipientName,
            tenantTaxId: tenant.taxId,
            tenantEmail: tenant.billingEmail,
            tenantAddress: recipientAddress,
            planSlug: payment.planSlug,
            planName: payment.planName,
            // Concepto real del cobro (p. ej. «Add-on: X»); si el pago no lo trae,
            // el PDF cae a «Suscripción {plan}».
            concept: payment.description ?? null,
            periodStart: payment.periodStart,
            periodEnd: payment.periodEnd,
            baseAmount: base,
            taxRate,
            taxAmount,
            total,
            currency: payment.currency,
            paymentId: payment.id,
          },
        });
        if (lines.length > 0) {
          await tx.platformInvoiceLine.createMany({
            data: lines.map((l) => ({ ...l, platformInvoiceId: invoice.id })),
          });
        }
        return invoice;
      });
    } catch (err) {
      // El mismo pago facturado a la vez por otro proceso (webhook + pago
      // manual, dos réplicas): se devuelve la que ya existe.
      if (isUniqueViolation(err)) {
        const dup = await this.admin.platformInvoice.findUnique({
          where: { paymentId },
          include: INVOICE_INCLUDE,
        });
        if (dup) return this.invoiceToDto(dup);
      }
      throw err;
    }

    // PDF (best-effort: si falla, la factura queda emitida sin PDF y se puede regenerar).
    try {
      const key = await this.renderPdf(created.id, settings, { ...created, lines });
      await this.admin.platformInvoice.update({ where: { id: created.id }, data: { pdfUrl: key } });
      created.pdfUrl = key;
    } catch (err) {
      this.logger.warn(`PDF factura ${created.fullNumber} falló: ${(err as Error).message}`);
    }

    // El cobro ya se hizo: la factura se emite igualmente, pero se avisa al
    // super admin para que pida los datos al tenant y la rectifique.
    if (recipientMissing.length > 0) {
      await this.admin.superAdminNotification
        .create({
          data: {
            type: 'platform_invoice.incomplete_recipient',
            title: `Factura ${created.fullNumber} sin datos del cliente`,
            body: `${tenant.name} no tiene completos sus datos de facturación (${recipientMissing.join(', ')}). Pídeselos y, cuando los tenga, rectifica esta factura por sustitución desde su ficha.`,
            link: `/admin/tenants/${tenant.id}`,
          },
        })
        .catch(() => undefined);
    }

    // Copia contable en Holded (best-effort; no-op si no está activa).
    await this.holded.pushBestEffort(created.id);

    // Email best-effort al tenant.
    await this.sendEmail(created, settings).catch((err) =>
      this.logger.warn(`Email factura ${created.fullNumber} falló: ${(err as Error).message}`),
    );

    const finalRow = await this.admin.platformInvoice.findUnique({
      where: { id: created.id },
      include: INVOICE_INCLUDE,
    });
    return this.invoiceToDto(finalRow ?? created);
  }

  /**
   * Factura de suscripción emitida por el tenant propio: crea (o retoma) su
   * factura normal y guarda aquí la copia que ven el tenant y el admin.
   */
  private async issueViaOwnTenant(args: {
    ownTenantId: string;
    payment: {
      id: string;
      provider: string;
      paidAt: Date | null;
      periodStart: Date | null;
      periodEnd: Date | null;
      planSlug: string | null;
      planName: string | null;
      description: string | null;
      currency: string;
      tenant: { id: string; name: string; taxId: string | null; billingEmail: string | null };
    };
    settings: PlatformBillingSettingsDto;
    lines: LineData[];
    recipient: { name: string; address: string | null; missing: string[] };
  }): Promise<PlatformInvoiceDto> {
    const { payment, settings, lines } = args;
    const issued = await this.ownTenant.issue({
      ownTenantId: args.ownTenantId,
      payment: {
        id: payment.id,
        provider: payment.provider,
        paidAt: payment.paidAt,
        periodStart: payment.periodStart,
        periodEnd: payment.periodEnd,
        tenantId: payment.tenant.id,
      },
      lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        baseAmount: l.baseAmount,
        taxRate: l.taxRate,
      })),
    });
    let created;
    try {
      created = await this.admin.platformInvoice.create({
        data: {
          series: 'own',
          number: 0,
          fullNumber: issued.invoiceNumber,
          invoiceId: issued.invoiceId,
          tenantId: payment.tenant.id,
          tenantName: args.recipient.name,
          tenantTaxId: payment.tenant.taxId,
          tenantEmail: payment.tenant.billingEmail,
          tenantAddress: args.recipient.address,
          planSlug: payment.planSlug,
          planName: payment.planName,
          concept: payment.description ?? null,
          periodStart: payment.periodStart,
          periodEnd: payment.periodEnd,
          baseAmount: issued.subtotal,
          taxRate: settings.taxRate,
          taxAmount: issued.taxAmount,
          total: issued.total,
          currency: payment.currency,
          paymentId: payment.id,
          issuedAt: issued.issueDate,
          pdfUrl: issued.pdfKey,
          lines: { create: lines },
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const dup = await this.admin.platformInvoice.findUnique({
          where: { paymentId: payment.id },
          include: INVOICE_INCLUDE,
        });
        if (dup) return this.invoiceToDto(dup);
      }
      throw err;
    }
    if (args.recipient.missing.length > 0) {
      await this.admin.superAdminNotification
        .create({
          data: {
            type: 'platform_invoice.incomplete_recipient',
            title: `Factura ${created.fullNumber} sin datos del cliente`,
            body: `${payment.tenant.name} no tiene completos sus datos de facturación (${args.recipient.missing.join(', ')}). Pídeselos y rectifica la factura desde el negocio propio.`,
            link: `/admin/tenants/${payment.tenant.id}`,
          },
        })
        .catch(() => undefined);
    }
    await this.sendEmail(created, settings).catch((err) =>
      this.logger.warn(`Email factura ${created.fullNumber} falló: ${(err as Error).message}`),
    );
    const finalRow = await this.admin.platformInvoice.findUniqueOrThrow({
      where: { id: created.id },
      include: INVOICE_INCLUDE,
    });
    return this.invoiceToDto(finalRow);
  }

  /**
   * Construye el desglose por líneas de la factura de un pago:
   * - Pago de Stripe con factura (`in_…`): lee las líneas reales de la factura de
   *   Stripe (plan + add-ons + proraciones), mapeando cada Price a plan/add-on.
   * - Resto (pago manual, cobro de add-on de la bandeja «Hoy»): una sola línea
   *   derivada del pago (kind por el prefijo «Add-on:» de la descripción).
   * La suma de los totales de las líneas ≈ el total de la cabecera.
   */
  private async buildLines(
    payment: { provider: string; externalId: string | null; description: string | null },
    taxRate: number,
    header: { total: number; base: number; taxAmount: number },
  ): Promise<LineData[]> {
    const split = (
      grossTotal: number,
      quantity: number,
      kind: string,
      description: string,
      position: number,
    ): LineData => {
      const b = round2(grossTotal / (1 + taxRate / 100));
      return {
        kind,
        description,
        quantity,
        unitAmount: round2(grossTotal / (quantity || 1)),
        baseAmount: b,
        taxRate,
        taxAmount: round2(grossTotal - b),
        total: round2(grossTotal),
        position,
      };
    };

    // Factura de Stripe: intenta el desglose real por líneas.
    if (
      payment.provider === 'stripe' &&
      payment.externalId?.startsWith('in_') &&
      this.stripeGateway.isConfigured()
    ) {
      try {
        const invoice = await this.stripe.invoices.retrieve(payment.externalId, {
          expand: ['lines.data.price'],
        });
        const stripeLines = invoice.lines?.data ?? [];
        if (stripeLines.length > 0) {
          const [plans, addons] = await Promise.all([
            this.admin.subscriptionPlan.findMany({
              where: { stripePriceId: { not: null } },
              select: { stripePriceId: true, name: true },
            }),
            this.admin.subscriptionAddon.findMany({
              where: { stripePriceId: { not: null } },
              select: { stripePriceId: true, name: true },
            }),
          ]);
          const planByPrice = new Map(plans.map((p) => [p.stripePriceId, p.name]));
          const addonByPrice = new Map(addons.map((a) => [a.stripePriceId, a.name]));
          // Con precios +IVA, Stripe da cada línea sin el IVA (lo suma aparte):
          // se escala al total cobrado para que cada línea lleve su IVA.
          const exclTax = (invoice as { total_excluding_tax?: number | null }).total_excluding_tax;
          const grossFactor =
            exclTax && exclTax > 0 && invoice.total > exclTax ? invoice.total / exclTax : 1;
          return stripeLines.map((line, i) => {
            const priceId = extractLinePriceId(line);
            const planName = priceId ? planByPrice.get(priceId) : undefined;
            const addonName = priceId ? addonByPrice.get(priceId) : undefined;
            const isProration = extractLineProration(line);
            const kind = addonName ? 'addon' : isProration ? 'adjustment' : 'plan';
            const description =
              addonName ?? planName ?? line.description ?? (isProration ? 'Ajuste' : 'Suscripción');
            const gross = round2(((line.amount ?? 0) / 100) * grossFactor);
            const qty = line.quantity ?? 1;
            return split(gross, qty, kind, description, i);
          });
        }
      } catch (err) {
        this.logger.warn(
          `No se pudieron leer las líneas de la factura Stripe ${payment.externalId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Pago manual / cobro de add-on / fallback: una sola línea con la cabecera.
    const isAddon = (payment.description ?? '').startsWith('Add-on:');
    return [
      {
        kind: isAddon ? 'addon' : 'plan',
        description: payment.description ?? 'Suscripción',
        quantity: 1,
        unitAmount: header.base,
        baseAmount: header.base,
        taxRate,
        taxAmount: header.taxAmount,
        total: header.total,
        position: 0,
      },
    ];
  }

  /** Para el hook automático: no lanza (best-effort). */
  async issueForPaymentBestEffort(paymentId: string): Promise<void> {
    try {
      const settings = await this.admin.platformBillingSettings.findFirst();
      if (!settings?.enabled) return; // facturación desactivada
      await this.issueForPayment(paymentId);
    } catch (err) {
      this.logger.warn(`Auto-factura del pago ${paymentId} falló: ${(err as Error).message}`);
    }
  }

  /**
   * Dinero devuelto de un cobro de suscripción (reembolso, contracargo perdido,
   * adeudo SEPA devuelto): su factura recibe la rectificativa de abono. Con
   * negocio propio, como reembolso de su factura (abono automático que se
   * copia aquí solo); sin él, rectificativa por diferencias de la numeración
   * propia. Sin factura emitida no hay nada que abonar.
   */
  async creditForPayment(paymentId: string, amount: number, reason: string): Promise<void> {
    if (amount <= 0) return;
    const pinv = await this.admin.platformInvoice.findUnique({ where: { paymentId } });
    if (!pinv) return;
    if (pinv.invoiceId) {
      const real = await this.admin.invoice.findUniqueOrThrow({
        where: { id: pinv.invoiceId },
        select: { tenantId: true },
      });
      await this.ownTenant.refund({
        ownTenantId: real.tenantId,
        invoiceId: pinv.invoiceId,
        amount,
        reason,
      });
      return;
    }
    if (pinv.status === 'cancelled') return;
    await this.rectify(pinv.id, {
      method: 'differences',
      rectificationType: 'R4',
      reason,
      amount: Math.min(amount, Number(pinv.total)),
    });
  }

  /**
   * Rectificativa emitida por el negocio propio sobre una factura de
   * suscripción: se copia aquí para que la vean el tenant y el admin.
   */
  @OnEvent(DOMAIN_EVENTS.invoice_issued, { async: true, promisify: true })
  async onOwnTenantInvoiceIssued(p: DomainEventPayload): Promise<void> {
    try {
      await this.mirrorOwnTenantRectification(p.tenantId, p.entityId);
    } catch (err) {
      this.logger.warn(
        `Rectificativa ${p.entityId} sin copiar a suscripciones: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async mirrorOwnTenantRectification(tenantId: string, invoiceId: string): Promise<void> {
    const rect = await this.admin.invoice.findFirst({
      where: { id: invoiceId, tenantId, rectifiesInvoiceId: { not: null } },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceType: true,
        issueDate: true,
        subtotal: true,
        taxAmount: true,
        total: true,
        rectifiesInvoiceId: true,
        rectificationReason: true,
        correctionMethod: true,
      },
    });
    if (!rect?.rectifiesInvoiceId) return;
    const original = await this.admin.platformInvoice.findUnique({
      where: { invoiceId: rect.rectifiesInvoiceId },
    });
    if (!original) return; // no es una factura de suscripción
    const already = await this.admin.platformInvoice.findUnique({ where: { invoiceId: rect.id } });
    if (already) return;
    const substitution = rect.correctionMethod === 'by_substitution';
    const total = Number(rect.total);
    const created = await this.admin.platformInvoice.create({
      data: {
        series: 'own',
        number: 0,
        fullNumber: rect.invoiceNumber,
        invoiceId: rect.id,
        tenantId: original.tenantId,
        tenantName: original.tenantName,
        tenantTaxId: original.tenantTaxId,
        tenantEmail: original.tenantEmail,
        tenantAddress: original.tenantAddress,
        planSlug: original.planSlug,
        planName: original.planName,
        concept: original.concept,
        periodStart: original.periodStart,
        periodEnd: original.periodEnd,
        baseAmount: Number(rect.subtotal),
        taxRate: original.taxRate,
        taxAmount: Number(rect.taxAmount),
        total,
        currency: original.currency,
        issuedAt: rect.issueDate ?? new Date(),
        invoiceType: rect.invoiceType,
        rectifiesInvoiceId: original.id,
        rectificationReason: rect.rectificationReason,
        correctionMethod: substitution ? 'substitution' : 'differences',
        pdfUrl: await this.ownTenant.pdfKeyFor(tenantId, rect.id),
        lines: {
          create: [
            {
              kind: 'adjustment',
              description: rect.rectificationReason ?? 'Rectificación',
              quantity: 1,
              unitAmount: Number(rect.subtotal),
              baseAmount: Number(rect.subtotal),
              taxRate: original.taxRate,
              taxAmount: Number(rect.taxAmount),
              total,
              position: 0,
            },
          ],
        },
      },
    });
    // La original queda sustituida, o anulada si el abono la cubre entera.
    const credited = await this.admin.platformInvoice.aggregate({
      where: { rectifiesInvoiceId: original.id, correctionMethod: 'differences' },
      _sum: { total: true },
    });
    const fullyCredited =
      !substitution && -Number(credited._sum.total ?? 0) >= Number(original.total) - 0.005;
    if (substitution || fullyCredited) {
      await this.admin.platformInvoice.update({
        where: { id: original.id },
        data: { status: substitution ? 'rectified' : 'cancelled' },
      });
    }
    const settings = await this.getSettings();
    await this.sendEmail(created, settings).catch(() => undefined);
  }

  /** URL firmada (GET) del PDF; el bucket de facturas es privado. */
  async getPdfUrl(id: string): Promise<{ url: string }> {
    const inv = await this.admin.platformInvoice.findUnique({ where: { id } });
    if (!inv?.pdfUrl) {
      throw new NotFoundException({ code: 'pdf_not_available', message: 'Sin PDF' });
    }
    return { url: await this.files.getPresignedGetUrl('invoices', inv.pdfUrl, 300) };
  }

  /** PDF de una factura, verificando que pertenece al tenant (self-service). */
  async getPdfUrlForTenant(id: string, tenantId: string): Promise<{ url: string }> {
    const inv = await this.admin.platformInvoice.findFirst({ where: { id, tenantId } });
    if (!inv) throw new NotFoundException({ code: 'invoice_not_found', message: 'No encontrada' });
    if (!inv.pdfUrl) {
      throw new NotFoundException({ code: 'pdf_not_available', message: 'Sin PDF' });
    }
    return { url: await this.files.getPresignedGetUrl('invoices', inv.pdfUrl, 300) };
  }

  async resend(id: string): Promise<void> {
    const inv = await this.admin.platformInvoice.findUnique({ where: { id } });
    if (!inv) throw new NotFoundException({ code: 'invoice_not_found', message: 'No encontrada' });
    const settings = await this.getSettings();
    await this.sendEmail(inv, settings);
  }

  // ---- rectificativas ----

  /**
   * Rectifica una factura de suscripción en la serie de rectificativas:
   * - `substitution`: la sustituye con los mismos importes y los datos fiscales
   *   actuales del tenant (corrige razón social, NIF o domicilio);
   * - `differences`: abono en negativo, total (anula la factura) o parcial.
   */
  async rectify(id: string, input: RectifyPlatformInvoiceInput): Promise<PlatformInvoiceDto> {
    const original = await this.admin.platformInvoice.findUnique({
      where: { id },
      include: { ...INVOICE_INCLUDE, tenant: true },
    });
    if (!original) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    if (original.invoiceId) {
      // Emitida por el negocio propio: se rectifica allí (Facturas), y la
      // rectificativa aparece aquí sola.
      throw new BadRequestException({
        code: 'rectify_in_own_tenant',
        message: `Rectifica la factura ${original.fullNumber} desde Facturas del negocio propio: la rectificativa aparecerá aquí sola`,
      });
    }
    if (original.invoiceType !== 'F1') {
      throw new BadRequestException({
        code: 'invoice_not_rectifiable',
        message: 'Una rectificativa no se puede rectificar: rectifica la factura original',
      });
    }
    if (original.status === 'cancelled') {
      throw new BadRequestException({
        code: 'invoice_already_cancelled',
        message: 'Esta factura ya está abonada por completo',
      });
    }
    const settings = await this.getSettings();
    if (settings.missing.length > 0) {
      throw new BadRequestException({
        code: 'platform_billing_incomplete',
        message: `Faltan datos del emisor: ${settings.missing.join(', ')}`,
      });
    }

    const total = Number(original.total);
    const credited = original.rectifications
      .filter((r) => r.correctionMethod === 'differences')
      .reduce((acc, r) => acc - Number(r.total), 0);
    const remaining = round2(total - credited);
    const taxRate = Number(original.taxRate);
    const tenant = original.tenant;
    const current = {
      name: tenant.billingLegalName?.trim() || tenant.name,
      taxId: tenant.taxId,
      address: formatAddress(
        tenant.billingAddress,
        tenant.billingPostalCode,
        tenant.billingCity,
        tenant.country,
      ),
    };
    const currentMissing = missingFiscalData({
      name: current.name,
      taxId: tenant.taxId,
      address: tenant.billingAddress,
      city: tenant.billingCity,
      postalCode: tenant.billingPostalCode,
      country: tenant.country,
    });

    let recipient: { name: string; taxId: string | null; address: string | null };
    let header: { base: number; taxAmount: number; total: number };
    let lines: LineData[];
    let originalStatus: string | null = null;

    if (input.method === 'substitution') {
      if (original.rectifications.some((r) => r.correctionMethod === 'substitution')) {
        throw new BadRequestException({
          code: 'invoice_already_substituted',
          message: 'Esta factura ya tiene una rectificativa que la sustituye',
        });
      }
      if (credited > 0) {
        throw new BadRequestException({
          code: 'invoice_partially_credited',
          message: 'La factura tiene abonos: no se puede sustituir',
        });
      }
      if (currentMissing.length > 0) {
        throw new BadRequestException({
          code: 'tenant_billing_incomplete',
          message: `El tenant aún no tiene completos sus datos de facturación: ${currentMissing.join(', ')}`,
          details: { missing: currentMissing },
        });
      }
      recipient = current;
      header = { base: Number(original.baseAmount), taxAmount: Number(original.taxAmount), total };
      lines =
        original.lines.length > 0
          ? original.lines.map((l, i) => ({
              kind: l.kind,
              description: l.description,
              quantity: l.quantity,
              unitAmount: Number(l.unitAmount),
              baseAmount: Number(l.baseAmount),
              taxRate: Number(l.taxRate),
              taxAmount: Number(l.taxAmount),
              total: Number(l.total),
              position: i,
            }))
          : [
              {
                kind: 'plan',
                description: original.concept ?? `Suscripción ${original.planName ?? ''}`.trim(),
                quantity: 1,
                unitAmount: header.base,
                baseAmount: header.base,
                taxRate,
                taxAmount: header.taxAmount,
                total,
                position: 0,
              },
            ];
      originalStatus = 'rectified';
    } else {
      const gross = round2(input.amount ?? remaining);
      if (gross <= 0 || gross > remaining + 0.005) {
        throw new BadRequestException({
          code: 'credit_exceeds_invoice',
          message: `Como máximo se pueden abonar ${eur(remaining)} de esta factura`,
        });
      }
      const base = round2(gross / (1 + taxRate / 100));
      header = { base: -base, taxAmount: -round2(gross - base), total: -gross };
      recipient =
        currentMissing.length === 0
          ? current
          : {
              name: original.tenantName,
              taxId: original.tenantTaxId,
              address: original.tenantAddress,
            };
      lines = [
        {
          kind: 'adjustment',
          description: `Abono de la factura ${original.fullNumber}`,
          quantity: 1,
          unitAmount: header.base,
          baseAmount: header.base,
          taxRate,
          taxAmount: header.taxAmount,
          total: header.total,
          position: 0,
        },
      ];
      if (remaining - gross < 0.005) originalStatus = 'cancelled';
    }

    // Serie propia de rectificativas por año de emisión.
    const year = String(new Date().getUTCFullYear());
    const series = `R${year}`;
    const created = await this.admin.$transaction(async (tx) => {
      // Serializa la numeración de la serie (dos rectificativas a la vez).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`platform_invoice:${series}`}))`;
      const last = await tx.platformInvoice.findFirst({
        where: { series },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      const number = (last?.number ?? 0) + 1;
      const fullNumber = `${settings.seriesPrefix}-R-${year}-${String(number).padStart(4, '0')}`;
      const invoice = await tx.platformInvoice.create({
        data: {
          series,
          number,
          fullNumber,
          invoiceType: input.rectificationType,
          rectifiesInvoiceId: original.id,
          rectificationReason: input.reason,
          correctionMethod: input.method,
          tenantId: original.tenantId,
          tenantName: recipient.name,
          tenantTaxId: recipient.taxId,
          tenantEmail: tenant.billingEmail ?? original.tenantEmail,
          tenantAddress: recipient.address,
          planSlug: original.planSlug,
          planName: original.planName,
          concept: original.concept,
          periodStart: original.periodStart,
          periodEnd: original.periodEnd,
          baseAmount: header.base,
          taxRate,
          taxAmount: header.taxAmount,
          total: header.total,
          currency: original.currency,
        },
      });
      await tx.platformInvoiceLine.createMany({
        data: lines.map((l) => ({ ...l, platformInvoiceId: invoice.id })),
      });
      if (originalStatus) {
        await tx.platformInvoice.update({
          where: { id: original.id },
          data: { status: originalStatus },
        });
      }
      return invoice;
    });

    try {
      const key = await this.renderPdf(created.id, settings, {
        ...created,
        lines,
        rectifies: { fullNumber: original.fullNumber, issuedAt: original.issuedAt },
      });
      await this.admin.platformInvoice.update({ where: { id: created.id }, data: { pdfUrl: key } });
    } catch (err) {
      this.logger.warn(`PDF rectificativa ${created.fullNumber} falló: ${(err as Error).message}`);
    }
    await this.sendEmail(created, settings).catch((err) =>
      this.logger.warn(
        `Email rectificativa ${created.fullNumber} falló: ${(err as Error).message}`,
      ),
    );
    // Copia contable en Holded (best-effort; no-op si no está activa).
    await this.holded.pushBestEffort(created.id);

    const row = await this.admin.platformInvoice.findUniqueOrThrow({
      where: { id: created.id },
      include: INVOICE_INCLUDE,
    });
    return this.invoiceToDto(row);
  }

  // ---- helpers ----

  private async sendEmail(
    inv: {
      fullNumber: string;
      tenantEmail: string | null;
      total: unknown;
      currency: string;
      invoiceType?: string;
    },
    settings: PlatformBillingSettingsDto,
  ): Promise<void> {
    if (!inv.tenantEmail) return;
    const isRect = !!inv.invoiceType && inv.invoiceType !== 'F1';
    const title = isRect ? 'Factura rectificativa' : 'Factura';
    const html = `<p>Tu ${title.toLowerCase()} <strong>${esc(inv.fullNumber)}</strong> por ${eur(
      Number(inv.total),
    )} ya está disponible.</p><p>Puedes descargarla desde tu panel, en <strong>Ajustes → Suscripción → Facturas y pagos</strong>. Gracias por confiar en ${esc(
      settings.legalName || 'TrasterOS',
    )}.</p>`;
    await this.email.sendRendered({
      to: inv.tenantEmail,
      kind: 'saas_invoice',
      subject: `${title} ${inv.fullNumber}`,
      html,
      text: `${title} ${inv.fullNumber} por ${eur(Number(inv.total))}.`,
    });
  }

  private async renderPdf(
    id: string,
    settings: PlatformBillingSettingsDto,
    inv: RenderInvoice,
  ): Promise<string> {
    const html = this.renderHtml(settings, inv);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
        printBackground: true,
      });
      const key = `platform/${id}-${inv.fullNumber.replace(/\//g, '_')}.pdf`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: pdf,
          ContentType: 'application/pdf',
        }),
      );
      return key;
    } finally {
      await page.close();
    }
  }

  private renderHtml(s: PlatformBillingSettingsDto, inv: RenderInvoice): string {
    const period =
      inv.periodStart && inv.periodEnd
        ? `${inv.periodStart.toLocaleDateString('es-ES')} – ${inv.periodEnd.toLocaleDateString('es-ES')}`
        : '';
    const issuer = [
      s.legalName,
      s.taxId ? `NIF: ${s.taxId}` : '',
      s.address,
      [s.postalCode, s.city].filter(Boolean).join(' '),
      s.country,
    ]
      .filter(Boolean)
      .map((l) => esc(String(l)))
      .join('<br>');
    const client = [
      inv.tenantName,
      inv.tenantTaxId ? `NIF: ${inv.tenantTaxId}` : '',
      ...(inv.tenantAddress ?? '').split('\n'),
    ]
      .filter(Boolean)
      .map((l) => esc(String(l)))
      .join('<br>');
    // Filas del detalle: una por línea (plan + add-ons); si no hay líneas, cae a
    // la línea única del concepto (facturas antiguas / pago manual sin desglose).
    const lines = inv.lines ?? [];
    const rowsHtml =
      lines.length > 0
        ? lines
            .map(
              (l) =>
                `<tr><td>${esc(l.description)}${
                  l.quantity > 1 ? ` <span class="muted">×${l.quantity}</span>` : ''
                }</td><td class="n">${eur(Number(l.baseAmount))}</td></tr>`,
            )
            .join('')
        : `<tr><td>${esc(inv.concept ?? `Suscripción ${inv.planName ?? 'TrasterOS'}`)}${
            period ? ` · ${esc(period)}` : ''
          }</td><td class="n">${eur(Number(inv.baseAmount))}</td></tr>`;
    const isRect = !!inv.invoiceType && inv.invoiceType !== 'F1';
    const rectBlock = isRect
      ? `<div class="muted">Tipo: ${esc(inv.invoiceType ?? '')} · ${
          inv.correctionMethod === 'substitution' ? 'Por sustitución' : 'Por diferencias'
        }${
          inv.rectifies
            ? ` · Rectifica la factura ${esc(inv.rectifies.fullNumber)} de ${inv.rectifies.issuedAt.toLocaleDateString('es-ES')}`
            : ''
        }</div>${
          inv.rectificationReason
            ? `<div class="muted">Motivo: ${esc(inv.rectificationReason)}</div>`
            : ''
        }`
      : '';
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
      body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12px}
      h1{font-size:20px;margin:0 0 4px}
      .row{display:flex;justify-content:space-between;margin-top:24px}
      .box{width:48%}
      table{width:100%;border-collapse:collapse;margin-top:28px}
      th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}
      td.n,th.n{text-align:right}
      .totals{margin-top:16px;margin-left:auto;width:40%}
      .totals div{display:flex;justify-content:space-between;padding:4px 0}
      .totals .grand{font-weight:bold;font-size:14px;border-top:2px solid #111;margin-top:4px;padding-top:8px}
      .muted{color:#666}
    </style></head><body>
      <h1>${isRect ? 'Factura rectificativa' : 'Factura'} ${esc(inv.fullNumber)}</h1>
      ${rectBlock}
      <div class="muted">Fecha de expedición: ${inv.issuedAt.toLocaleDateString('es-ES')}</div>
      ${period ? `<div class="muted">Periodo facturado: ${esc(period)}</div>` : ''}
      <div class="row">
        <div class="box"><strong>Emisor</strong><br>${issuer || '—'}</div>
        <div class="box"><strong>Cliente</strong><br>${client || '—'}</div>
      </div>
      <table><thead><tr><th>Concepto</th><th class="n">Base</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>
      <div class="totals">
        <div><span>Base imponible</span><span>${eur(Number(inv.baseAmount))}</span></div>
        <div><span>IVA (${Number(inv.taxRate)}%)</span><span>${eur(Number(inv.taxAmount))}</span></div>
        <div class="grand"><span>Total</span><span>${eur(Number(inv.total))}</span></div>
      </div>
    </body></html>`;
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) this.browserPromise = this.launchBrowser();
    try {
      const b = await this.browserPromise;
      if (b.connected) return b;
    } catch (err) {
      this.logger.warn(`Browser reset: ${(err as Error).message}`);
    }
    this.browserPromise = this.launchBrowser();
    return this.browserPromise;
  }

  private async launchBrowser(): Promise<Browser> {
    const { default: puppeteer } = await import('puppeteer');
    return puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }

  private settingsToDto(r: {
    legalName: string;
    taxId: string;
    address: string | null;
    city: string | null;
    postalCode: string | null;
    country: string;
    email: string | null;
    taxRate: unknown;
    seriesPrefix: string;
    enabled: boolean;
    pricesIncludeVat: boolean;
    ownTenant?: { id: string; name: string; slug: string } | null;
  }): PlatformBillingSettingsDto {
    return {
      missing: missingFiscalData({
        name: r.legalName,
        taxId: r.taxId,
        address: r.address,
        city: r.city,
        postalCode: r.postalCode,
        country: r.country,
      }),
      ownTenant: r.ownTenant ?? null,
      legalName: r.legalName,
      taxId: r.taxId,
      address: r.address,
      city: r.city,
      postalCode: r.postalCode,
      country: r.country,
      email: r.email,
      taxRate: Number(r.taxRate),
      seriesPrefix: r.seriesPrefix,
      enabled: r.enabled,
      pricesIncludeVat: r.pricesIncludeVat,
    };
  }

  private invoiceToDto(r: {
    id: string;
    fullNumber: string;
    tenantId: string;
    tenantName: string;
    tenantTaxId: string | null;
    tenantAddress: string | null;
    planName: string | null;
    concept: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    baseAmount: unknown;
    taxRate: unknown;
    taxAmount: unknown;
    total: unknown;
    currency: string;
    status: string;
    issuedAt: Date;
    pdfUrl: string | null;
    paymentId: string | null;
    invoiceType: string;
    rectificationReason: string | null;
    correctionMethod: string | null;
    invoiceId?: string | null;
    rectifiesInvoice?: { id: string; fullNumber: string } | null;
    rectifications?: {
      id: string;
      fullNumber: string;
      correctionMethod: string | null;
      total: unknown;
    }[];
    lines?: Array<LineRow & { id: string }>;
  }): PlatformInvoiceDto {
    return {
      id: r.id,
      fullNumber: r.fullNumber,
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      tenantTaxId: r.tenantTaxId,
      planName: r.planName,
      concept: r.concept ?? (r.planName ? `Suscripción ${r.planName}` : null),
      periodStart: r.periodStart?.toISOString() ?? null,
      periodEnd: r.periodEnd?.toISOString() ?? null,
      baseAmount: Number(r.baseAmount),
      taxRate: Number(r.taxRate),
      taxAmount: Number(r.taxAmount),
      total: Number(r.total),
      currency: r.currency,
      status: r.status,
      issuedAt: r.issuedAt.toISOString(),
      hasPdf: Boolean(r.pdfUrl),
      paymentId: r.paymentId,
      ownTenantInvoiceId: r.invoiceId ?? null,
      missing: [...(r.tenantTaxId ? [] : ['NIF']), ...(r.tenantAddress ? [] : ['Domicilio'])],
      invoiceType: r.invoiceType,
      rectifies: r.rectifiesInvoice ?? null,
      rectificationReason: r.rectificationReason,
      correctionMethod: r.correctionMethod,
      rectifiedBy: (r.rectifications ?? []).map((x) => ({
        id: x.id,
        fullNumber: x.fullNumber,
        correctionMethod: x.correctionMethod,
        total: Number(x.total),
      })),
      lines: (r.lines ?? []).map(
        (l): PlatformInvoiceLineDto => ({
          id: l.id,
          kind: l.kind,
          description: l.description,
          quantity: l.quantity,
          unitAmount: Number(l.unitAmount),
          baseAmount: Number(l.baseAmount),
          taxRate: Number(l.taxRate),
          taxAmount: Number(l.taxAmount),
          total: Number(l.total),
        }),
      ),
    };
  }
}

/** Domicilio en líneas: calle / CP + población / país (si no es España). */
export function formatAddress(
  address: string | null,
  postalCode: string | null,
  city: string | null,
  country: string | null,
): string | null {
  if (!address?.trim()) return null;
  const cityLine = [postalCode, city].filter((v) => v?.trim()).join(' ');
  return [address.trim(), cityLine, country && country !== 'ES' ? country : '']
    .filter(Boolean)
    .join('\n');
}

/** Fila de detalle para el render (desde Prisma o construida en `issueForPayment`). */
interface LineRow {
  kind: string;
  description: string;
  quantity: number;
  unitAmount: unknown;
  baseAmount: unknown;
  taxRate: unknown;
  taxAmount: unknown;
  total: unknown;
}

/**
 * Id del Price de una línea de factura de Stripe, tolerante a la versión de API:
 * `line.price.id` (API antigua) o `line.pricing.price_details.price` (API 2025+).
 */
function extractLinePriceId(line: unknown): string | null {
  const l = line as {
    price?: string | { id?: string } | null;
    pricing?: { price_details?: { price?: string } } | null;
  };
  if (typeof l.price === 'string') return l.price;
  if (l.price && typeof l.price === 'object' && l.price.id) return l.price.id;
  return l.pricing?.price_details?.price ?? null;
}

/** True si la línea de Stripe es una proración (campo movido según versión de API). */
function extractLineProration(line: unknown): boolean {
  const l = line as { proration?: boolean; parent?: { type?: string } };
  return Boolean(l.proration);
}
