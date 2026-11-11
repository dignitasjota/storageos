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
import { formatSpanishDate } from './aeat-client/verifactu-xml-builder';
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
import { VerifactuRecordsService } from './verifactu-records.service';

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

function toAeatStatus(status: SendInvoiceResult['status'] | GetStatusResult['status']): AeatStatus {
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
 * - **Registros** (`VerifactuRecordsService`): el alta de cada factura, sus
 *   subsanaciones y su anulación, con la huella oficial encadenada por emisor.
 * - **QR** con la URL de cotejo de la AEAT (pruebas o producción según
 *   `AEAT_MODE`) y la fecha en DD-MM-AAAA.
 * - **Envío** (cola `verifactu`, `sendPending`): por emisor, en lotes de hasta
 *   1.000 registros en el orden de su cadena, esperando entre un envío y otro
 *   lo que diga la AEAT (art. 16.2 de la Orden). Lo que no llegó se repite con
 *   espera creciente, como mucho cada hora, y sale marcado como incidencia
 *   (art. 16.4); si un envío anterior sí llegó, la AEAT contesta «duplicado»
 *   con lo que tiene y se toma eso. Con la baja programada, cada envío lleva
 *   la renuncia (`FechaFinVeriFactu`, art. 17.3).
 */
@Injectable()
export class VerifactuService {
  private readonly logger = new Logger(VerifactuService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    @Inject(AEAT_CLIENT) private readonly aeat: AeatClient,
    private readonly config: ConfigService<Env, true>,
    private readonly dispatcher: VerifactuDispatcher,
    private readonly records: VerifactuRecordsService,
  ) {}

  /** Envío real a la AEAT (pruebas o producción): exige datos fiscales completos. */
  get realMode(): boolean {
    return this.config.get('AEAT_MODE', { infer: true }) !== 'stub';
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
    const first = await this.pendingBatch(tenantId, ownerId, new Set());
    if (first.ids.length === 0) return out;
    const emitter = await this.ensureEmitter(tenantId, ownerId);
    const at = sendableAt(emitter, first.ids.length);
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
      // Tras un fallo, todo lo pendiente salió tarde por la incidencia: va
      // marcado (Incidencia=S), también lo que se emitió mientras tanto.
      if (emitter.consecutiveFailures > 0) await this.markIncident(tenantId, ownerId);
      for (let batch = 0; ; batch++) {
        const state = await this.admin.verifactuEmitter.findUniqueOrThrow({
          where: { id: emitter.id },
        });
        const next = await this.pendingBatch(tenantId, ownerId, attempted);
        if (next.ids.length === 0) break;
        const when = sendableAt(state, next.ids.length);
        if ((when && when.getTime() > Date.now()) || batch >= MAX_BATCHES_PER_RUN) {
          followUp = true;
          break;
        }
        for (const id of next.ids) attempted.add(id);
        // Cada lote puede tardar lo que tarde la AEAT: se renueva la reserva.
        await this.admin.verifactuEmitter.update({
          where: { id: emitter.id },
          data: { leaseUntil: new Date(Date.now() + SEND_LEASE_MS) },
        });
        const ok = await this.sendBatch(state, next);
        out.submissions += 1;
        out.records += next.ids.length;
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

  /**
   * Registros por enviar del emisor, en el orden de su cadena (como mucho
   * 1.000). Los retrasados por una incidencia y los demás no van juntos: la
   * marca de la cabecera vale para todo el envío.
   */
  private async pendingBatch(
    tenantId: string,
    ownerId: string | null,
    exclude: ReadonlySet<string>,
  ): Promise<{ ids: string[]; incident: boolean }> {
    const rows = await this.admin.verifactuRecord.findMany({
      where: {
        tenantId,
        ownerId,
        ...PENDING_RECORD_WHERE,
        ...(exclude.size > 0 ? { id: { notIn: [...exclude] } } : {}),
      },
      orderBy: { chainSeq: 'asc' },
      take: MAX_RECORDS_PER_SUBMISSION,
      select: { id: true, incident: true },
    });
    const incident = rows[0]?.incident ?? false;
    const ids: string[] = [];
    for (const r of rows) {
      if (r.incident !== incident) break;
      ids.push(r.id);
    }
    return { ids, incident };
  }

  /** Lo pendiente del emisor sale tarde por una incidencia técnica (art. 16.4). */
  private async markIncident(tenantId: string, ownerId: string | null): Promise<void> {
    await this.admin.verifactuRecord.updateMany({
      where: { tenantId, ownerId, ...PENDING_RECORD_WHERE, incident: false },
      data: { incident: true },
    });
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
   * La renuncia que lleva cada envío mientras la baja esté programada (y el
   * año siguiente, para lo que salga en enero de diciembre; 4120 de la AEAT).
   */
  private async renunciaDate(tenantId: string): Promise<Date | null> {
    const tenant = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { verifactuEndDate: true },
    });
    const end = tenant?.verifactuEndDate ?? null;
    if (!end) return null;
    return end.getUTCFullYear() >= new Date().getUTCFullYear() - 1 ? end : null;
  }

  /**
   * Un envío y lo que deja: el resultado de cada registro, la constancia del
   * envío y el estado del emisor (la espera que pide la AEAT o, si falló, el
   * reintento). Devuelve false si hay que repetirlo.
   */
  private async sendBatch(
    state: VerifactuEmitter,
    batch: { ids: string[]; incident: boolean },
  ): Promise<boolean> {
    const { tenantId, ownerId } = state;
    const fechaFin = await this.renunciaDate(tenantId);
    const result = await this.aeat.sendBatch({
      tenantId,
      ownerId,
      recordIds: batch.ids,
      remision: { fechaFinVerifactu: fechaFin, incidencia: batch.incident },
    });
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
            fechaFinVerifactu: fechaFin,
            incident: batch.incident,
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
    // Lo que queda por enviar ya sale tarde: va como incidencia.
    if (!ok) await this.markIncident(tenantId, ownerId);
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
        `${result.csv ? ` CSV=${result.csv}` : ''}${batch.incident ? ' incidencia' : ''}` +
        `${fechaFin ? ` renuncia ${fechaFin.toISOString().slice(0, 10)}` : ''}`,
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
    const duplicated = Object.entries(results).filter(
      ([, r]) => r.status === 'rejected' && /\b3000\b/.test(r.message ?? ''),
    );
    if (duplicated.length === 0) return out;
    const rows = await this.admin.verifactuRecord.findMany({
      where: { id: { in: duplicated.map(([id]) => id) }, kind: 'alta' },
      select: { id: true, invoiceId: true },
    });
    for (const row of rows) {
      const known = await this.aeat.getStatus({ invoiceId: row.invoiceId });
      if (known.status === 'accepted' || known.status === 'accepted_with_warnings') {
        out[row.id] = {
          status: known.status,
          csv: known.csv ?? null,
          message: 'duplicate_already_registered',
        };
      }
    }
    return out;
  }

  /**
   * Guarda en cada registro su resultado (los que quedan igual, de una vez) y
   * lo pasa a su factura, que enseña el estado de su último registro.
   */
  private async applyResults(
    tenantId: string,
    results: Record<string, SendInvoiceResult>,
    ctx: { sentAt: Date | null; submissionId: string | null },
  ): Promise<void> {
    const groups = new Map<
      string,
      { ids: string[]; data: Prisma.VerifactuRecordUpdateManyMutationInput }
    >();
    for (const [recordId, r] of Object.entries(results)) {
      const status = toAeatStatus(r.status);
      const registered = status === 'accepted' || status === 'accepted_with_warnings';
      const data: Prisma.VerifactuRecordUpdateManyMutationInput = {
        status,
        ...(ctx.sentAt ? { sentAt: ctx.sentAt } : {}),
        ...(ctx.submissionId ? { submissionId: ctx.submissionId } : {}),
        // El CSV acredita la remisión de lo registrado; un duplicado sin CSV
        // conserva el que tenía.
        ...(registered ? (r.csv ? { csv: r.csv } : {}) : { csv: null }),
        response: {
          mode: this.aeat.mode,
          ...(ctx.submissionId ? { submissionId: ctx.submissionId } : {}),
          ...(r.message ? { message: r.message } : {}),
          ...(r.raw ?? {}),
        } as Prisma.InputJsonValue,
      };
      const key = JSON.stringify(data);
      const group = groups.get(key);
      if (group) group.ids.push(recordId);
      else groups.set(key, { ids: [recordId], data });
    }
    for (const g of groups.values()) {
      await this.admin.verifactuRecord.updateMany({
        where: { id: { in: g.ids }, tenantId },
        data: g.data,
      });
    }
    const invoices = await this.admin.verifactuRecord.findMany({
      where: { id: { in: Object.keys(results) }, tenantId },
      select: { invoiceId: true },
      distinct: ['invoiceId'],
    });
    await this.records.syncInvoices(
      this.admin,
      invoices.map((i) => i.invoiceId),
    );
  }

  /**
   * Consulta a la AEAT el estado de la factura y lo guarda en su último
   * registro si la respuesta lo aclara. Lo usan el cron que repasa lo que se
   * quedó sin respuesta y el botón «Consultar AEAT».
   *
   * Sin datos en la AEAT (`pending`) no se toca nada: se volverá a mirar.
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
    const latest = await this.records.latest(this.admin, invoiceId);
    if (!latest) return { status: 'error', message: 'not_a_verifactu_record' };

    const result = await this.aeat.getStatus({ invoiceId });
    if (result.status === 'pending') {
      this.logger.debug(
        `[Verifactu ${this.aeat.mode}] refreshStatus(${invoiceId}) -> pending, no se actualiza BD`,
      );
      return result;
    }
    // La AEAT responde por la factura: «Anulado» confirma una anulación; si el
    // último registro es una anulación y la factura sigue dada de alta, la
    // anulación aún no ha llegado.
    const annulled = result.message === 'Anulado';
    if ((latest.kind === 'anulacion') !== annulled) return result;

    const status: AeatStatus = annulled ? 'accepted' : toAeatStatus(result.status);
    await this.admin.verifactuRecord.update({
      where: { id: latest.id },
      data: {
        status,
        ...(result.csv ? { csv: result.csv } : {}),
        response: {
          mode: this.aeat.mode,
          source: 'refresh_status',
          ...(result.message ? { message: result.message } : {}),
          ...(result.raw ?? {}),
        } as Prisma.InputJsonValue,
      },
    });
    await this.records.syncInvoices(this.admin, [invoiceId]);
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
