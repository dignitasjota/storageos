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
import { PENDING_RECORD_WHERE, VerifactuDispatcher } from './verifactu-dispatcher.service';
import {
  DEFAULT_WAIT_SECONDS,
  emitterKey,
  MAX_RECORDS_PER_SUBMISSION,
  retryDelayMs,
  SEND_LEASE_MS,
  sendableAt,
} from './verifactu-flow';
import { computeAltaHash } from './verifactu-hash';

import type { Env } from '../../config/env.schema';
import type { AeatStatus, Invoice, Prisma, VerifactuEmitter } from '@storageos/database';

/** Envíos seguidos de un emisor en una vuelta (con 1.000 registros acumulados cada vez). */
const MAX_BATCHES_PER_RUN = 5;

/** Lo que ha hecho una vuelta de `sendPending`. */
export interface SendPendingResult {
  /** Envíos hechos (o intentados) en esta vuelta. */
  submissions: number;
  /** Registros que llevaban. */
  records: number;
  /** Queda algo pendiente y sale a esta hora (ya programado). */
  nextRunAt: Date | null;
  /** Otro proceso estaba enviando lo de este emisor. */
  busy?: boolean;
}

function toAeatStatus(status: SendInvoiceResult['status']): AeatStatus {
  return status === 'accepted'
    ? 'accepted'
    : status === 'accepted_with_warnings'
      ? 'accepted_with_warnings'
      : status === 'rejected'
        ? 'rejected'
        : 'error';
}

/**
 * Veri*Factu (RD 1007/2023, Orden HAC/1177/2024).
 *
 * - **Huella oficial** (`verifactu-hash.ts`): SHA-256 de los campos del
 *   registro de alta + la huella del registro ANTERIOR DEL EMISOR (cadena por
 *   tenant, no por serie) + la FechaHoraHusoGenRegistro, que se fija al emitir
 *   y se guarda para que el XML lleve exactamente la misma.
 * - **QR** con la URL de cotejo de la AEAT (pruebas o producción según
 *   `AEAT_MODE`) y la fecha en DD-MM-AAAA.
 * - **Envío** (cola `verifactu`, `sendPending`): por emisor, en lotes de hasta
 *   1.000 registros en el orden de su cadena, esperando entre un envío y otro
 *   lo que diga la AEAT (art. 16.2 de la Orden). Lo que no llegó se repite con
 *   espera creciente, como mucho cada hora; si un envío anterior sí llegó, la
 *   AEAT contesta «duplicado» con lo que tiene y se toma eso.
 */
