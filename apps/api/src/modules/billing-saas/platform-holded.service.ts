import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service';
import { holdedRejected } from '../accounting/holded-sync.service';
import { HoldedClient, type HoldedLine } from '../accounting/holded.client';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Prisma } from '@storageos/database';
import type {
  HoldedSeriesListDto,
  HoldedTestResultDto,
  PlatformHoldedReviewItemDto,
  PlatformHoldedSettingsDto,
  ResolvePlatformHoldedReviewInput,
  UpdatePlatformHoldedSettingsInput,
} from '@storageos/shared';

/** Contexto del cifrado de la clave de Holded de la plataforma. */
const AAD = 'platform-holded';
const day = (d: Date): string => d.toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Margen antes de dar un envío por «sin confirmar» (cada llamada a Holded tarda segundos). */
const REVIEW_AFTER_MS = 5 * 60_000;

/** Estados de la reserva: documento principal (`doc`) o anulación de la original (`credit`). */
const CREATING = { doc: 'creating', credit: 'credit_creating' } as const;
const APPROVING = { doc: 'approving', credit: 'credit_approving' } as const;

/** Lo que falta por enviar (o por aprobar) a Holded. */
const PENDING_WHERE: Prisma.PlatformInvoiceWhereInput = {
  // Las emitidas por el negocio propio las copia (o emite) su propio Holded.
  invoiceId: null,
  OR: [
    { holdedSyncState: { in: [APPROVING.doc, APPROVING.credit] } },
    {
      holdedSyncState: null,
      OR: [
        // Sin copiar (salvo una original sustituida que nunca llegó a Holded).
        {
          holdedDocumentId: null,
          NOT: { invoiceType: 'F1', status: 'rectified' },
        },
        // Copiada sin su cobro.
        {
          invoiceType: 'F1',
          holdedDocumentId: { not: null },
          holdedPaymentSyncedAt: null,
          holdedPaymentStartedAt: null,
          total: { gt: 0 },
        },
        // Sustitución sin la anulación de la original (copiada) en Holded.
        {
          correctionMethod: 'substitution',
          holdedCreditNoteId: null,
          rectifiesInvoice: { holdedDocumentId: { not: null } },
        },
      ],
    },
  ],
};

type HoldedDocumentInput = Parameters<HoldedClient['createDocument']>[1];

interface Resolved {
  client: HoldedClient;
  seriesId: string;
  creditNoteSeriesId: string | null;
}

interface InvoiceLike {
  tenantName: string;
  tenantTaxId: string | null;
  tenantEmail: string | null;
  concept: string | null;
  planName: string | null;
  baseAmount: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  lines: {
    description: string;
    quantity: number;
    baseAmount: Prisma.Decimal;
    taxRate: Prisma.Decimal;
  }[];
}

type LoadedInvoice = NonNullable<Awaited<ReturnType<PlatformHoldedService['load']>>>;

/**
 * Copia contable en Holded de las facturas de suscripción de la plataforma
 * (TrasterOS → tenants). Como en la integración de los tenants, la app emite la
 * factura y Holded solo la contabiliza: se crea en una serie de Holded marcada
 * «No enviar a Verifactu», aprobada y con su cobro (las facturas de suscripción
 * se emiten siempre por un pago ya cobrado); las rectificativas van a la serie
 * de rectificativas. Desactivada hasta contratar Holded.
 */
@Injectable()
export class PlatformHoldedService {
  private readonly logger = new Logger(PlatformHoldedService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
  ) {}

