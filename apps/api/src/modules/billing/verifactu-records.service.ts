import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { isValidSpanishTaxId, normalizeTaxId, type VerifactuRecordDto } from '@storageos/shared';

import {
  breakdownFromItems,
  formatSpanishDate,
  formatTimestampWithMadridTimezone,
  VerifactuXmlBuilder,
} from './aeat-client/verifactu-xml-builder';
import { emitterKey } from './verifactu-flow';
import { computeAltaHash, computeAnulacionHash } from './verifactu-hash';
import { ownerInstallationNumber, verifactuInstallationNumber } from './verifactu-installation';

import type { Customer, Invoice, InvoiceItem, Prisma, VerifactuRecord } from '@storageos/database';

type Db = Prisma.TransactionClient;

/** El emisor de un registro: el negocio o, en el plan Administrador, un propietario. */
interface Emitter {
  name: string;
  /** NIF normalizado (el mismo en la huella y en el XML); `PENDIENTE` sin NIF. */
  taxId: string;
  system: { installationNumber: string; multipleTaxpayers: boolean };
}

/** Lo que devuelve generar un registro: lo que la factura guarda de su alta. */
export interface CreatedVerifactuRecord {
  id: string;
  hash: string;
  previousHash: string | null;
  chainSeq: number;
  recordTimestamp: string;
  /** Factura del registro anterior de la cadena (null en el primero). */
  previousInvoiceId: string | null;
}

interface CreateCommon {
  tenantId: string;
  invoiceId: string;
  ownerId: string | null;
  reason?: string | null;
  userId?: string | null;
  /**
   * Generado mientras el emisor no puede enviar (incidencia técnica). Si no se
   * dice, se mira si su último envío falló.
   */
  incident?: boolean;
}

/**
 * NIF español válido → `<NIF>`; si no, `<IDOtro>` con el país del cliente
 * (pasaporte → 03; documento extranjero → 04).
 */
export function recipientId(
  customer: {
    documentNumber: string | null;
    documentType: string | null;
    country: string | null;
  } | null,
): { taxId: string } | { otherId: { country: string; idType: '03' | '04' | '06'; id: string } } {
  const doc = (customer?.documentNumber ?? '').trim();
  if (doc && isValidSpanishTaxId(doc)) return { taxId: normalizeTaxId(doc) };
  const country = (customer?.country ?? 'ES').toUpperCase();
  const passport = /pasaporte|passport/i.test(customer?.documentType ?? '');
  return {
    otherId: { country, idType: passport ? '03' : country === 'ES' ? '06' : '04', id: doc },
  };
}

/**
 * Nombre del destinatario para `<IDDestinatario>`: la razón social de una
 * empresa o nombre y apellidos (la AEAT exige el campo siempre).
 */
export function recipientName(
  customer: Pick<Customer, 'customerType' | 'companyName' | 'firstName' | 'lastName'> | null,
): string {
  if (!customer) return 'Cliente sin identificar';
  if (customer.customerType === 'business') return customer.companyName ?? 'Empresa sin nombre';
  const full = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim();
  return full || 'Cliente sin identificar';
}

/**
 * `<DescripcionOperacion>` (500 caracteres): las notas de la factura o, si no
 * tiene, el mes facturado.
 */
export function operationDescription(
  invoice: Pick<Invoice, 'notes' | 'periodStart' | 'issueDate'>,
): string {
  if (invoice.notes && invoice.notes.trim().length > 0) return invoice.notes.slice(0, 500);
  const ref = invoice.periodStart ?? invoice.issueDate ?? new Date();
  const yyyy = ref.getUTCFullYear();
  const mm = String(ref.getUTCMonth() + 1).padStart(2, '0');
  return `Alquiler trasteros mes ${yyyy}-${mm}`;
}

