import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import QRCode from 'qrcode';

import { PrismaAdminService } from '../database/prisma-admin.service';

import {
  AEAT_CLIENT,
  type AeatClient,
  type GetStatusResult,
  type SendInvoiceResult,
} from './aeat-client';
import {
  formatSpanishDate,
  formatTimestampWithMadridTimezone,
} from './aeat-client/verifactu-xml-builder';
import { computeAltaHash } from './verifactu-hash';

import type { Env } from '../../config/env.schema';
import type { AeatStatus, Invoice, Prisma } from '@storageos/database';

/**
 * Veri*Factu (RD 1007/2023, Orden HAC/1177/2024).
 *
 * - **Huella oficial** (`verifactu-hash.ts`): SHA-256 de los campos del
 *   registro de alta + la huella del registro ANTERIOR DEL EMISOR (cadena por
 *   tenant, no por serie) + la FechaHoraHusoGenRegistro, que se fija al emitir
 *   y se guarda para que el XML lleve exactamente la misma.
 * - **QR** con la URL de cotejo de la AEAT (pruebas o producción según
 *   `AEAT_MODE`) y la fecha en DD-MM-AAAA.
 * - **Envío** (cola `verifactu`, de uno en uno y en el orden de la cadena):
 *   no se reenvía lo ya aceptado; si un intento anterior pudo llegar, se
 *   consulta antes; un «duplicado» de la AEAT se resuelve consultando; y un
 *   registro espera a que el anterior esté resuelto.
 */
