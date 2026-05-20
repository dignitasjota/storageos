import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import QRCode from 'qrcode';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { AEAT_CLIENT, type AeatClient, type SendInvoiceResult } from './aeat-client';

import type { Env } from '../../config/env.schema';
import type { AeatStatus, Invoice, Prisma } from '@storageos/database';

/**
 * Verifactu (RD 1007/2023). En Fase 4 implementamos:
 *
 * - **Hash encadenado** SHA-256 de cada factura. El `previous_hash` apunta a
 *   la inmediatamente anterior emitida de la misma serie del tenant. La
 *   primera de cada serie tiene `previous_hash = null`. Hash inmutable
 *   tras emitir.
 * - **QR AEAT**: payload con campos clave (NIF emisor, número, importe,
 *   fecha) en formato URL de la sede AEAT. Renderizado a `qr_code_url`
 *   como data:image/png;base64 para embebido en el PDF. En Fase 8 se
 *   sustituye por la URL con el CSV definitivo devuelto por AEAT.
 * - **Envío AEAT**: gobernado por `AEAT_MODE`:
 *   - `stub` (Fase 4): no envia, devuelve `accepted` simulado.
 *   - `sandbox` / `production` (Fase 8): envia el XML firmado al endpoint
 *     real de la AEAT con el certificado del tenant.
 *
 * Algoritmo del hash (simplificado, conforme al spec AEAT):
 *
 *   sha256(
 *     `${tenantTaxId}|${invoiceNumber}|${issueDate}|${total}|${previousHash ?? ''}`
 *   )
 */
@Injectable()
export class VerifactuService {
  private readonly logger = new Logger(VerifactuService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    @Inject(AEAT_CLIENT) private readonly aeat: AeatClient,
    _config: ConfigService<Env, true>,
  ) {}

  /**
   * Calcula el hash de una factura encadenándolo con la última emitida de
   * la misma serie del tenant. Devuelve `{ hash, previousHash }`. Llamado
   * dentro de la transacción de `InvoicesService.issue`.
   */
  async computeChainedHash(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      tenantTaxId: string;
      seriesId: string;
      invoiceNumber: string;
      issueDate: Date;
      total: number;
    },
  ): Promise<{ hash: string; previousHash: string | null }> {
    const previous = await tx.invoice.findFirst({
      where: {
        tenantId: args.tenantId,
        seriesId: args.seriesId,
        status: { in: ['issued', 'paid', 'overdue', 'refunded', 'partially_refunded'] },
        hash: { not: null },
      },
      orderBy: { sequenceNumber: 'desc' },
      select: { hash: true },
    });
    const previousHash = previous?.hash ?? null;
    const payload = [
      args.tenantTaxId,
      args.invoiceNumber,
      args.issueDate.toISOString().slice(0, 10),
      args.total.toFixed(2),
      previousHash ?? '',
    ].join('|');
    const hash = createHash('sha256').update(payload).digest('hex');
    return { hash, previousHash };
  }

  /**
   * Construye el QR AEAT. En Fase 4 usamos el endpoint generico de
   * cotejo de AEAT con los campos clave. En Fase 8, una vez recibido el
   * CSV, sustituye este QR por el oficial.
   */
  async buildQrDataUrl(args: {
    tenantTaxId: string;
    invoiceNumber: string;
    issueDate: Date;
    total: number;
  }): Promise<string> {
    const url = new URL('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR');
    url.searchParams.set('nif', args.tenantTaxId || 'PENDIENTE');
    url.searchParams.set('numserie', args.invoiceNumber);
    url.searchParams.set('fecha', args.issueDate.toISOString().slice(0, 10));
    url.searchParams.set('importe', args.total.toFixed(2));
    const qrPng = await QRCode.toDataURL(url.toString(), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
    });
    return qrPng;
  }

  /**
   * Envia una factura a AEAT y actualiza `aeat_*` en BD. Llamado desde el
   * worker BullMQ `verifactu/send-invoice`. Devuelve el `SendInvoiceResult`
   * para que el worker pueda decidir si reintentar (lanzar excepcion solo
   * cuando `status === 'error'`). Para `accepted` / `accepted_with_warnings`
   * / `rejected` el worker NO reintenta (rejected es decision AEAT, no
   * un fallo tecnico). Si la factura no es enviable (faltan campos), se
   * devuelve `null`.
   */
  async sendToAeat(invoiceId: string, tenantId: string): Promise<SendInvoiceResult | null> {
    const invoice = await this.admin.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNumber: true,
        issueDate: true,
        total: true,
        previousHash: true,
        hash: true,
      },
    });
    if (!invoice || !invoice.invoiceNumber || !invoice.issueDate || !invoice.hash) {
      this.logger.warn(`[Verifactu] invoice ${invoiceId} no enviable (campos faltantes)`);
      return null;
    }
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { taxId: true },
    });
    const result = await this.aeat.sendInvoice({
      tenantId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      total: Number(invoice.total),
      previousHash: invoice.previousHash,
      hash: invoice.hash,
      emitterTaxId: tenant?.taxId ?? '',
    });
    const status: AeatStatus =
      result.status === 'accepted'
        ? 'accepted'
        : result.status === 'accepted_with_warnings'
          ? 'accepted_with_warnings'
          : result.status === 'rejected'
            ? 'rejected'
            : 'error';
    await this.admin.invoice.update({
      where: { id: invoiceId },
      data: {
        aeatSentAt: new Date(),
        aeatStatus: status,
        aeatCsv: result.csv ?? null,
        aeatResponse: {
          mode: this.aeat.mode,
          ...(result.message ? { message: result.message } : {}),
          ...(result.raw ?? {}),
        } as Prisma.InputJsonValue,
      },
    });
    this.logger.debug(
      `[Verifactu ${this.aeat.mode}] invoice ${invoiceId} → ${status}${result.csv ? ` CSV=${result.csv}` : ''}`,
    );
    return result;
  }

  /** Comprueba el hash de una factura ya emitida (auditoría). */
  verifyHash(args: {
    tenantTaxId: string;
    invoice: Pick<Invoice, 'invoiceNumber' | 'issueDate' | 'total' | 'previousHash' | 'hash'>;
  }): boolean {
    if (!args.invoice.hash || !args.invoice.issueDate) return false;
    const total = Number(args.invoice.total);
    const payload = [
      args.tenantTaxId,
      args.invoice.invoiceNumber,
      args.invoice.issueDate.toISOString().slice(0, 10),
      total.toFixed(2),
      args.invoice.previousHash ?? '',
    ].join('|');
    const expected = createHash('sha256').update(payload).digest('hex');
    return expected === args.invoice.hash;
  }
}