function toDto(r: VerifactuRecord): VerifactuRecordDto {
  const response = (r.response ?? null) as { message?: unknown; mode?: unknown } | null;
  return {
    id: r.id,
    kind: r.kind === 'anulacion' ? 'anulacion' : 'alta',
    subsanacion: r.subsanacion,
    rechazoPrevio: r.rechazoPrevio === 'S' || r.rechazoPrevio === 'X' ? r.rechazoPrevio : null,
    sinRegistroPrevio: r.sinRegistroPrevio,
    chainSeq: r.chainSeq,
    status: r.status,
    csv: r.csv,
    message: typeof response?.message === 'string' ? response.message : null,
    sentAt: r.sentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    reason: r.reason,
    incident: r.incident,
    simulated: response?.mode === 'stub' || (r.csv?.startsWith('STUB-') ?? false),
  };
}

/**
 * Registros de facturación de Veri*Factu (RD 1007/2023, Orden HAC/1177/2024).
 *
 * Una factura tiene su registro de alta y, si hace falta, altas de subsanación
 * (corrigen un registro que la AEAT rechazó o aceptó con avisos) y un registro
 * de anulación (se emitió por error). Todos van en la cadena de su emisor, en
 * el orden en que se generan, y cada uno se guarda tal como se generó
 * (`xml`): no se modifica después, aunque cambien los datos del cliente.
 */
@Injectable()
export class VerifactuRecordsService {
  constructor(private readonly xml: VerifactuXmlBuilder) {}