  async getSettings(): Promise<PlatformHoldedSettingsDto> {
    const row = await this.row();
    const hasApiKey = !!row?.holdedApiKeyEncrypted;
    const enabled = row?.holdedEnabled ?? false;
    const before = new Date(Date.now() - REVIEW_AFTER_MS);
    const [pendingCount, reviewDocs, reviewPayments] = await Promise.all([
      this.admin.platformInvoice.count({ where: PENDING_WHERE }),
      this.admin.platformInvoice.count({
        where: {
          holdedSyncState: { in: [CREATING.doc, CREATING.credit] },
          holdedSyncStartedAt: { lt: before },
        },
      }),
      this.admin.platformInvoice.count({
        where: { holdedPaymentSyncedAt: null, holdedPaymentStartedAt: { lt: before } },
      }),
    ]);
    return {
      enabled,
      hasApiKey,
      invoiceSeriesId: row?.holdedInvoiceSeriesId ?? null,
      creditNoteSeriesId: row?.holdedCreditNoteSeriesId ?? null,
      reviewCount: reviewDocs + reviewPayments,
      ready: enabled && hasApiKey && !!row?.holdedInvoiceSeriesId,
      lastSyncAt: row?.holdedLastSyncAt?.toISOString() ?? null,
      lastError: row?.holdedLastError ?? null,
      pendingCount,
    };
  }

  async updateSettings(
    input: UpdatePlatformHoldedSettingsInput,
  ): Promise<PlatformHoldedSettingsDto> {
    const existing = await this.row();
    if (input.enabled && !input.apiKey && !existing?.holdedApiKeyEncrypted) {
      throw new BadRequestException({
        code: 'holded_api_key_required',
        message: 'Necesitas una API key de Holded para activar la copia',
      });
    }
    const apiKey =
      input.apiKey ??
      (existing?.holdedApiKeyEncrypted
        ? this.crypto.decryptString(existing.holdedApiKeyEncrypted, AAD)
        : null);
    if (input.invoiceSeriesId) {
      if (!apiKey) {
        throw new BadRequestException({
          code: 'holded_api_key_required',
          message: 'Guarda primero la API key de Holded',
        });
      }
      await this.assertExcludedSeries(new HoldedClient(apiKey), input.invoiceSeriesId);
    }
    if (input.creditNoteSeriesId) {
      if (!apiKey) {
        throw new BadRequestException({
          code: 'holded_api_key_required',
          message: 'Guarda primero la API key de Holded',
        });
      }
      await this.assertExcludedSeries(
        new HoldedClient(apiKey),
        input.creditNoteSeriesId,
        'creditnote',
      );
    }
    const data = {
      holdedEnabled: input.enabled,
      ...(input.apiKey
        ? {
            holdedApiKeyEncrypted: this.crypto.encryptString(input.apiKey, AAD),
            holdedLastError: null,
          }
        : {}),
      ...(input.invoiceSeriesId !== undefined
        ? { holdedInvoiceSeriesId: input.invoiceSeriesId }
        : {}),
      ...(input.creditNoteSeriesId !== undefined
        ? { holdedCreditNoteSeriesId: input.creditNoteSeriesId }
        : {}),
    };
    if (existing) {
      await this.admin.platformBillingSettings.update({ where: { id: existing.id }, data });
    } else {
      await this.admin.platformBillingSettings.create({ data });
    }
    return this.getSettings();
  }

  async listSeries(): Promise<HoldedSeriesListDto> {
    const client = await this.clientOrThrow();
    try {
      const [invoice, creditnote] = await Promise.all([
        client.listSeries('invoice'),
        client.listSeries('creditnote'),
      ]);
      return { invoice, creditnote };
    } catch (err) {
      throw new BadRequestException({
        code: 'holded_request_failed',
        message: err instanceof Error ? err.message : 'Error consultando Holded',
      });
    }
  }

