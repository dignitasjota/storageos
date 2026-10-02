import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service';
import { HoldedClient, type HoldedLine } from '../accounting/holded.client';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  HoldedSeriesListDto,
  HoldedTestResultDto,
  PlatformHoldedSettingsDto,
  UpdatePlatformHoldedSettingsInput,
} from '@storageos/shared';

/** Contexto del cifrado de la clave de Holded de la plataforma. */
const AAD = 'platform-holded';
const day = (d: Date): string => d.toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Copia contable en Holded de las facturas de suscripción de la plataforma
 * (TrasterOS → tenants). Como en la integración de los tenants, la app emite la
 * factura y Holded solo la contabiliza: se crea en una serie de Holded marcada
 * «No enviar a Verifactu», aprobada y con su cobro (las facturas de suscripción
 * se emiten siempre por un pago ya cobrado). Desactivada hasta contratar Holded.
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
    const pendingCount = await this.admin.platformInvoice.count({
      where: { holdedDocumentId: null, invoiceType: 'F1' },
    });
    return {
      enabled,
      hasApiKey,
      invoiceSeriesId: row?.holdedInvoiceSeriesId ?? null,
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

  /** Envía las facturas de suscripción aún sin copiar (hasta 50 por llamada). */
  async backfill(): Promise<{ synced: number }> {
    const cfg = await this.resolve();
    if (!cfg) {
      throw new BadRequestException({
        code: 'holded_not_ready',
        message: 'Activa la copia en Holded y elige la serie «No enviar a Verifactu»',
      });
    }
    const pending = await this.admin.platformInvoice.findMany({
      where: { holdedDocumentId: null, invoiceType: 'F1' },
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

  // ---------------------------------------------------------------------------

  private async push(
    invoiceId: string,
    cfg: { client: HoldedClient; seriesId: string },
  ): Promise<void> {
    const inv = await this.admin.platformInvoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
    // Las rectificativas de suscripción aún no se copian (necesitan una serie
    // de rectificativas en Holded): se contabilizan desde la exportación.
    if (!inv || inv.holdedDocumentId || inv.invoiceType !== 'F1') return;
    const { client } = cfg;

    const contactId =
      (await client.findContact(inv.tenantTaxId ?? undefined, inv.tenantEmail ?? undefined)) ??
      (await client.createContact({
        name: inv.tenantName,
        ...(inv.tenantTaxId ? { code: inv.tenantTaxId } : {}),
        ...(inv.tenantEmail ? { email: inv.tenantEmail } : {}),
        isPerson: false,
      }));

    const lines: HoldedLine[] = [];
    if (inv.lines.length > 0) {
      for (const l of inv.lines) {
        const qty = l.quantity || 1;
        lines.push({
          name: l.description,
          units: qty,
          price: round2(Number(l.baseAmount) / qty),
          taxes: [await client.taxKeyFor(Number(l.taxRate))],
        });
      }
    } else {
      lines.push({
        name: inv.concept ?? `Suscripción ${inv.planName ?? 'TrasterOS'}`,
        units: 1,
        price: Number(inv.baseAmount),
        taxes: [await client.taxKeyFor(Number(inv.taxRate))],
      });
    }

    const holdedId = await client.createDocument('invoice', {
      contactId,
      date: day(inv.issuedAt),
      seriesId: cfg.seriesId,
      description: `Factura ${inv.fullNumber} de TrasterOS`,
      notes: `Número legal: ${inv.fullNumber}. Emitida por TrasterOS; copia contable.`,
      lines,
    });
    await client.approveDocument('invoice', holdedId);
    await this.admin.platformInvoice.update({
      where: { id: inv.id },
      data: { holdedDocumentId: holdedId },
    });
    // Las facturas de suscripción se emiten por un pago ya cobrado.
    await client.addInvoicePayment(holdedId, {
      amount: Number(inv.total),
      date: day(inv.issuedAt),
      description: `Cobro de la factura ${inv.fullNumber}`,
    });
  }

  private async resolve(): Promise<{ client: HoldedClient; seriesId: string } | null> {
    const row = await this.row();
    if (!row?.holdedEnabled || !row.holdedApiKeyEncrypted || !row.holdedInvoiceSeriesId)
      return null;
    return {
      client: new HoldedClient(this.crypto.decryptString(row.holdedApiKeyEncrypted, AAD)),
      seriesId: row.holdedInvoiceSeriesId,
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

  private async assertExcludedSeries(client: HoldedClient, seriesId: string): Promise<void> {
    let series;
    try {
      series = (await client.listSeries('invoice')).find((s) => s.id === seriesId);
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
