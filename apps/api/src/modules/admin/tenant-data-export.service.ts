import { randomUUID } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type { TenantDataExportDto } from '@storageos/shared';

/** Validez del enlace de descarga. */
const LINK_TTL_SECONDS = 60 * 60;

type Cell = string | number | boolean | Date | null;
type Column<T> = { header: string; width?: number; value: (row: T) => Cell };

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/**
 * Exportación completa de los datos de un tenant (portabilidad, p. ej. al darse
 * de baja): un Excel con una hoja por tipo de dato. Lo pide el propietario desde
 * su panel o el super admin desde la ficha del tenant (también si está dado de
 * baja, antes de anonimizarlo). No incluye secretos: de las cuentas bancarias
 * solo van los 4 últimos dígitos; los PDF y documentos subidos no van dentro.
 */
@Injectable()
export class TenantDataExportService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
  ) {}

  /** Genera el Excel, lo deja en el bucket de informes y da un enlace de 1 hora. */
  async export(tenantId: string): Promise<TenantDataExportDto> {
    const built = await this.buildFile(tenantId);
    const url = await this.files.getPresignedGetUrl('reports', built.key, LINK_TTL_SECONDS);
    return {
      url,
      expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString(),
      fileBytes: built.fileBytes,
      counts: {
        facilities: built.counts['Locales'] ?? 0,
        units: built.counts['Trasteros'] ?? 0,
        customers: built.counts['Inquilinos'] ?? 0,
        contracts: built.counts['Contratos'] ?? 0,
        invoices: built.counts['Facturas'] ?? 0,
        payments: built.counts['Cobros'] ?? 0,
      },
    };
  }

  /** Enlace de descarga (1 hora) de un fichero ya generado. */
  downloadUrl(key: string): Promise<string> {
    return this.files.getPresignedGetUrl('reports', key, LINK_TTL_SECONDS);
  }

  /**
   * Genera el Excel completo (una hoja por tipo de dato, sin secretos) y lo
   * sube al bucket de informes. Devuelve la clave, el tamaño y las filas de
   * cada hoja.
   */
  async buildFile(
    tenantId: string,
  ): Promise<{ key: string; fileBytes: number; counts: Record<string, number> }> {
    const tenant = await this.admin.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException({ code: 'tenant_not_found' });
    const where = { tenantId };

    const [
      facilities,
      unitTypes,
      units,
      customers,
      contracts,
      invoices,
      items,
      payments,
      mandates,
      leads,
      expenses,
      incidents,
      owners,
      statements,
      whatsappMessages,
      webChatMessages,
      channels,
    ] = await Promise.all([
      this.admin.facility.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { owner: { select: { taxId: true } } },
      }),
      this.admin.unitType.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.unit.findMany({
        where,
        orderBy: { code: 'asc' },
        include: {
          facility: { select: { name: true } },
          unitType: { select: { name: true } },
        },
      }),
      this.admin.customer.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.contract.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: {
          unit: { select: { code: true, facility: { select: { name: true } } } },
          customer: { select: { email: true, documentNumber: true } },
          owner: { select: { taxId: true } },
        },
      }),
      this.admin.invoice.findMany({
        where,
        orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }],
        include: {
          customer: { select: { email: true, documentNumber: true } },
          owner: { select: { taxId: true } },
        },
      }),
      this.admin.invoiceItem.findMany({
        where,
        orderBy: [{ invoiceId: 'asc' }, { position: 'asc' }],
        include: { invoice: { select: { invoiceNumber: true } } },
      }),
      this.admin.payment.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { invoice: { select: { invoiceNumber: true } } },
      }),
      this.admin.sepaMandate.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { customer: { select: { email: true, documentNumber: true } } },
      }),
      this.admin.lead.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.expense.findMany({
        where,
        orderBy: { expenseDate: 'asc' },
        include: { facility: { select: { name: true } } },
      }),
      this.admin.incident.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.owner.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.ownerStatement.findMany({
        where,
        orderBy: [{ periodStart: 'asc' }, { createdAt: 'asc' }],
        include: { owner: { select: { taxId: true } } },
      }),
      this.admin.whatsappMessage.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { conversation: { select: { waId: true, contactName: true } } },
      }),
      this.admin.webChatMessage.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { conversation: { select: { visitorId: true, utmSource: true } } },
      }),
      this.admin.marketingChannel.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { facility: { select: { name: true } } },
      }),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TrasterOS';
    wb.created = new Date();

    this.sheet(
      wb,
      'Empresa',
      [tenant],
      [
        { header: 'Nombre', value: (t) => t.name },
        { header: 'Razón social', value: (t) => t.billingLegalName },
        { header: 'NIF', value: (t) => t.taxId },
        { header: 'Domicilio', value: (t) => t.billingAddress },
        { header: 'Ciudad', value: (t) => t.billingCity },
        { header: 'Código postal', value: (t) => t.billingPostalCode },
        { header: 'Email de facturación', value: (t) => t.billingEmail },
        { header: 'Alta', value: (t) => t.createdAt },
      ],
    );
    this.sheet(wb, 'Locales', facilities, [
      { header: 'Nombre', width: 28, value: (f) => f.name },
      { header: 'Dirección', width: 36, value: (f) => f.address },
      { header: 'Ciudad', value: (f) => f.city },
      { header: 'Código postal', value: (f) => f.postalCode },
      { header: 'Teléfono', value: (f) => f.contactPhone },
      { header: 'Email', value: (f) => f.contactEmail },
      { header: 'Propietario (NIF)', value: (f) => f.owner?.taxId ?? null },
      { header: 'Activo', value: (f) => f.isActive && !f.deletedAt },
    ]);
    this.sheet(wb, 'Tipos de trastero', unitTypes, [
      { header: 'Nombre', width: 24, value: (u) => u.name },
      { header: 'Precio mensual', value: (u) => num(u.defaultPriceMonthly) },
      { header: 'Fianza', value: (u) => num(u.defaultDepositAmount) },
      { header: 'Tipo de inmueble', value: (u) => u.propertyKind },
      { header: 'Activo', value: (u) => u.isActive },
    ]);
    this.sheet(wb, 'Trasteros', units, [
      { header: 'Código', value: (u) => u.code },
      { header: 'Local', width: 24, value: (u) => u.facility.name },
      { header: 'Tipo', width: 20, value: (u) => u.unitType.name },
      { header: 'Ancho (m)', value: (u) => num(u.widthM) },
      { header: 'Fondo (m)', value: (u) => num(u.depthM) },
      { header: 'Alto (m)', value: (u) => num(u.heightM) },
      { header: 'Superficie (m²)', value: (u) => num(u.areaM2) },
      { header: 'Precio mensual', value: (u) => num(u.basePriceMonthly) },
      { header: 'Estado', value: (u) => u.status },
    ]);
    this.sheet(wb, 'Inquilinos', customers, [
      { header: 'Tipo', value: (c) => c.customerType },
      { header: 'Nombre', value: (c) => c.firstName },
      { header: 'Apellidos', value: (c) => c.lastName },
      { header: 'Razón social', value: (c) => c.companyName },
      { header: 'Tipo de documento', value: (c) => c.documentType },
      { header: 'Documento', value: (c) => c.documentNumber },
      { header: 'Email', width: 28, value: (c) => c.email },
      { header: 'Teléfono', value: (c) => c.phone },
      { header: 'Dirección', width: 32, value: (c) => c.address },
      { header: 'Ciudad', value: (c) => c.city },
      { header: 'Código postal', value: (c) => c.postalCode },
      { header: 'País', value: (c) => c.country },
      { header: 'Sin fianza', value: (c) => c.depositExempt },
      { header: 'Baja de comunicaciones comerciales', value: (c) => c.marketingOptOutAt },
      { header: 'Borrado', value: (c) => c.deletedAt },
      { header: 'Alta', value: (c) => c.createdAt },
    ]);
    this.sheet(wb, 'Contratos', contracts, [
      { header: 'Número', value: (c) => c.contractNumber },
      { header: 'Estado', value: (c) => c.status },
      { header: 'Id del inquilino', width: 38, value: (c) => c.customerId },
      { header: 'Inquilino (email)', width: 28, value: (c) => c.customer.email },
      { header: 'Inquilino (documento)', value: (c) => c.customer.documentNumber },
      { header: 'Local', width: 24, value: (c) => c.unit.facility.name },
      { header: 'Trastero', value: (c) => c.unit.code },
      { header: 'Inicio', value: (c) => c.startDate },
      { header: 'Fin', value: (c) => c.endDate },
      { header: 'Firmado', value: (c) => c.signedAt },
      { header: 'Cuota mensual', value: (c) => num(c.priceMonthly) },
      { header: 'Descuento', value: (c) => num(c.discountAmount) },
      { header: 'Meses por factura', value: (c) => c.billingIntervalMonths },
      { header: 'Fianza', value: (c) => num(c.depositAmount) },
      { header: 'Estado de la fianza', value: (c) => c.depositStatus },
      { header: 'Fianza devuelta', value: (c) => num(c.depositReturnedAmount) },
      { header: 'Preaviso (días)', value: (c) => c.cancellationNoticeDays },
      { header: 'Renovación automática', value: (c) => c.autoRenew },
      { header: 'Propietario (NIF)', value: (c) => c.owner?.taxId ?? null },
      { header: 'Retención IRPF %', value: (c) => num(c.irpfRetentionPct) },
      { header: 'Factura desde', value: (c) => c.billingStartsOn },
      { header: 'Fianza depositada en', value: (c) => c.depositRegistryBody },
      { header: 'Fecha del depósito', value: (c) => c.depositRegisteredAt },
      { header: 'Referencia del depósito', value: (c) => c.depositRegistryReference },
    ]);
    this.sheet(wb, 'Facturas', invoices, [
      { header: 'Número', value: (i) => i.invoiceNumber },
      { header: 'Tipo', value: (i) => i.invoiceType },
      {
        header: 'Clase',
        value: (i) => (i.kind === 'invoice' ? 'Factura' : 'Justificante de fianza'),
      },
      { header: 'Estado', value: (i) => i.status },
      { header: 'Fecha', value: (i) => i.issueDate },
      { header: 'Vencimiento', value: (i) => i.dueDate },
      { header: 'Periodo desde', value: (i) => i.periodStart },
      { header: 'Periodo hasta', value: (i) => i.periodEnd },
      { header: 'Id del inquilino', width: 38, value: (i) => i.customerId },
      { header: 'Cliente (nombre en la factura)', width: 28, value: (i) => i.customerNameSnapshot },
      { header: 'Cliente (email)', width: 28, value: (i) => i.customer?.email ?? null },
      { header: 'Cliente (documento)', value: (i) => i.customer?.documentNumber ?? null },
      { header: 'Base', value: (i) => num(i.subtotal) },
      { header: 'IVA', value: (i) => num(i.taxAmount) },
      { header: 'Total', value: (i) => num(i.total) },
      { header: 'Retención IRPF', value: (i) => num(i.withholdingAmount) },
      { header: 'Emisor (NIF del propietario)', value: (i) => i.owner?.taxId ?? null },
      { header: 'Emitida en', value: (i) => i.issuedBy },
      { header: 'Cobrado', value: (i) => num(i.amountPaid) },
      { header: 'Reembolsado', value: (i) => num(i.amountRefunded) },
      { header: 'Veri*Factu', value: (i) => text(i.aeatStatus) },
      { header: 'CSV de la AEAT', value: (i) => i.aeatCsv },
    ]);
    this.sheet(wb, 'Líneas de factura', items, [
      { header: 'Factura', value: (i) => i.invoice.invoiceNumber },
      { header: 'Concepto', width: 40, value: (i) => i.description },
      { header: 'Cantidad', value: (i) => num(i.quantity) },
      { header: 'Precio', value: (i) => num(i.unitPrice) },
      { header: '% IVA', value: (i) => num(i.taxRate) },
      { header: 'Tipo fiscal', value: (i) => i.taxCategory },
      { header: 'IVA', value: (i) => num(i.taxAmount) },
      { header: 'Total', value: (i) => num(i.total) },
    ]);
    this.sheet(wb, 'Cobros', payments, [
      { header: 'Factura', value: (p) => p.invoice?.invoiceNumber ?? null },
      { header: 'Fecha', value: (p) => p.paidAt ?? p.createdAt },
      { header: 'Importe', value: (p) => num(p.amount) },
      { header: 'Reembolsado', value: (p) => num(p.refundedAmount) },
      { header: 'Forma de pago', value: (p) => p.methodType },
      { header: 'Pasarela', value: (p) => p.gateway },
      { header: 'Estado', value: (p) => p.status },
    ]);
    this.sheet(wb, 'Mandatos SEPA', mandates, [
      { header: 'Id del inquilino', width: 38, value: (m) => m.customerId },
      { header: 'Inquilino (email)', width: 28, value: (m) => m.customer.email },
      { header: 'Inquilino (documento)', value: (m) => m.customer.documentNumber },
      { header: 'Referencia', width: 24, value: (m) => m.reference },
      { header: 'Cuenta (últimos 4)', value: (m) => m.ibanLast4 },
      { header: 'Firmado', value: (m) => m.signedAt },
      { header: 'Secuencia', value: (m) => m.sequenceType },
      { header: 'Estado', value: (m) => m.status },
    ]);
    this.sheet(wb, 'Contactos', leads, [
      { header: 'Estado', value: (l) => l.status },
      { header: 'Origen', value: (l) => l.source },
      { header: 'Nombre', value: (l) => l.firstName },
      { header: 'Apellidos', value: (l) => l.lastName },
      { header: 'Email', width: 28, value: (l) => l.email },
      { header: 'Teléfono', value: (l) => l.phone },
      { header: 'Mensaje', width: 40, value: (l) => l.message },
      { header: 'Alta', value: (l) => l.createdAt },
    ]);
    this.sheet(wb, 'Gastos', expenses, [
      { header: 'Fecha', value: (e) => e.expenseDate },
      { header: 'Local', width: 24, value: (e) => e.facility?.name ?? null },
      { header: 'Categoría', value: (e) => e.category },
      { header: 'Concepto', width: 36, value: (e) => e.description },
      { header: 'Proveedor', value: (e) => e.vendor },
      { header: 'Importe', value: (e) => num(e.amount) },
    ]);
    this.sheet(wb, 'Incidencias', incidents, [
      { header: 'Fecha', value: (i) => i.createdAt },
      { header: 'Título', width: 32, value: (i) => i.title },
      { header: 'Descripción', width: 40, value: (i) => i.description },
      { header: 'Estado', value: (i) => i.status },
      { header: 'Gravedad', value: (i) => i.severity },
    ]);
    this.sheet(wb, 'Propietarios', owners, [
      { header: 'Razón social', width: 28, value: (o) => o.legalName },
      { header: 'NIF', value: (o) => o.taxId },
      { header: 'Dirección', width: 32, value: (o) => o.address },
      { header: 'Ciudad', value: (o) => o.city },
      { header: 'Código postal', value: (o) => o.postalCode },
      { header: 'Email', width: 28, value: (o) => o.email },
      { header: 'Teléfono', value: (o) => o.phone },
      { header: 'Cuenta (últimos 4)', value: (o) => o.ibanLast4 },
      { header: 'Honorarios', value: (o) => o.feeType },
      { header: 'Valor de los honorarios', value: (o) => num(o.feeValue) },
      { header: 'Activo', value: (o) => o.isActive },
    ]);
    this.sheet(wb, 'Liquidaciones', statements, [
      { header: 'Propietario (NIF)', value: (s) => s.owner.taxId },
      { header: 'Desde', value: (s) => s.periodStart },
      { header: 'Hasta', value: (s) => s.periodEnd },
      { header: 'Cobrado', value: (s) => num(s.collected) },
      { header: 'Devuelto', value: (s) => num(s.refunded) },
      { header: 'Honorarios', value: (s) => num(s.feeBase) },
      { header: 'IVA de los honorarios', value: (s) => num(s.feeVat) },
      { header: 'Gastos', value: (s) => num(s.expenses) },
      { header: 'Retención IRPF', value: (s) => num(s.withholding) },
      { header: 'A liquidar', value: (s) => num(s.net) },
      { header: 'Enviada', value: (s) => s.sentAt },
    ]);

    const SENDERS: Record<string, string> = {
      contact: 'Contacto',
      staff: 'Equipo',
      assistant: 'Asistente',
    };
    this.sheet(wb, 'WhatsApp', whatsappMessages, [
      { header: 'Fecha', width: 20, value: (m) => m.createdAt },
      { header: 'Contacto', value: (m) => m.conversation.contactName },
      { header: 'Teléfono', value: (m) => m.conversation.waId },
      { header: 'Escribe', value: (m) => SENDERS[m.sender] ?? m.sender },
      { header: 'Mensaje', width: 60, value: (m) => m.body },
      { header: 'Estado', value: (m) => m.status },
    ]);

    const CHAT_ROLES: Record<string, string> = {
      visitor: 'Visitante',
      assistant: 'Asistente',
      staff: 'Equipo',
      system: 'Aviso automático',
    };
    this.sheet(wb, 'Chat de la web', webChatMessages, [
      { header: 'Fecha', width: 20, value: (m) => m.createdAt },
      // El visitante es anónimo: su identificador agrupa la conversación.
      { header: 'Conversación', value: (m) => m.conversation.visitorId },
      { header: 'Origen', value: (m) => m.conversation.utmSource },
      { header: 'Escribe', value: (m) => CHAT_ROLES[m.role] ?? m.role },
      { header: 'Mensaje', width: 60, value: (m) => m.content },
    ]);

    this.sheet(wb, 'Canales de marketing', channels, [
      { header: 'Nombre', value: (c) => c.name },
      { header: 'Tipo', value: (c) => c.type },
      { header: 'Estado', value: (c) => (c.deletedAt ? 'borrado' : c.status) },
      { header: 'Local', value: (c) => c.facility?.name ?? null },
      { header: 'Origen', value: (c) => c.utmSourceMatch },
      { header: 'Campaña (Google/Meta)', value: (c) => c.externalCampaignId },
      {
        header: 'Coste mensual estimado',
        value: (c) => (c.monthlyCost !== null ? num(c.monthlyCost) : null),
      },
      { header: 'Renueva', value: (c) => c.renewsOn },
      { header: 'Clics del enlace corto', value: (c) => c.clickCount },
      { header: 'Alta', value: (c) => c.createdAt },
    ]);

    await this.extraSheets(wb, tenantId);
    await this.seoSheets(wb, tenantId);
    // Filas por hoja (sin la cabecera).
    const counts: Record<string, number> = {};
    for (const ws of wb.worksheets) counts[ws.name] = Math.max(0, ws.rowCount - 1);

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const key = `${tenantId}/exports/${new Date().toISOString().slice(0, 10)}-${randomUUID()}.xlsx`;
    await this.files.putObject({
      bucket: 'reports',
      key,
      body: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    return { key, fileBytes: buffer.length, counts };
  }

  /**
   * Hojas del resto de la actividad: reservas, usuarios, tareas, chat,
   * comunicaciones (sin el cuerpo de los correos de acceso), accesos (sin
   * secretos), productos y ventas, cupones y promociones, lista de espera,
   * valoraciones, autorizados y contactos, cesiones, proveedores, desglose
   * fiscal de los gastos y remesas SEPA.
   */
  private async extraSheets(wb: ExcelJS.Workbook, tenantId: string): Promise<void> {
    const where = { tenantId };
    const [
      reservations,
      users,
      tasks,
      chat,
      comms,
      credentials,
      products,
      sales,
      coupons,
      promotions,
      waitlist,
      reviews,
      authorized,
      contacts,
      cessions,
      suppliers,
      expenses,
      remittances,
    ] = await Promise.all([
      this.admin.reservation.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: {
          unit: { select: { code: true, facility: { select: { name: true } } } },
          customer: { select: { email: true } },
        },
      }),
      this.admin.user.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          emailVerifiedAt: true,
          twoFactorEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          tenantRole: { select: { name: true } },
        },
      }),
      this.admin.task.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.customerMessage.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { customer: { select: { email: true } } },
      }),
      this.admin.communication.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          createdAt: true,
          channel: true,
          status: true,
          direction: true,
          recipient: true,
          subject: true,
          bodyText: true,
          source: true,
          secretsEncrypted: true,
          sentAt: true,
        },
      }),
      this.admin.accessCredential.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          method: true,
          status: true,
          label: true,
          holderName: true,
          customerId: true,
          validFrom: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
          customer: { select: { email: true } },
        },
      }),
      this.admin.product.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.productSale.findMany({
        where,
        orderBy: { soldAt: 'asc' },
        include: {
          facility: { select: { name: true } },
          customer: { select: { email: true } },
          items: { include: { product: { select: { name: true } } } },
        },
      }),
      this.admin.coupon.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.promotion.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.waitlistEntry.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.review.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { customer: { select: { email: true } } },
      }),
      this.admin.customerAuthorizedPerson.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { customer: { select: { email: true } } },
      }),
      this.admin.customerContact.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { customer: { select: { email: true } } },
      }),
      this.admin.unitCession.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { unit: { select: { code: true } } },
      }),
      this.admin.expenseSupplier.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.admin.expense.findMany({ where, orderBy: { expenseDate: 'asc' } }),
      this.admin.sepaRemittance.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          messageId: true,
          collectionDate: true,
          status: true,
          itemCount: true,
          totalAmount: true,
          createdAt: true,
          confirmedAt: true,
        },
      }),
    ]);

    this.sheet(wb, 'Reservas', reservations, [
      { header: 'Estado', value: (r) => r.status },
      { header: 'Local', width: 24, value: (r) => r.unit.facility.name },
      { header: 'Trastero', value: (r) => r.unit.code },
      { header: 'Inquilino (email)', width: 28, value: (r) => r.customer?.email ?? null },
      { header: 'Desde', value: (r) => r.validFrom },
      { header: 'Hasta', value: (r) => r.validUntil },
      { header: 'Señal', value: (r) => num(r.depositAmount) },
      { header: 'Señal pagada', value: (r) => r.depositPaid },
      { header: 'Notas', width: 32, value: (r) => r.notes },
      { header: 'Cancelada', value: (r) => r.cancelledAt },
      { header: 'Alta', value: (r) => r.createdAt },
    ]);
    this.sheet(wb, 'Usuarios', users, [
      { header: 'Nombre', width: 24, value: (u) => u.fullName },
      { header: 'Email', width: 28, value: (u) => u.email },
      { header: 'Teléfono', value: (u) => u.phone },
      { header: 'Rol', value: (u) => u.tenantRole?.name ?? u.role },
      { header: 'Activo', value: (u) => u.isActive },
      { header: 'Email verificado', value: (u) => u.emailVerifiedAt },
      { header: 'Verificación en dos pasos', value: (u) => u.twoFactorEnabled },
      { header: 'Último acceso', value: (u) => u.lastLoginAt },
      { header: 'Alta', value: (u) => u.createdAt },
    ]);
    this.sheet(wb, 'Tareas', tasks, [
      { header: 'Tipo', value: (t) => t.type },
      { header: 'Estado', value: (t) => t.status },
      { header: 'Prioridad', value: (t) => t.priority },
      { header: 'Título', width: 32, value: (t) => t.title },
      { header: 'Descripción', width: 40, value: (t) => t.description },
      { header: 'Para el', value: (t) => t.dueDate },
      { header: 'Hecha', value: (t) => t.completedAt },
      { header: 'Borrada', value: (t) => t.deletedAt },
      { header: 'Alta', value: (t) => t.createdAt },
    ]);
    const SENDER: Record<string, string> = { customer: 'Inquilino', staff: 'Equipo' };
    this.sheet(wb, 'Chat con inquilinos', chat, [
      { header: 'Fecha', width: 20, value: (m) => m.createdAt },
      { header: 'Inquilino (email)', width: 28, value: (m) => m.customer.email },
      { header: 'Escribe', value: (m) => SENDER[m.senderType] ?? m.senderType },
      { header: 'Canal', value: (m) => m.channel },
      { header: 'Nota interna', value: (m) => m.isInternal },
      { header: 'Mensaje', width: 60, value: (m) => m.body },
      { header: 'Adjunto', value: (m) => m.attachmentName },
    ]);
    // Los correos con un PIN o un enlace de acceso no llevan el cuerpo.
    const ACCESS_SOURCE = /access|portal|password|credential|login|magic/i;
    this.sheet(wb, 'Comunicaciones', comms, [
      { header: 'Fecha', width: 20, value: (c) => c.createdAt },
      { header: 'Canal', value: (c) => c.channel },
      { header: 'Dirección', value: (c) => c.direction },
      { header: 'Estado', value: (c) => c.status },
      { header: 'Destinatario', width: 28, value: (c) => c.recipient },
      { header: 'Asunto', width: 36, value: (c) => c.subject },
      { header: 'Origen', value: (c) => c.source },
      {
        header: 'Texto',
        width: 60,
        value: (c) =>
          c.secretsEncrypted || ACCESS_SOURCE.test(c.source ?? '')
            ? '(no se exporta: lleva datos de acceso)'
            : c.bodyText,
      },
      { header: 'Enviado', value: (c) => c.sentAt },
    ]);
    this.sheet(wb, 'Accesos', credentials, [
      { header: 'Tipo', value: (c) => c.method },
      { header: 'Estado', value: (c) => c.status },
      { header: 'Etiqueta', value: (c) => c.label },
      { header: 'Titular', value: (c) => c.holderName },
      { header: 'Inquilino (email)', width: 28, value: (c) => c.customer?.email ?? null },
      { header: 'Desde', value: (c) => c.validFrom },
      { header: 'Caduca', value: (c) => c.expiresAt },
      { header: 'Último uso', value: (c) => c.lastUsedAt },
      { header: 'Revocado', value: (c) => c.revokedAt },
      { header: 'Alta', value: (c) => c.createdAt },
    ]);
    this.sheet(wb, 'Productos', products, [
      { header: 'Referencia', value: (p) => p.sku },
      { header: 'Nombre', width: 28, value: (p) => p.name },
      { header: 'Tipo', value: (p) => p.type },
      { header: 'Precio', value: (p) => num(p.price) },
      { header: '% IVA', value: (p) => num(p.taxRate) },
      { header: 'Activo', value: (p) => p.isActive && !p.deletedAt },
    ]);
    this.sheet(wb, 'Ventas', sales, [
      { header: 'Fecha', value: (s) => s.soldAt },
      { header: 'Local', width: 24, value: (s) => s.facility.name },
      { header: 'Inquilino (email)', width: 28, value: (s) => s.customer?.email ?? null },
      {
        header: 'Productos',
        width: 40,
        value: (s) => s.items.map((i) => `${i.quantity} × ${i.product.name}`).join(', '),
      },
      { header: 'Total', value: (s) => num(s.total) },
      { header: 'Estado', value: (s) => s.status },
    ]);
    this.sheet(wb, 'Cupones', coupons, [
      { header: 'Código', value: (c) => c.code },
      { header: 'Nombre', width: 24, value: (c) => c.name },
      { header: 'Descuento', value: (c) => c.discountType },
      { header: 'Valor', value: (c) => num(c.discountValue) },
      { header: 'Usos', value: (c) => c.usedCount },
      { header: 'Máximo de usos', value: (c) => c.maxUses },
      { header: 'Desde', value: (c) => c.validFrom },
      { header: 'Hasta', value: (c) => c.validUntil },
      { header: 'Activo', value: (c) => c.isActive },
    ]);
    this.sheet(wb, 'Promociones', promotions, [
      { header: 'Código', value: (p) => p.code },
      { header: 'Nombre', width: 24, value: (p) => p.name },
      { header: 'Descuento', value: (p) => p.discountType },
      { header: 'Valor', value: (p) => num(p.discountValue) },
      { header: 'Usos', value: (p) => p.usedCount },
      { header: 'Desde', value: (p) => p.validFrom },
      { header: 'Hasta', value: (p) => p.validUntil },
      { header: 'Activa', value: (p) => p.isActive },
    ]);
    this.sheet(wb, 'Lista de espera', waitlist, [
      { header: 'Estado', value: (w) => w.status },
      { header: 'Nombre', width: 24, value: (w) => w.contactName },
      { header: 'Email', width: 28, value: (w) => w.contactEmail },
      { header: 'Teléfono', value: (w) => w.contactPhone },
      { header: 'En cola desde', value: (w) => w.queueDate },
      { header: 'Avisado', value: (w) => w.notifiedAt },
      { header: 'Notas', width: 32, value: (w) => w.notes },
    ]);
    this.sheet(wb, 'Valoraciones', reviews, [
      { header: 'Inquilino (email)', width: 28, value: (r) => r.customer.email },
      { header: 'Estado', value: (r) => r.status },
      { header: 'Recomendación (0-10)', value: (r) => r.npsScore },
      { header: 'Estrellas', value: (r) => r.rating },
      { header: 'Comentario', width: 48, value: (r) => r.comment },
      { header: 'Publicada en la web', value: (r) => r.publishedOnWeb },
      { header: 'Pedida', value: (r) => r.requestedAt },
      { header: 'Respondida', value: (r) => r.submittedAt },
    ]);
    this.sheet(wb, 'Autorizados', authorized, [
      { header: 'Inquilino (email)', width: 28, value: (a) => a.customer.email },
      { header: 'Nombre', width: 24, value: (a) => a.fullName },
      { header: 'Documento', value: (a) => a.documentNumber },
      { header: 'Teléfono', value: (a) => a.phone },
      { header: 'Relación', value: (a) => a.relationship },
      { header: 'Puede entrar', value: (a) => a.canAccess },
      { header: 'Puede recoger', value: (a) => a.canPickup },
      { header: 'Puede gestionar', value: (a) => a.canManage },
    ]);
    this.sheet(wb, 'Contactos de empresas', contacts, [
      { header: 'Inquilino (email)', width: 28, value: (c) => c.customer.email },
      { header: 'Nombre', width: 24, value: (c) => c.name },
      { header: 'Cargo', value: (c) => c.role },
      { header: 'Email', width: 28, value: (c) => c.email },
      { header: 'Teléfono', value: (c) => c.phone },
    ]);
    this.sheet(wb, 'Cesiones', cessions, [
      { header: 'Trastero', value: (c) => c.unit.code },
      { header: 'A quién', width: 24, value: (c) => c.holderName },
      { header: 'Teléfono', value: (c) => c.holderPhone },
      { header: 'Desde', value: (c) => c.startsOn },
      { header: 'Hasta', value: (c) => c.endsOn },
      { header: 'Terminada', value: (c) => c.endedAt },
      { header: 'Notas', width: 32, value: (c) => c.notes },
    ]);
    this.sheet(wb, 'Proveedores', suppliers, [
      { header: 'Nombre', width: 28, value: (s) => s.name },
      { header: 'NIF', value: (s) => s.taxId },
      { header: 'Email', width: 28, value: (s) => s.email },
      { header: 'Teléfono', value: (s) => s.phone },
      { header: 'Categoría', value: (s) => s.defaultCategory },
      { header: 'Activo', value: (s) => s.isActive },
    ]);
    this.sheet(wb, 'Gastos (desglose fiscal)', expenses, [
      { header: 'Fecha', value: (e) => e.expenseDate },
      { header: 'Proveedor', value: (e) => e.vendor },
      { header: 'NIF del proveedor', value: (e) => e.vendorTaxId },
      { header: 'Nº de factura', value: (e) => e.invoiceNumber },
      { header: 'Base', value: (e) => num(e.baseAmount) },
      { header: '% IVA', value: (e) => num(e.vatRate) },
      { header: 'IVA', value: (e) => num(e.vatAmount) },
      { header: 'IVA deducible', value: (e) => e.vatDeductible },
      { header: '% retención', value: (e) => num(e.withholdingRate) },
      { header: 'Retención', value: (e) => num(e.withholdingAmount) },
      { header: 'Total', value: (e) => num(e.totalAmount ?? e.amount) },
      { header: 'Pago', value: (e) => e.paymentStatus },
      { header: 'Pagado', value: (e) => e.paidAt },
    ]);
    this.sheet(wb, 'Remesas SEPA', remittances, [
      { header: 'Nombre', width: 24, value: (r) => r.name },
      { header: 'Identificador', width: 28, value: (r) => r.messageId },
      { header: 'Fecha de cobro', value: (r) => r.collectionDate },
      { header: 'Estado', value: (r) => r.status },
      { header: 'Adeudos', value: (r) => r.itemCount },
      { header: 'Importe', value: (r) => r.totalAmount / 100 },
      { header: 'Confirmada', value: (r) => r.confirmedAt },
      { header: 'Alta', value: (r) => r.createdAt },
    ]);
  }

  /**
   * SEO Avanzado: proyectos con sus dominios, palabras seguidas, oportunidades,
   * tareas y actuaciones. Lo descargado de Google (millones de filas) no va: se
   * vuelve a pedir; las claves de SISTRIX tampoco.
   */
  private async seoSheets(wb: ExcelJS.Workbook, tenantId: string): Promise<void> {
    const where = { tenantId };
    const [projects, competitors, imports, domains, keywords, opportunities, tasks, changes] =
      await Promise.all([
        this.admin.seoProject.findMany({ where, orderBy: { createdAt: 'asc' } }),
        this.admin.seoCompetitor.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          include: { project: { select: { name: true } } },
        }),
        this.admin.seoSistrixImport.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          include: { project: { select: { name: true } } },
        }),
        this.admin.seoProjectDomain.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          include: { project: { select: { name: true, strategy: true, country: true } } },
        }),
        this.admin.seoProjectKeyword.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          include: { keyword: { select: { keyword: true } }, project: { select: { name: true } } },
        }),
        this.admin.seoOpportunity.findMany({
          where,
          orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
          include: { project: { select: { name: true } } },
        }),
        this.admin.seoTask.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          include: { project: { select: { name: true } } },
        }),
        this.admin.seoSiteChange.findMany({
          where,
          orderBy: { changeDate: 'asc' },
          include: { project: { select: { name: true } } },
        }),
      ]);
    this.sheet(wb, 'SEO - proyecto', projects, [
      { header: 'Nombre', width: 24, value: (p) => p.name },
      { header: 'Estrategia', value: (p) => p.strategy },
      { header: 'País', value: (p) => p.country },
      { header: 'Ubicación objetivo', width: 28, value: (p) => p.targetLocation },
      { header: 'Términos de marca', width: 32, value: (p) => p.brandTerms.join(', ') },
      { header: 'Zonas (municipios y barrios)', width: 36, value: (p) => p.localAreas.join(', ') },
      { header: 'Estado', value: (p) => p.status },
      { header: 'Alta', value: (p) => p.createdAt },
    ]);
    this.sheet(wb, 'SEO - competidores', competitors, [
      { header: 'Proyecto', width: 24, value: (c) => c.project.name },
      { header: 'Dominio', width: 28, value: (c) => c.domain },
      { header: 'Directorio analizado', value: (c) => c.pathPrefix },
      { header: 'Nombre', value: (c) => c.name },
      { header: 'Notas', width: 32, value: (c) => c.notes },
      { header: 'Se sigue', value: (c) => c.isActive },
      { header: 'Origen', value: (c) => c.source },
    ]);
    this.sheet(wb, 'SEO - CSV de SISTRIX importados', imports, [
      { header: 'Proyecto', width: 24, value: (i) => i.project.name },
      { header: 'Tipo', value: (i) => i.kind },
      { header: 'Fichero', width: 28, value: (i) => i.filename },
      { header: 'Dominio', value: (i) => i.domain },
      { header: 'Búsqueda', value: (i) => i.keyword },
      { header: 'Filas', value: (i) => i.rows },
      { header: 'Fecha', value: (i) => i.createdAt },
    ]);
    this.sheet(wb, 'SEO - proyectos y dominios', domains, [
      { header: 'Proyecto', width: 24, value: (d) => d.project.name },
      { header: 'Dominio', width: 28, value: (d) => d.domain },
      { header: 'Propiedad de Search Console', width: 32, value: (d) => d.gscProperty },
      { header: 'Función', value: (d) => d.role },
      { header: 'Estado', value: (d) => d.connectionStatus },
      { header: 'Descargado hasta', value: (d) => d.syncedUntil },
      { header: 'Alta', value: (d) => d.createdAt },
    ]);
    this.sheet(wb, 'SEO - palabras', keywords, [
      { header: 'Proyecto', width: 24, value: (k) => k.project.name },
      { header: 'Palabra', width: 32, value: (k) => k.keyword.keyword },
      { header: 'Grupo', value: (k) => k.groupName },
      { header: 'Intención', value: (k) => k.intent },
      { header: 'URL objetivo', width: 36, value: (k) => k.targetUrl },
      { header: 'Prioridad', value: (k) => k.priority },
      { header: 'Activa', value: (k) => k.isActive },
      { header: 'Origen', value: (k) => k.source },
    ]);
    this.sheet(wb, 'SEO - oportunidades', opportunities, [
      { header: 'Proyecto', width: 24, value: (o) => o.project.name },
      { header: 'Tipo', value: (o) => o.type },
      { header: 'Búsqueda', width: 32, value: (o) => o.query },
      { header: 'Página', width: 36, value: (o) => o.page },
      { header: 'Puntuación', value: (o) => o.score },
      { header: 'Estado', value: (o) => o.status },
      { header: 'Notas', width: 32, value: (o) => o.notes },
      { header: 'Detectada', value: (o) => o.detectedAt },
    ]);
    this.sheet(wb, 'SEO - tareas', tasks, [
      { header: 'Proyecto', width: 24, value: (t) => t.project.name },
      { header: 'Título', width: 36, value: (t) => t.title },
      { header: 'Tipo', value: (t) => t.type },
      { header: 'Estado', value: (t) => t.status },
      { header: 'Prioridad', value: (t) => t.priority },
      { header: 'Fecha límite', value: (t) => t.dueDate },
      { header: 'URL', width: 36, value: (t) => t.url },
      { header: 'Completada', value: (t) => t.completedAt },
    ]);
    this.sheet(wb, 'SEO - actuaciones', changes, [
      { header: 'Proyecto', width: 24, value: (c) => c.project.name },
      { header: 'Fecha', value: (c) => c.changeDate },
      { header: 'Tipo', value: (c) => c.type },
      { header: 'Título', width: 36, value: (c) => c.title },
      { header: 'Descripción', width: 40, value: (c) => c.description },
      { header: 'URLs', width: 40, value: (c) => c.urls.join(', ') },
      { header: 'Palabras', width: 28, value: (c) => c.keywords.join(', ') },
      { header: 'Notas', width: 32, value: (c) => c.notes },
    ]);
  }

  private sheet<T>(wb: ExcelJS.Workbook, name: string, rows: T[], columns: Column<T>[]): void {
    const ws = wb.addWorksheet(name);
    // El id de cada fila, para cruzar las hojas entre sí (y con una importación).
    const first = rows[0] as { id?: unknown } | undefined;
    if (first && typeof first.id === 'string') {
      columns = [{ header: 'Id', width: 38, value: (r) => (r as { id: string }).id }, ...columns];
    }
    ws.columns = columns.map((c) => ({ header: c.header, width: c.width ?? 16 }));
    ws.getRow(1).font = { bold: true };
    for (const row of rows) ws.addRow(columns.map((c) => c.value(row)));
  }
}