  async test(): Promise<HoldedTestResultDto> {
    const row = await this.row();
    if (!row?.holdedApiKeyEncrypted) return { ok: false, message: 'No hay API key configurada' };
    try {
      await new HoldedClient(
        this.crypto.decryptString(row.holdedApiKeyEncrypted, AAD),
      ).testConnection();
      return { ok: true, message: 'Conexión correcta con Holded' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Error de conexión' };
    }
  }

  /** Copia una factura de suscripción si la integración está lista. Nunca lanza. */
  async pushBestEffort(invoiceId: string): Promise<void> {
    try {
      const cfg = await this.resolve();
      if (!cfg) return;
      await this.push(invoiceId, cfg);
      await this.recordResult(null);
    } catch (err) {
      await this.fail(invoiceId, err);
    }
  }

  /** Envía lo pendiente: facturas, rectificativas, aprobaciones y cobros (hasta 50). */
  async backfill(): Promise<{ synced: number }> {
    const cfg = await this.resolve();
    if (!cfg) {
      throw new BadRequestException({
        code: 'holded_not_ready',
        message: 'Activa la copia en Holded y elige la serie «No enviar a Verifactu»',
      });
    }
    const pending = await this.admin.platformInvoice.findMany({
      where: PENDING_WHERE,
      select: { id: true },
      orderBy: { issuedAt: 'asc' },
      take: 50,
    });
    let synced = 0;
    for (const inv of pending) {
      try {
        await this.push(inv.id, cfg);
        synced += 1;
      } catch (err) {
        await this.fail(inv.id, err);
      }
    }
    if (synced > 0) await this.recordResult(null);
    return { synced };
  }

  /** Envíos sin confirmar: Holded no respondió y pudo crearlos. */
  async listReview(): Promise<PlatformHoldedReviewItemDto[]> {
    const before = new Date(Date.now() - REVIEW_AFTER_MS);
    const [docs, payments] = await Promise.all([
      this.admin.platformInvoice.findMany({
        where: {
          holdedSyncState: { in: [CREATING.doc, CREATING.credit] },
          holdedSyncStartedAt: { lt: before },
        },
        select: {
          id: true,
          fullNumber: true,
          total: true,
          holdedSyncState: true,
          holdedSyncStartedAt: true,
        },
        orderBy: { holdedSyncStartedAt: 'asc' },
        take: 100,
      }),
      this.admin.platformInvoice.findMany({
        where: { holdedPaymentSyncedAt: null, holdedPaymentStartedAt: { lt: before } },
        select: { id: true, fullNumber: true, total: true, holdedPaymentStartedAt: true },
        orderBy: { holdedPaymentStartedAt: 'asc' },
        take: 100,
      }),
    ]);
    return [
      ...docs.map(
        (d): PlatformHoldedReviewItemDto => ({
          kind: d.holdedSyncState === CREATING.credit ? 'credit_note' : 'invoice',
          invoiceId: d.id,
          fullNumber: d.fullNumber,
          total: Number(d.total),
          startedAt: (d.holdedSyncStartedAt ?? new Date()).toISOString(),
        }),
      ),
      ...payments.map(
        (p): PlatformHoldedReviewItemDto => ({
          kind: 'payment',
          invoiceId: p.id,
          fullNumber: p.fullNumber,
          total: Number(p.total),
          startedAt: (p.holdedPaymentStartedAt ?? new Date()).toISOString(),
        }),
      ),
    ];
  }

  /** Resuelve un envío sin confirmar tras comprobarlo en Holded. */
  async resolveReview(invoiceId: string, input: ResolvePlatformHoldedReviewInput): Promise<void> {
    let count: number;
    if (input.kind === 'payment') {
      ({ count } = await this.admin.platformInvoice.updateMany({
        where: {
          id: invoiceId,
          holdedPaymentSyncedAt: null,
          holdedPaymentStartedAt: { not: null },
        },
        data:
          input.action === 'retry'
            ? { holdedPaymentStartedAt: null }
            : { holdedPaymentSyncedAt: new Date(), holdedPaymentStartedAt: null },
      }));
    } else {
      const field = input.kind === 'credit_note' ? 'credit' : 'doc';
      if (input.action === 'already_in_holded' && !input.holdedDocumentId) {
        throw new BadRequestException({
          code: 'holded_document_id_required',
          message: 'Indica el id del documento en Holded',
        });
      }
      ({ count } = await this.admin.platformInvoice.updateMany({
        where: { id: invoiceId, holdedSyncState: CREATING[field] },
        data:
          input.action === 'retry'
            ? { holdedSyncState: null, holdedSyncStartedAt: null }
            : {
                [field === 'doc' ? 'holdedDocumentId' : 'holdedCreditNoteId']:
                  input.holdedDocumentId,
                // Ya existe en Holded: queda pendiente de aprobar (el siguiente
                // envío la aprueba; aprobar dos veces no crea nada).
                holdedSyncState: APPROVING[field],
                holdedSyncStartedAt: null,
              },
      }));
    }
    if (count === 0) {
      throw new NotFoundException({
        code: 'review_item_not_found',
        message: 'Ese envío ya no está pendiente de revisar',
      });
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Copia una factura de suscripción:
   * - factura (F1) → factura aprobada en la serie elegida + su cobro;
   * - rectificativa por diferencias (abono) → rectificativa de Holded;
   * - rectificativa por sustitución → rectificativa que anula la original en
   *   Holded + factura nueva con los datos corregidos (sin cobro: el dinero ya
   *   está registrado en la original y el abono lo compensa).
   *
   * Cada documento se reserva antes de llamar a Holded y su id se guarda antes
   * de aprobarlo: dos envíos a la vez (al emitir y «Enviar pendientes») o una
   * caída a mitad no lo duplican.
   */
  private async push(invoiceId: string, cfg: Resolved): Promise<void> {
    let inv = await this.load(invoiceId);
    if (!inv || inv.invoiceId) return; // emitida por el negocio propio: su Holded la gestiona
    // Original sustituida que nunca llegó a Holded: va la sustitutiva en su lugar.
    if (inv.invoiceType === 'F1' && inv.status === 'rectified' && !inv.holdedDocumentId) return;

    const original = inv.rectifiesInvoice;
    if (original && !original.holdedDocumentId && original.status !== 'rectified') {
      // La original va antes que su rectificativa.
      await this.push(original.id, cfg);
      inv = (await this.load(invoiceId))!;
    }

    if (inv.invoiceType === 'F1') {
      await this.ensureDocument(inv, cfg, 'doc', 'invoice', async () => ({
        contactId: await this.contactFor(cfg.client, inv!),
        date: day(inv!.issuedAt),
        seriesId: cfg.seriesId,
        description: `Factura ${inv!.fullNumber} de TrasterOS`,
        notes: `Número legal: ${inv!.fullNumber}. Emitida por TrasterOS; copia contable.`,
        lines: await this.linesFor(cfg.client, inv!, 1),
      }));
      await this.pushPayment(invoiceId, cfg);
      return;
    }

    const creditSeries = (): string => {
      if (!cfg.creditNoteSeriesId) {
        throw new Error(
          'Elige la serie de rectificativas de Holded (marcada «No enviar a Verifactu») para copiar las rectificativas',
        );
      }
      return cfg.creditNoteSeriesId;
    };
    const rectifies = original ? ` (rectifica la ${original.fullNumber})` : '';

    if (inv.correctionMethod === 'substitution') {
      // 1) Anulación de la original en Holded (si se llegó a copiar).
      if (original?.holdedDocumentId) {
        const done = await this.ensureDocument(inv, cfg, 'credit', 'creditnote', async () => ({
          contactId: await this.contactFor(cfg.client, original),
          date: day(inv!.issuedAt),
          seriesId: creditSeries(),
          description: `Anulación de la factura ${original.fullNumber}, sustituida por la ${inv!.fullNumber}`,
          notes: `Rectificativa por sustitución ${inv!.fullNumber} de TrasterOS; copia contable.`,
          // En Holded la rectificativa ya resta: líneas en positivo.
          lines: await this.linesFor(cfg.client, original, 1),
        }));
        if (!done) return;
      }
      // 2) La factura sustitutiva, con los datos corregidos.
      await this.ensureDocument(inv, cfg, 'doc', 'invoice', async () => ({
        contactId: await this.contactFor(cfg.client, inv!),
        date: day(inv!.issuedAt),
        seriesId: cfg.seriesId,
        description: `Factura rectificativa ${inv!.fullNumber} de TrasterOS${rectifies}`,
        notes: `Número legal: ${inv!.fullNumber}. Sustituye a la ${original?.fullNumber ?? 'original'}; el cobro está registrado en la original.`,
        lines: await this.linesFor(cfg.client, inv!, 1),
      }));
      return;
    }

    // Por diferencias: abono → rectificativa de Holded (sus líneas en positivo).
    await this.ensureDocument(inv, cfg, 'doc', 'creditnote', async () => ({
      contactId: await this.contactFor(cfg.client, inv!),
      date: day(inv!.issuedAt),
      seriesId: creditSeries(),
      description: `Factura rectificativa ${inv!.fullNumber} de TrasterOS${rectifies}`,
      notes: `Número legal: ${inv!.fullNumber}. Emitida por TrasterOS; copia contable.`,
      lines: await this.linesFor(cfg.client, inv!, -1),
    }));
  }

  /**
   * Crea (si falta) y aprueba un documento de Holded con reserva atómica.
   * Devuelve true si el documento queda creado y aprobado.
   */
  private async ensureDocument(
    inv: LoadedInvoice,
    cfg: Resolved,
    field: 'doc' | 'credit',
    kind: 'invoice' | 'creditnote',
    build: () => Promise<HoldedDocumentInput>,
  ): Promise<boolean> {
    const idField = field === 'doc' ? 'holdedDocumentId' : 'holdedCreditNoteId';
    const existingId = inv[idField];
    if (existingId) {
      if (inv.holdedSyncState === APPROVING[field]) {
        await this.approve(cfg.client, kind, inv.id, existingId);
      }
      return inv.holdedSyncState !== CREATING[field];
    }
    // Otro envío en curso (o pendiente de revisar): no se crea un segundo.
    if (inv.holdedSyncState) return false;
    const claimed = await this.admin.platformInvoice.updateMany({
      where: { id: inv.id, [idField]: null, holdedSyncState: null },
      data: { holdedSyncState: CREATING[field], holdedSyncStartedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    let holdedId: string;
    let sent = false;
    try {
      const input = await build();
      sent = true;
      holdedId = await cfg.client.createDocument(kind, input);
    } catch (err) {
      // Antes de llamar, o si Holded lo rechazó, no existe: se libera. Si Holded
      // no respondió, la reserva se queda y sale «para revisar» (pudo crearse).
      if (!sent || holdedRejected(err)) {
        await this.admin.platformInvoice.update({
          where: { id: inv.id },
          data: { holdedSyncState: null, holdedSyncStartedAt: null },
        });
      }
      throw err;
    }
    // Id guardado ANTES de aprobar: si la aprobación falla, el reintento solo aprueba.
    await this.admin.platformInvoice.update({
      where: { id: inv.id },
      data: { [idField]: holdedId, holdedSyncState: APPROVING[field] },
    });
    inv[idField] = holdedId;
    await this.approve(cfg.client, kind, inv.id, holdedId);
    inv.holdedSyncState = null;
    return true;
  }

  private async approve(
    client: HoldedClient,
    kind: 'invoice' | 'creditnote',
    invoiceId: string,
    holdedId: string,
  ): Promise<void> {
    await client.approveDocument(kind, holdedId);
    await this.admin.platformInvoice.update({
      where: { id: invoiceId },
      data: { holdedSyncState: null, holdedSyncStartedAt: null },
    });
  }

  /** Cobro de una factura de suscripción (siempre se emiten por un pago ya cobrado). */
  private async pushPayment(invoiceId: string, cfg: Resolved): Promise<void> {
    const inv = await this.admin.platformInvoice.findUnique({ where: { id: invoiceId } });
    if (
      !inv?.holdedDocumentId ||
      inv.holdedSyncState ||
      inv.holdedPaymentSyncedAt ||
      inv.invoiceType !== 'F1' ||
      Number(inv.total) <= 0
    ) {
      return;
    }
    const claimed = await this.admin.platformInvoice.updateMany({
      where: { id: invoiceId, holdedPaymentSyncedAt: null, holdedPaymentStartedAt: null },
      data: { holdedPaymentStartedAt: new Date() },
    });
    if (claimed.count === 0) return;
    try {
      await cfg.client.addInvoicePayment(inv.holdedDocumentId, {
        amount: Number(inv.total),
        date: day(inv.issuedAt),
        description: `Cobro de la factura ${inv.fullNumber}`,
      });
    } catch (err) {
      if (holdedRejected(err)) {
        await this.admin.platformInvoice.update({
          where: { id: invoiceId },
          data: { holdedPaymentStartedAt: null },
        });
      }
      throw err;
    }
    await this.admin.platformInvoice.update({
      where: { id: invoiceId },
      data: { holdedPaymentSyncedAt: new Date(), holdedPaymentStartedAt: null },
    });
  }

  private load(invoiceId: string) {
    return this.admin.platformInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        lines: { orderBy: { position: 'asc' } },
        rectifiesInvoice: { include: { lines: { orderBy: { position: 'asc' } } } },
      },
    });
  }

  private async contactFor(client: HoldedClient, inv: InvoiceLike): Promise<string> {
    return (
      (await client.findContact(inv.tenantTaxId ?? undefined, inv.tenantEmail ?? undefined)) ??
      (await client.createContact({
        name: inv.tenantName,
        ...(inv.tenantTaxId ? { code: inv.tenantTaxId } : {}),
        ...(inv.tenantEmail ? { email: inv.tenantEmail } : {}),
        isPerson: false,
      }))
    );
  }

  /** Líneas para Holded; `sign` -1 da la vuelta a un abono (Holded ya resta). */
  private async linesFor(
    client: HoldedClient,
    inv: InvoiceLike,
    sign: 1 | -1,
  ): Promise<HoldedLine[]> {
    if (inv.lines.length === 0) {
      return [
        {
          name: inv.concept ?? `Suscripción ${inv.planName ?? 'TrasterOS'}`,
          units: 1,
          price: round2(sign * Number(inv.baseAmount)),
          taxes: [await client.taxKeyFor(Number(inv.taxRate))],
        },
      ];
    }
    const out: HoldedLine[] = [];
    for (const l of inv.lines) {
      const qty = l.quantity || 1;
      out.push({
        name: l.description,
        units: qty,
        price: round2((sign * Number(l.baseAmount)) / qty),
        taxes: [await client.taxKeyFor(Number(l.taxRate))],
      });
    }
    return out;
  }

  private async resolve(): Promise<Resolved | null> {
    const row = await this.row();
    if (!row?.holdedEnabled || !row.holdedApiKeyEncrypted || !row.holdedInvoiceSeriesId)
      return null;
    return {
      client: new HoldedClient(this.crypto.decryptString(row.holdedApiKeyEncrypted, AAD)),
      seriesId: row.holdedInvoiceSeriesId,
      creditNoteSeriesId: row.holdedCreditNoteSeriesId,
    };
  }

  private async clientOrThrow(): Promise<HoldedClient> {
    const row = await this.row();
    if (!row?.holdedApiKeyEncrypted) {
      throw new BadRequestException({
        code: 'holded_api_key_required',
        message: 'Guarda primero la API key de Holded',
      });
    }
    return new HoldedClient(this.crypto.decryptString(row.holdedApiKeyEncrypted, AAD));
  }

  private async assertExcludedSeries(
    client: HoldedClient,
    seriesId: string,
    type: 'invoice' | 'creditnote' = 'invoice',
  ): Promise<void> {
    let series;
    try {
      series = (await client.listSeries(type)).find((s) => s.id === seriesId);
    } catch (err) {
      throw new BadRequestException({
        code: 'holded_request_failed',
        message: err instanceof Error ? err.message : 'Error consultando Holded',
      });
    }
    if (!series) {
      throw new BadRequestException({
        code: 'holded_series_not_found',
        message: 'Esa serie no existe en la cuenta de Holded',
      });
    }
    if (!series.verifactuExcluded) {
      throw new BadRequestException({
        code: 'holded_series_not_excluded',
        message: `La serie «${series.name}» no está marcada «No enviar a Verifactu» en Holded. Márcala allí para no registrar dos veces las facturas en la AEAT.`,
      });
    }
  }

  private row() {
    return this.admin.platformBillingSettings.findFirst();
  }

  private async recordResult(error: string | null): Promise<void> {
    const row = await this.row();
    if (!row) return;
    await this.admin.platformBillingSettings
      .update({
        where: { id: row.id },
        data: error
          ? { holdedLastError: error }
          : { holdedLastSyncAt: new Date(), holdedLastError: null },
      })
      .catch(() => undefined);
  }

  private async fail(invoiceId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : 'Error copiando a Holded';
    this.logger.error(`[platform-holded] factura ${invoiceId}: ${message}`);
    await this.recordResult(message);
  }
}
