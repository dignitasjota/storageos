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

  async export(tenantId: string): Promise<TenantDataExportDto> {
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
    ] = await Promise.all([
      this.admin.facility.findMany({ where, orderBy: { createdAt: 'asc' } }),
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
        },
      }),
      this.admin.invoice.findMany({
        where,
        orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }],
        include: { customer: { select: { email: true, documentNumber: true } } },
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
      { header: 'Activo', value: (f) => f.isActive && !f.deletedAt },
    ]);
    this.sheet(wb, 'Tipos de trastero', unitTypes, [
      { header: 'Nombre', width: 24, value: (u) => u.name },
      { header: 'Precio mensual', value: (u) => num(u.defaultPriceMonthly) },
      { header: 'Fianza', value: (u) => num(u.defaultDepositAmount) },
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
    ]);
    this.sheet(wb, 'Facturas', invoices, [
      { header: 'Número', value: (i) => i.invoiceNumber },
      { header: 'Tipo', value: (i) => i.invoiceType },
      { header: 'Estado', value: (i) => i.status },
      { header: 'Fecha', value: (i) => i.issueDate },
      { header: 'Vencimiento', value: (i) => i.dueDate },
      { header: 'Periodo desde', value: (i) => i.periodStart },
      { header: 'Periodo hasta', value: (i) => i.periodEnd },
      { header: 'Cliente (email)', width: 28, value: (i) => i.customer?.email ?? null },
      { header: 'Cliente (documento)', value: (i) => i.customer?.documentNumber ?? null },
      { header: 'Base', value: (i) => num(i.subtotal) },
      { header: 'IVA', value: (i) => num(i.taxAmount) },
      { header: 'Total', value: (i) => num(i.total) },
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

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const key = `${tenantId}/exports/${new Date().toISOString().slice(0, 10)}-${randomUUID()}.xlsx`;
    await this.files.putObject({
      bucket: 'reports',
      key,
      body: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = await this.files.getPresignedGetUrl('reports', key, LINK_TTL_SECONDS);
    return {
      url,
      expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString(),
      fileBytes: buffer.length,
      counts: {
        facilities: facilities.length,
        units: units.length,
        customers: customers.length,
        contracts: contracts.length,
        invoices: invoices.length,
        payments: payments.length,
      },
    };
  }

  private sheet<T>(wb: ExcelJS.Workbook, name: string, rows: T[], columns: Column<T>[]): void {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map((c) => ({ header: c.header, width: c.width ?? 16 }));
    ws.getRow(1).font = { bold: true };
    for (const row of rows) ws.addRow(columns.map((c) => c.value(row)));
  }
}