@Injectable()
export class VerifactuService {
  private readonly logger = new Logger(VerifactuService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    @Inject(AEAT_CLIENT) private readonly aeat: AeatClient,
    private readonly config: ConfigService<Env, true>,
    private readonly dispatcher: VerifactuDispatcher,
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
      /** Emisor propietario (plan Administrador): su propia cadena. */
      ownerId?: string | null;
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
    // Una cadena por emisor: el tenant (owner null) o cada propietario.
    const ownerId = args.ownerId ?? null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verifactu-chain:${args.tenantId}:${ownerId ?? 'self'}`}))`;
    const previous = await tx.invoice.findFirst({
      where: { tenantId: args.tenantId, ownerId, chainSeq: { not: null } },
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
    // Nivel M (art. 21). Se imprime a 34 mm: con 440 px sale bien definido.
    const qrPng = await QRCode.toDataURL(url.toString(), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 440,
    });
    return qrPng;
  }

  /**
   * Envía lo pendiente de un emisor (el negocio o un propietario): lotes de
   * hasta 1.000 registros, en el orden de su cadena, y esperando entre uno y
   * otro lo que pida la AEAT (o a juntar 1.000). Lo llama el trabajo de la
   * cola; si aún no toca, deja programado el siguiente.
   */
  async sendPending(tenantId: string, ownerId: string | null): Promise<SendPendingResult> {
    const out: SendPendingResult = { submissions: 0, records: 0, nextRunAt: null };
    const first = await this.pendingIds(tenantId, ownerId, new Set());
    if (first.length === 0) return out;
    const emitter = await this.ensureEmitter(tenantId, ownerId);
    const at = sendableAt(emitter, first.length);
    if (at && at.getTime() > Date.now()) {
      out.nextRunAt = await this.dispatcher.schedule(tenantId, ownerId);
      return out;
    }

    // Dos envíos del mismo emisor nunca van a la vez (el orden de la cadena).
    const leased = await this.admin.verifactuEmitter.updateMany({
      where: { id: emitter.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
      data: { leaseUntil: new Date(Date.now() + SEND_LEASE_MS) },
    });
    if (leased.count === 0) {
      out.busy = true;
      out.nextRunAt = await this.dispatcher.schedule(tenantId, ownerId, {
        notBefore: new Date(Date.now() + 30_000),
      });
      return out;
    }

    let followUp = false;
    const attempted = new Set<string>();
    try {
      for (let batch = 0; ; batch++) {
        const state = await this.admin.verifactuEmitter.findUniqueOrThrow({
          where: { id: emitter.id },
        });
        const ids = await this.pendingIds(tenantId, ownerId, attempted);
        if (ids.length === 0) break;
        const next = sendableAt(state, ids.length);
        if ((next && next.getTime() > Date.now()) || batch >= MAX_BATCHES_PER_RUN) {
          followUp = true;
          break;
        }
        for (const id of ids) attempted.add(id);
        // Cada lote puede tardar lo que tarde la AEAT: se renueva la reserva.
        await this.admin.verifactuEmitter.update({
          where: { id: emitter.id },
          data: { leaseUntil: new Date(Date.now() + SEND_LEASE_MS) },
        });
        const ok = await this.sendBatch(state, ids);
        out.submissions += 1;
        out.records += ids.length;
        if (!ok) {
          followUp = true;
          break;
        }
      }
    } finally {
      await this.admin.verifactuEmitter.updateMany({
        where: { id: emitter.id },
        data: { leaseUntil: null },
      });
    }
    if (followUp) out.nextRunAt = await this.dispatcher.schedule(tenantId, ownerId);
    return out;
  }

  /** Registros por enviar del emisor, en el orden de su cadena (como mucho 1.000). */
  private async pendingIds(
    tenantId: string,
    ownerId: string | null,
    exclude: ReadonlySet<string>,
  ): Promise<string[]> {
    const rows = await this.admin.invoice.findMany({
      where: {
        tenantId,
        ownerId,
        ...PENDING_RECORD_WHERE,
        ...(exclude.size > 0 ? { id: { notIn: [...exclude] } } : {}),
      },
      orderBy: [{ chainSeq: { sort: 'asc', nulls: 'last' } }, { issueDate: 'asc' }, { id: 'asc' }],
      take: MAX_RECORDS_PER_SUBMISSION,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async ensureEmitter(tenantId: string, ownerId: string | null): Promise<VerifactuEmitter> {
    const where = { tenantId_emitterKey: { tenantId, emitterKey: emitterKey(ownerId) } };
    const found = await this.admin.verifactuEmitter.findUnique({ where });
    if (found) return found;
    try {
      return await this.admin.verifactuEmitter.create({
        data: { tenantId, ownerId, emitterKey: emitterKey(ownerId) },
      });
    } catch (err) {
      // Otro proceso lo acaba de crear.
      if ((err as { code?: string }).code === 'P2002') {
        return this.admin.verifactuEmitter.findUniqueOrThrow({ where });
      }
      throw err;
    }
  }

  /**
   * Un envío y lo que deja: el resultado de cada factura, la constancia del
   * envío y el estado del emisor (la espera que pide la AEAT o, si falló, el
   * reintento). Devuelve false si hay que repetirlo.
   */
  private async sendBatch(state: VerifactuEmitter, invoiceIds: string[]): Promise<boolean> {
    const { tenantId, ownerId } = state;
    const result = await this.aeat.sendBatch({ tenantId, ownerId, invoiceIds });
    const now = new Date();
    const results = await this.resolveDuplicates(result.results);
    const list = Object.values(results);
    const accepted = list.filter(
      (r) => r.status === 'accepted' || r.status === 'accepted_with_warnings',
    ).length;
    const rejected = list.filter((r) => r.status === 'rejected').length;
    const went = result.outcome !== 'not_sent';

    const submission = went
      ? await this.admin.verifactuSubmission.create({
          data: {
            tenantId,
            ownerId,
            emitterTaxId: result.emitterTaxId,
            mode: this.aeat.mode,
            status: result.outcome === 'sent' ? (result.status ?? 'rejected') : 'error',
            csv: result.csv ?? null,
            waitSeconds: result.outcome === 'sent' ? (result.waitSeconds ?? null) : null,
            recordCount: result.recordCount,
            acceptedCount: accepted,
            rejectedCount: rejected,
            message: result.message?.slice(0, 500) ?? null,
            sentAt: now,
          },
          select: { id: true },
        })
      : null;
    await this.applyResults(tenantId, results, {
      sentAt: went ? now : null,
      submissionId: submission?.id ?? null,
    });

    // Un registro sin resultado claro se repite más tarde (los rechazados no:
    // es la decisión de la AEAT).
    const ok = result.outcome === 'sent' && !list.some((r) => r.status === 'error');
    const failures = ok ? 0 : state.consecutiveFailures + 1;
    const waitSeconds = result.waitSeconds ?? DEFAULT_WAIT_SECONDS;
    await this.admin.verifactuEmitter.update({
      where: { id: state.id },
      data: {
        ...(result.outcome === 'sent'
          ? { nextSendAt: new Date(now.getTime() + waitSeconds * 1000), waitSeconds }
          : {}),
        // Un envío sin respuesta pudo llegar: también cuenta para la espera.
        ...(result.outcome === 'failed'
          ? {
              nextSendAt: new Date(
                Math.max(
                  state.nextSendAt?.getTime() ?? 0,
                  now.getTime() + DEFAULT_WAIT_SECONDS * 1000,
                ),
              ),
            }
          : {}),
        consecutiveFailures: failures,
        retryAt: ok ? null : new Date(now.getTime() + retryDelayMs(failures)),
        lastError: ok
          ? null
          : (result.message ?? list.find((r) => r.status === 'error')?.message ?? 'error').slice(
              0,
              500,
            ),
      },
    });
    this.logger.debug(
      `[Verifactu ${this.aeat.mode}] tenant ${tenantId} emisor ${emitterKey(ownerId)}: ` +
        `${result.outcome} ${result.recordCount} registros (${accepted} aceptados, ${rejected} rechazados)` +
        `${result.csv ? ` CSV=${result.csv}` : ''}`,
    );
    return ok;
  }

  /**
   * «Registro duplicado» sin el detalle de lo guardado: ya estaba en la AEAT
   * (llegó un envío anterior cuya respuesta se perdió) → su estado real.
   */
  private async resolveDuplicates(
    results: Record<string, SendInvoiceResult>,
  ): Promise<Record<string, SendInvoiceResult>> {
    const out = { ...results };
    for (const [invoiceId, r] of Object.entries(results)) {
      if (r.status !== 'rejected' || !/\b3000\b/.test(r.message ?? '')) continue;
      const known = await this.aeat.getStatus({ invoiceId });
      if (known.status === 'accepted' || known.status === 'accepted_with_warnings') {
        out[invoiceId] = {
          status: known.status,
          csv: known.csv ?? null,
          message: 'duplicate_already_registered',
        };
      }
    }
    return out;
  }

  /** Guarda en cada factura su resultado (las que quedan igual, de una vez). */
  private async applyResults(
    tenantId: string,
    results: Record<string, SendInvoiceResult>,
    ctx: { sentAt: Date | null; submissionId: string | null },
  ): Promise<void> {
    const groups = new Map<
      string,
      { ids: string[]; data: Prisma.InvoiceUpdateManyMutationInput }
    >();
    for (const [invoiceId, r] of Object.entries(results)) {
      const status = toAeatStatus(r.status);
      const registered = status === 'accepted' || status === 'accepted_with_warnings';
      const data: Prisma.InvoiceUpdateManyMutationInput = {
        aeatStatus: status,
        ...(ctx.sentAt ? { aeatSentAt: ctx.sentAt } : {}),
        // El CSV acredita la remisión de lo registrado; un duplicado sin CSV
        // conserva el que tenía.
        ...(registered ? (r.csv ? { aeatCsv: r.csv } : {}) : { aeatCsv: null }),
        aeatResponse: {
          mode: this.aeat.mode,
          ...(ctx.submissionId ? { submissionId: ctx.submissionId } : {}),
          ...(r.message ? { message: r.message } : {}),
          ...(r.raw ?? {}),
        } as Prisma.InputJsonValue,
      };
      const key = JSON.stringify(data);
      const group = groups.get(key);
      if (group) group.ids.push(invoiceId);
      else groups.set(key, { ids: [invoiceId], data });
    }
    for (const g of groups.values()) {
      await this.admin.invoice.updateMany({ where: { id: { in: g.ids }, tenantId }, data: g.data });
    }
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