  /**
   * El registro de alta de una factura que se emite, o una subsanación suya.
   * Se llama dentro de la transacción que la emite (o que la corrige): el
   * bloqueo por emisor serializa la cadena.
   */
  async createAlta(
    db: Db,
    args: CreateCommon & {
      /** Al emitir, la factura aún no tiene número ni fecha guardados. */
      invoiceNumber?: string;
      issueDate?: Date;
      subsanacion?: boolean;
      rechazoPrevio?: 'S' | 'X' | null;
    },
  ): Promise<CreatedVerifactuRecord> {
    await this.lockChain(db, args.tenantId, args.ownerId);
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: args.invoiceId },
      include: { items: true, customer: true },
    });
    const invoiceNumber = args.invoiceNumber ?? invoice.invoiceNumber;
    const issueDate = args.issueDate ?? invoice.issueDate;
    if (!issueDate) throw new Error(`invoice ${invoice.id} sin fecha de emisión`);
    const emitter = await this.emitter(db, args.tenantId, args.ownerId);
    const previous = await this.previousRecord(db, args.tenantId, args.ownerId);
    const chainSeq = await this.nextChainSeq(db, args.tenantId, args.ownerId, previous);
    const recordTimestamp = formatTimestampWithMadridTimezone(new Date());
    const previousHash = previous?.hash ?? null;
    const hash = computeAltaHash({
      emitterTaxId: emitter.taxId,
      invoiceNumber,
      issueDate: formatSpanishDate(issueDate),
      invoiceType: invoice.invoiceType,
      cuotaTotal: Number(invoice.taxAmount),
      importeTotal: Number(invoice.total),
      previousHash,
      recordTimestamp,
    });
    const id = randomUUID();
    const xml = await this.altaXml(db, {
      invoice: { ...invoice, invoiceNumber, issueDate },
      emitter,
      recordId: id,
      hash,
      previousHash,
      previous: previous
        ? { invoiceNumber: previous.invoice.invoiceNumber, issueDate: previous.invoice.issueDate }
        : null,
      recordTimestamp,
      subsanacion: args.subsanacion ?? false,
      rechazoPrevio: args.subsanacion ? (args.rechazoPrevio ?? null) : null,
    });
    await db.verifactuRecord.create({
      data: {
        id,
        tenantId: args.tenantId,
        ownerId: args.ownerId,
        invoiceId: args.invoiceId,
        kind: 'alta',
        subsanacion: args.subsanacion ?? false,
        rechazoPrevio: args.subsanacion ? (args.rechazoPrevio ?? null) : null,
        chainSeq,
        previousRecordId: previous?.id ?? null,
        hash,
        previousHash,
        recordTimestamp,
        xml,
        status: 'pending',
        incident: args.incident ?? (await this.emitterInIncident(db, args.tenantId, args.ownerId)),
        reason: args.reason ?? null,
        createdByUserId: args.userId ?? null,
      },
    });
    return {
      id,
      hash,
      previousHash,
      chainSeq,
      recordTimestamp,
      previousInvoiceId: previous?.invoiceId ?? null,
    };
  }

  /**
   * El registro de anulación de una factura emitida por error (art. 11 del
   * RRSIF). Con `sinRegistroPrevio`, la AEAT no tiene la factura (su alta se
   * rechazó); con `rechazoPrevio`, corrige una anulación rechazada.
   */
  async createAnulacion(
    db: Db,
    args: CreateCommon & { sinRegistroPrevio?: boolean; rechazoPrevio?: boolean },
  ): Promise<CreatedVerifactuRecord> {
    await this.lockChain(db, args.tenantId, args.ownerId);
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: args.invoiceId },
      select: { invoiceNumber: true, issueDate: true },
    });
    if (!invoice.issueDate) throw new Error(`invoice ${args.invoiceId} sin fecha de emisión`);
    const emitter = await this.emitter(db, args.tenantId, args.ownerId);
    const previous = await this.previousRecord(db, args.tenantId, args.ownerId);
    const chainSeq = await this.nextChainSeq(db, args.tenantId, args.ownerId, previous);
    const recordTimestamp = formatTimestampWithMadridTimezone(new Date());
    const previousHash = previous?.hash ?? null;
    const hash = computeAnulacionHash({
      emitterTaxId: emitter.taxId,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: formatSpanishDate(invoice.issueDate),
      previousHash,
      recordTimestamp,
    });
    const id = randomUUID();
    const xml = this.xml.buildRegistroAnulacionRecord({
      emitterTaxId: emitter.taxId,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      refExterna: id,
      sinRegistroPrevio: args.sinRegistroPrevio ?? false,
      rechazoPrevio: args.rechazoPrevio ?? false,
      system: emitter.system,
      previous:
        previous && previous.invoice.issueDate
          ? {
              emitterTaxId: emitter.taxId,
              invoiceNumber: previous.invoice.invoiceNumber,
              issueDate: previous.invoice.issueDate,
              hash: previous.hash,
            }
          : null,
      recordTimestamp,
      hash,
    });
    await db.verifactuRecord.create({
      data: {
        id,
        tenantId: args.tenantId,
        ownerId: args.ownerId,
        invoiceId: args.invoiceId,
        kind: 'anulacion',
        sinRegistroPrevio: args.sinRegistroPrevio ?? false,
        rechazoPrevio: args.rechazoPrevio ? 'S' : null,
        chainSeq,
        previousRecordId: previous?.id ?? null,
        hash,
        previousHash,
        recordTimestamp,
        xml,
        status: 'pending',
        incident: args.incident ?? (await this.emitterInIncident(db, args.tenantId, args.ownerId)),
        reason: args.reason ?? null,
        createdByUserId: args.userId ?? null,
      },
    });
    return {
      id,
      hash,
      previousHash,
      chainSeq,
      recordTimestamp,
      previousInvoiceId: previous?.invoiceId ?? null,
    };
  }

  /**
   * El XML de un registro para enviarlo: el que se guardó al generarlo. Los
   * anteriores a esta versión no lo guardaban y se arman con los datos de su
   * factura, como hasta ahora.
   */
  async recordXml(db: Db, record: VerifactuRecord): Promise<string> {
    if (record.xml) return record.xml;
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: record.invoiceId },
      include: { items: true, customer: true },
    });
    if (!invoice.issueDate) throw new Error(`invoice ${invoice.id} sin fecha de emisión`);
    const previous = record.previousRecordId
      ? await db.verifactuRecord.findUnique({
          where: { id: record.previousRecordId },
          select: { invoice: { select: { invoiceNumber: true, issueDate: true } } },
        })
      : null;
    return this.altaXml(db, {
      invoice: { ...invoice, issueDate: invoice.issueDate },
      emitter: await this.emitter(db, record.tenantId, record.ownerId),
      recordId: record.id,
      hash: record.hash,
      previousHash: record.previousHash,
      previous: previous
        ? { invoiceNumber: previous.invoice.invoiceNumber, issueDate: previous.invoice.issueDate }
        : null,
      recordTimestamp: record.recordTimestamp,
      subsanacion: record.subsanacion,
      rechazoPrevio:
        record.rechazoPrevio === 'S' || record.rechazoPrevio === 'X' ? record.rechazoPrevio : null,
    });
  }

  /**
   * Cada factura enseña el estado de su último registro (el que vale ahora):
   * su `aeat_status` y, si lo hay, el CSV y la fecha del último envío.
   */
  async syncInvoices(db: Db, invoiceIds: readonly string[]): Promise<void> {
    if (invoiceIds.length === 0) return;
    await db.$executeRaw`
      UPDATE invoices i
      SET aeat_status = r.status,
          aeat_csv = COALESCE(r.csv, i.aeat_csv),
          aeat_response = r.response,
          aeat_sent_at = COALESCE(r.sent_at, i.aeat_sent_at)
      FROM (
        SELECT DISTINCT ON (invoice_id) invoice_id, status, csv, response, sent_at
        FROM verifactu_records
        WHERE invoice_id = ANY(${[...invoiceIds]}::uuid[])
        ORDER BY invoice_id, chain_seq DESC
      ) r
      WHERE i.id = r.invoice_id`;
  }

  /** El último registro de una factura (el que vale ahora). */
  latest(db: Db, invoiceId: string): Promise<VerifactuRecord | null> {
    return db.verifactuRecord.findFirst({
      where: { invoiceId },
      orderBy: { chainSeq: 'desc' },
    });
  }

  /** Los registros de una factura, en el orden de la cadena. */
  async listForInvoice(db: Db, invoiceId: string): Promise<VerifactuRecordDto[]> {
    const rows = await db.verifactuRecord.findMany({
      where: { invoiceId },
      orderBy: { chainSeq: 'asc' },
    });
    return rows.map(toDto);
  }

  // --------------------------------------------------------------------------

  /** Su último envío falló y aún no se ha recuperado: lo que se genera ahora sale tarde. */
  private async emitterInIncident(
    db: Db,
    tenantId: string,
    ownerId: string | null,
  ): Promise<boolean> {
    const emitter = await db.verifactuEmitter.findUnique({
      where: { tenantId_emitterKey: { tenantId, emitterKey: emitterKey(ownerId) } },
      select: { consecutiveFailures: true },
    });
    return (emitter?.consecutiveFailures ?? 0) > 0;
  }

  private async lockChain(db: Db, tenantId: string, ownerId: string | null): Promise<void> {
    // Una cadena por emisor: el tenant (owner null) o cada propietario.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verifactu-chain:${tenantId}:${ownerId ?? 'self'}`}))`;
  }

  private previousRecord(db: Db, tenantId: string, ownerId: string | null) {
    return db.verifactuRecord.findFirst({
      where: { tenantId, ownerId },
      orderBy: { chainSeq: 'desc' },
      select: {
        id: true,
        hash: true,
        chainSeq: true,
        invoiceId: true,
        invoice: { select: { invoiceNumber: true, issueDate: true } },
      },
    });
  }

  /**
   * La siguiente posición de la cadena. También mira la de las facturas: las
   * que se encadenaron antes de guardar los registros aparte y no se pudieron
   * copiar no deben repetir número.
   */
  private async nextChainSeq(
    db: Db,
    tenantId: string,
    ownerId: string | null,
    previous: { chainSeq: number } | null,
  ): Promise<number> {
    const legacy = await db.invoice.aggregate({
      where: { tenantId, ownerId, chainSeq: { not: null } },
      _max: { chainSeq: true },
    });
    return Math.max(previous?.chainSeq ?? 0, legacy._max.chainSeq ?? 0) + 1;
  }

  private async emitter(db: Db, tenantId: string, ownerId: string | null): Promise<Emitter> {
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        billingLegalName: true,
        taxId: true,
        verifactuInstallation: true,
        verifactuEnabledAt: true,
        createdAt: true,
      },
    });
    const owner = ownerId
      ? await db.owner.findUniqueOrThrow({
          where: { id: ownerId },
          select: { id: true, legalName: true, taxId: true },
        })
      : null;
    const raw = owner ? owner.taxId : tenant.taxId;
    const taxId = raw ? normalizeTaxId(raw) : '';
    // El negocio y cada propietario son facturaciones distintas, cada una con
    // su número de instalación (el del negocio se fija al activar Veri*Factu).
    const tenantInstallation =
      tenant.verifactuInstallation ??
      verifactuInstallationNumber(tenant.verifactuEnabledAt ?? tenant.createdAt, tenant.id);
    const owners = await db.owner.count({ where: { tenantId } });
    return {
      name: owner ? owner.legalName : tenant.billingLegalName || tenant.name,
      taxId: taxId || 'PENDIENTE',
      system: {
        installationNumber: owner
          ? ownerInstallationNumber(tenantInstallation, owner.id)
          : tenantInstallation,
        multipleTaxpayers: owners > 0,
      },
    };
  }

  /** El `RegistroFactura` de un alta (o de una subsanación) con los datos de su factura. */
  private async altaXml(
    db: Db,
    args: {
      invoice: Invoice & { items: InvoiceItem[]; customer: Customer | null; issueDate: Date };
      emitter: Emitter;
      recordId: string;
      hash: string;
      previousHash: string | null;
      previous: { invoiceNumber: string; issueDate: Date | null } | null;
      recordTimestamp: string;
      subsanacion: boolean;
      rechazoPrevio: 'S' | 'X' | null;
    },
  ): Promise<string> {
    const { invoice, emitter } = args;
    // Rectificativa: la factura original (`<FacturasRectificadas>`) y, si es
    // por sustitución, sus importes (`<ImporteRectificacion>`).
    const original =
      invoice.invoiceType.startsWith('R') && invoice.rectifiesInvoiceId
        ? await db.invoice.findUnique({
            where: { id: invoice.rectifiesInvoiceId },
            select: { invoiceNumber: true, issueDate: true, subtotal: true, taxAmount: true },
          })
        : null;
    const rectifies =
      original?.invoiceNumber && original.issueDate
        ? [
            {
              emitterTaxId: emitter.taxId,
              invoiceNumber: original.invoiceNumber,
              issueDate: original.issueDate,
            },
          ]
        : undefined;
    const originalAmounts =
      rectifies && original && invoice.correctionMethod === 'by_substitution'
        ? {
            baseRectificada: Number(original.subtotal),
            cuotaRectificada: Number(original.taxAmount),
          }
        : undefined;
    // Rectificativas: `I` por diferencias, `S` por sustitución.
    const correctionMethod: 'I' | 'S' | undefined =
      invoice.correctionMethod === 'by_substitution' ? 'S' : rectifies ? 'I' : undefined;
    // Una línea de desglose por tipo de IVA y tipo fiscal.
    const breakdown = breakdownFromItems(
      invoice.items.map((it) => ({
        taxRate: Number(it.taxRate),
        taxAmount: Number(it.taxAmount),
        total: Number(it.total),
        taxCategory: it.taxCategory,
      })),
    );
    return this.xml.buildRegistroAltaRecord({
      tenant: { name: emitter.name, taxId: emitter.taxId },
      system: emitter.system,
      invoice: {
        series: invoice.invoiceNumber.split('-')[0] ?? 'F',
        refExterna: args.recordId,
        invoiceNumber: invoice.invoiceNumber,
        issueDate: invoice.issueDate,
        description: operationDescription(invoice),
        invoiceType: invoice.invoiceType as 'F1' | 'F2' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5',
        breakdown,
        taxAmount: Number(invoice.taxAmount),
        total: Number(invoice.total),
        recordTimestamp: args.recordTimestamp,
        hash: args.hash,
        previousHash: args.previousHash,
        ...(args.previous?.invoiceNumber
          ? { previousInvoiceNumber: args.previous.invoiceNumber }
          : {}),
        ...(args.previous?.issueDate ? { previousInvoiceDate: args.previous.issueDate } : {}),
        previousEmitterNif: emitter.taxId,
        ...(rectifies ? { rectifies } : {}),
        ...(correctionMethod ? { correctionMethod } : {}),
        ...(originalAmounts ? { originalAmounts } : {}),
        subsanacion: args.subsanacion,
        rechazoPrevio: args.rechazoPrevio,
      },
      // Una F2 sin cliente (simplificada) va sin destinatario.
      ...(invoice.customer
        ? {
            recipient: {
              name: recipientName(invoice.customer),
              ...recipientId(invoice.customer),
            },
          }
        : {}),
    });
  }
}
