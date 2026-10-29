import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import JSZip from 'jszip';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type { PortalAnnualInvoicesDto } from '@storageos/shared';

const LINK_TTL_SECONDS = 60 * 60;

const STATUS_LABELS: Record<string, string> = {
  issued: 'Emitida',
  overdue: 'Vencida',
  paid: 'Pagada',
  refunded: 'Reembolsada',
  partially_refunded: 'Reembolsada en parte',
  rectified: 'Rectificada',
};

/** Importe con coma decimal (Excel en español lo lee como número). */
function num(n: unknown): string {
  return Number(n).toFixed(2).replace('.', ',');
}

function csvCell(v: string): string {
  return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Las facturas de un año del inquilino en un ZIP: un resumen en CSV (para su
 * asesoría) y el PDF de cada una. Pensado para empresas y autónomos.
 */
@Injectable()
export class PortalInvoiceExportService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
  ) {}

  async annual(
    tenantId: string,
    customerId: string,
    year: number,
  ): Promise<PortalAnnualInvoicesDto> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException({ code: 'invalid_year', message: 'Año no válido' });
    }
    const rows = await this.admin.invoice.findMany({
      where: {
        tenantId,
        customerId,
        deletedAt: null,
        status: { in: Object.keys(STATUS_LABELS) as never },
        issueDate: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
      orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
      include: { items: { select: { description: true }, orderBy: { position: 'asc' }, take: 1 } },
    });
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'no_invoices',
        message: 'No tienes facturas de ese año',
      });
    }
    const header = [
      'Número',
      'Fecha',
      'Concepto',
      'Base imponible',
      'IVA',
      'Retención',
      'Total',
      'Pagado',
      'Estado',
    ];
    const lines = rows.map((r) =>
      [
        r.invoiceNumber ?? '',
        r.issueDate ? r.issueDate.toISOString().slice(0, 10).split('-').reverse().join('/') : '',
        r.kind === 'deposit_receipt' ? 'Fianza' : (r.items[0]?.description ?? ''),
        num(r.subtotal),
        num(r.taxAmount),
        num(r.withholdingAmount),
        num(r.total),
        num(Number(r.amountPaid) - Number(r.withholdingAmount)),
        STATUS_LABELS[r.status] ?? r.status,
      ]
        .map((v) => csvCell(String(v)))
        .join(';'),
    );
    const zip = new JSZip();
    zip.file(
      `facturas-${year}.csv`,
      `${String.fromCharCode(0xfeff)}${[header.join(';'), ...lines].join('\r\n')}\r\n`,
    );
    let withPdf = 0;
    for (const r of rows) {
      if (!r.pdfUrl) continue;
      const key = this.files.keyFromPublicUrl('invoices', r.pdfUrl);
      if (!key) continue;
      try {
        const pdf = await this.files.getObject({ bucket: 'invoices', key });
        const name = (r.invoiceNumber ?? r.id).replace(/[^\w.-]+/g, '_');
        zip.file(`pdf/${name}.pdf`, pdf);
        withPdf += 1;
      } catch {
        /* sin PDF guardado: queda en el resumen */
      }
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const key = `${tenantId}/exports/portal-${customerId}-${year}-${randomUUID()}.zip`;
    await this.files.putObject({
      bucket: 'reports',
      key,
      body: buffer,
      contentType: 'application/zip',
    });
    return {
      url: await this.files.getPresignedGetUrl(
        'reports',
        key,
        LINK_TTL_SECONDS,
        `facturas-${year}.zip`,
      ),
      year,
      invoices: rows.length,
      withPdf,
    };
  }
}