@Injectable()
export class VerifactuService {
  private readonly logger = new Logger(VerifactuService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    @Inject(AEAT_CLIENT) private readonly aeat: AeatClient,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Envío real a la AEAT (pruebas o producción): exige datos fiscales completos. */
  get realMode(): boolean {
    return this.config.get('AEAT_MODE', { infer: true }) !== 'stub';
  }

  /**
   * Huella encadenada con el último registro del emisor. Llamado dentro de la
   * transacción de `InvoicesService.issue`: un bloqueo por tenant serializa la
   * cadena (dos facturas de series distintas emitidas a la vez no comparten
   * registro anterior).
   */
  async computeChainedHash(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      tenantTaxId: string;
      invoiceNumber: string;
      issueDate: Date;
      invoiceType: string;
      taxAmount: number;
      total: number;
    },
  ): Promise<{
    hash: string;
    previousHash: string | null;
    previousInvoiceId: string | null;
    chainSeq: number;
    recordTimestamp: string;
  }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verifactu-chain:${args.tenantId}`}))`;
    const previous = await tx.invoice.findFirst({
      where: { tenantId: args.tenantId, chainSeq: { not: null } },
      orderBy: { chainSeq: 'desc' },
      select: { id: true, hash: true, chainSeq: true },
    });
    const recordTimestamp = formatTimestampWithMadridTimezone(new Date());
    const previousHash = previous?.hash ?? null;
    const hash = computeAltaHash({
      emitterTaxId: args.tenantTaxId,
      invoiceNumber: args.invoiceNumber,
      issueDate: formatSpanishDate(args.issueDate),
      invoiceType: args.invoiceType,
      cuotaTotal: args.taxAmount,
      importeTotal: args.total,
      previousHash,
      recordTimestamp,
    });
    return {
      hash,
      previousHash,
      previousInvoiceId: previous?.id ?? null,
      chainSeq: (previous?.chainSeq ?? 0) + 1,
      recordTimestamp,
    };
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
    // URL de cotejo de la AEAT: pruebas o producción según el modo.
    const base =
      this.config.get('AEAT_MODE', { infer: true }) === 'production'
        ? 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR'
        : 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR';
    const url = new URL(base);
    url.searchParams.set('nif', args.tenantTaxId || 'PENDIENTE');
    url.searchParams.set('numserie', args.invoiceNumber);
    url.searchParams.set('fecha', formatSpanishDate(args.issueDate));
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
        aeatStatus: true,
        aeatSentAt: true,
        aeatCsv: true,
        previousInvoice: { select: { id: true, aeatStatus: true } },
      },
    });
    if (!invoice || !invoice.invoiceNumber || !invoice.issueDate || !invoice.hash) {
      this.logger.warn(`[Verifactu] invoice ${invoiceId} no enviable (campos faltantes)`);
      return null;
    }
    // Ya registrada: no se vuelve a enviar (un segundo alta sería un duplicado).
    if (invoice.aeatStatus === 'accepted' || invoice.aeatStatus === 'accepted_with_warnings') {
      return { status: invoice.aeatStatus, csv: invoice.aeatCsv, message: 'already_accepted' };
    }
    // En orden: el registro anterior del emisor tiene que estar resuelto
    // (aceptado o rechazado) antes de enviar este. Si no, se reintenta luego.
    const prev = invoice.previousInvoice;
    if (
      prev &&
      (prev.aeatStatus === null || prev.aeatStatus === 'pending' || prev.aeatStatus === 'error')
    ) {
      return { status: 'error', message: 'previous_record_pending' };
    }
    // Un intento anterior pudo llegar a la AEAT aunque no tengamos respuesta
    // (tiempo agotado): se consulta antes de volver a enviarla.
    if (this.realMode && invoice.aeatSentAt) {
      const known = await this.aeat.getStatus({ invoiceId });
      if (known.status === 'accepted' || known.status === 'accepted_with_warnings') {
        await this.saveStatus(invoiceId, known, 'status_before_resend');
        return { status: known.status, csv: known.csv ?? null, message: 'already_registered' };
      }
    }
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { taxId: true },
    });
    let result = await this.aeat.sendInvoice({
      tenantId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      total: Number(invoice.total),
      previousHash: invoice.previousHash,
      hash: invoice.hash,
      emitterTaxId: tenant?.taxId ?? '',
    });
    // «Registro duplicado» (código 3000): ya estaba en la AEAT → su estado real.
    if (result.status === 'rejected' && /\b3000\b/.test(result.message ?? '')) {
      const known = await this.aeat.getStatus({ invoiceId });
      if (known.status === 'accepted' || known.status === 'accepted_with_warnings') {
        result = {
          status: known.status,
          csv: known.csv ?? null,
          message: 'duplicate_already_registered',
        };
      }
    }
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

  /**
   * Consulta a AEAT el estado actual de una factura y actualiza `aeat_*`
   * en BD si el resultado cambia. Usado por el cron de polling para
   * recuperar pendientes huerfanos y por el endpoint manual del badge UI.
   *
   * Devuelve el `GetStatusResult` para que el caller pueda mostrarlo o
   * loguearlo. Si la respuesta es `pending` (`NoRegistrado` en AEAT), NO
   * actualizamos la BD: la factura sigue marcada como `pending` con su
   * `aeatSentAt` original para que el cron pueda re-evaluar mas tarde.
   */
  async refreshStatus(invoiceId: string, tenantId: string): Promise<GetStatusResult> {
    const invoice = await this.admin.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, tenantId: true, issuedBy: true },
    });
    if (!invoice || invoice.tenantId !== tenantId) {
      return { status: 'error', message: 'invoice_not_found' };
    }
    // Emitida por Holded: Holded la registra en la AEAT, no la app.
    if (invoice.issuedBy === 'holded') {
      return { status: 'error', message: 'issued_by_holded' };
    }

    const result = await this.aeat.getStatus({ invoiceId });

    // En `pending` no tocamos la BD: la factura sigue siendo huerfana y el
    // cron volvera a consultarla en la siguiente vuelta.
    if (result.status === 'pending') {
      this.logger.debug(
        `[Verifactu ${this.aeat.mode}] refreshStatus(${invoiceId}) -> pending, no se actualiza BD`,
      );
      return result;
    }

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
        aeatStatus: status,
        ...(result.csv ? { aeatCsv: result.csv } : {}),
        aeatResponse: {
          mode: this.aeat.mode,
          source: 'refresh_status',
          ...(result.message ? { message: result.message } : {}),
          ...(result.raw ?? {}),
        } as Prisma.InputJsonValue,
      },
    });

    this.logger.debug(
      `[Verifactu ${this.aeat.mode}] refreshStatus(${invoiceId}) -> ${status}${result.csv ? ` CSV=${result.csv}` : ''}`,
    );
    return result;
  }

  private async saveStatus(
    invoiceId: string,
    result: GetStatusResult,
    source: string,
  ): Promise<void> {
    if (result.status === 'pending') return;
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
        aeatStatus: status,
        ...(result.csv ? { aeatCsv: result.csv } : {}),
        aeatResponse: {
          mode: this.aeat.mode,
          source,
          ...(result.message ? { message: result.message } : {}),
          ...(result.raw ?? {}),
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** Comprueba la huella de una factura ya emitida (auditoría). */
  verifyHash(args: {
    tenantTaxId: string;
    invoice: Pick<
      Invoice,
      | 'invoiceNumber'
      | 'issueDate'
      | 'invoiceType'
      | 'taxAmount'
      | 'total'
      | 'previousHash'
      | 'hash'
      | 'aeatRecordTimestamp'
    >;
  }): boolean {
    const i = args.invoice;
    if (!i.hash || !i.issueDate || !i.aeatRecordTimestamp) return false;
    return (
      computeAltaHash({
        emitterTaxId: args.tenantTaxId,
        invoiceNumber: i.invoiceNumber,
        issueDate: formatSpanishDate(i.issueDate),
        invoiceType: i.invoiceType,
        cuotaTotal: Number(i.taxAmount),
        importeTotal: Number(i.total),
        previousHash: i.previousHash,
        recordTimestamp: i.aeatRecordTimestamp,
      }) === i.hash.toUpperCase()
    );
  }
}
