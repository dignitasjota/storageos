import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import {
  invoiceDownloadKey,
  invoiceIdFromDownloadToken,
  verifyInvoiceDownloadToken,
} from '../../common/invoice-download-token';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import { InvoicePdfService } from './invoice-pdf.service';

import type { Env } from '../../config/env.schema';
import type { Response } from 'express';

/**
 * Descarga del PDF de una factura desde el enlace del correo, sin iniciar
 * sesión. El enlace va firmado (no se puede fabricar para otra factura) y
 * lleva a una dirección del almacén que caduca en 5 minutos.
 */
@Public()
@Controller('public/invoices')
export class InvoiceDownloadController {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly pdf: InvoicePdfService,
    private readonly files: FilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get(':token/pdf')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async download(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const invoiceId = invoiceIdFromDownloadToken(token);
    const invoice = invoiceId
      ? await this.admin.invoice.findFirst({
          where: { id: invoiceId, deletedAt: null },
          select: { id: true, tenantId: true, status: true, pdfUrl: true },
        })
      : null;
    const key = invoiceDownloadKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    if (
      !invoice ||
      !verifyInvoiceDownloadToken(key, token, invoice.tenantId) ||
      invoice.status === 'draft' ||
      invoice.status === 'cancelled'
    ) {
      throw new NotFoundException({
        code: 'invoice_not_found',
        message: 'Esta factura no existe o ya no está disponible',
      });
    }
    // Sin PDF todavía (recién emitida): se genera ahora.
    if (!invoice.pdfUrl) await this.pdf.generate(invoice.tenantId, invoice.id);
    const fresh = await this.admin.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { pdfUrl: true },
    });
    const url = fresh.pdfUrl
      ? await this.files.presignFromPublicUrl('invoices', fresh.pdfUrl, 300)
      : null;
    if (!url) {
      throw new NotFoundException({
        code: 'pdf_not_available',
        message: 'La factura aún no tiene PDF',
      });
    }
    res.redirect(302, url);
  }
}
