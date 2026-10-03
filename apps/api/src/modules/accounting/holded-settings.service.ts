import { BadRequestException, Injectable } from '@nestjs/common';

import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaService } from '../database/prisma.service';

import { HoldedClient } from './holded.client';

import type {
  HoldedSeriesListDto,
  HoldedSettingsDto,
  HoldedTestResultDto,
  UpdateHoldedSettingsInput,
} from '@storageos/shared';

/** Ajustes resueltos para copiar documentos a Holded. */
export interface HoldedResolved {
  apiKey: string;
  invoiceSeriesId: string;
  creditNoteSeriesId: string | null;
}

/** Clave y series para que Holded EMITA las facturas (modo 'holded'). */
export interface HoldedIssuingResolved {
  apiKey: string;
  invoiceSeriesId: string;
  creditNoteSeriesId: string;
}

@Injectable()
export class HoldedSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async get(tenantId: string): Promise<Omit<HoldedSettingsDto, 'reviewCount'>> {
    const row = await this.row(tenantId);
    const hasApiKey = !!row?.apiKeyEncrypted;
    const enabled = row?.enabled ?? false;
    return {
      enabled,
      hasApiKey,
      invoiceSeriesId: row?.invoiceSeriesId ?? null,
      creditNoteSeriesId: row?.creditNoteSeriesId ?? null,
      ready: enabled && hasApiKey && !!row?.invoiceSeriesId,
      issuingInvoiceSeriesId: row?.issuingInvoiceSeriesId ?? null,
      issuingCreditNoteSeriesId: row?.issuingCreditNoteSeriesId ?? null,
      issuingReady: hasApiKey && !!row?.issuingInvoiceSeriesId && !!row?.issuingCreditNoteSeriesId,
      lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
    };
  }

  async update(
    tenantId: string,
    input: UpdateHoldedSettingsInput,
  ): Promise<Omit<HoldedSettingsDto, 'reviewCount'>> {
    const existing = await this.row(tenantId);
    if (input.enabled && !input.apiKey && !existing?.apiKeyEncrypted) {
      throw new BadRequestException({
        code: 'holded_api_key_required',
        message: 'Necesitas una API key de Holded para activar la integración',
      });
    }
    const apiKey =
      input.apiKey ??
      (existing?.apiKeyEncrypted
        ? this.crypto.decryptString(existing.apiKeyEncrypted, tenantId)
        : null);

    // Las series se comprueban en Holded: solo valen las marcadas «No enviar a
    // Verifactu». Si no, Holded registraría en la AEAT facturas que la app ya
    // registró (duplicado).
    if (
      input.invoiceSeriesId ||
      input.creditNoteSeriesId ||
      input.issuingInvoiceSeriesId ||
      input.issuingCreditNoteSeriesId
    ) {
      if (!apiKey) {
        throw new BadRequestException({
          code: 'holded_api_key_required',
          message: 'Guarda primero la API key de Holded',
        });
      }
      const client = new HoldedClient(apiKey);
      if (input.invoiceSeriesId) {
        await this.assertExcludedSeries(client, 'invoice', input.invoiceSeriesId);
      }
      if (input.creditNoteSeriesId) {
        await this.assertExcludedSeries(client, 'creditnote', input.creditNoteSeriesId);
      }
      // Las de emisión, al revés: Holded es quien registra en la AEAT.
      if (input.issuingInvoiceSeriesId) {
        await this.assertIssuingSeries(client, 'invoice', input.issuingInvoiceSeriesId);
      }
      if (input.issuingCreditNoteSeriesId) {
        await this.assertIssuingSeries(client, 'creditnote', input.issuingCreditNoteSeriesId);
      }
    }

    const apiKeyEncrypted = input.apiKey
      ? this.crypto.encryptString(input.apiKey, tenantId)
      : existing?.apiKeyEncrypted;
    const series = {
      ...(input.invoiceSeriesId !== undefined ? { invoiceSeriesId: input.invoiceSeriesId } : {}),
      ...(input.creditNoteSeriesId !== undefined
        ? { creditNoteSeriesId: input.creditNoteSeriesId }
        : {}),
      ...(input.issuingInvoiceSeriesId !== undefined
        ? { issuingInvoiceSeriesId: input.issuingInvoiceSeriesId }
        : {}),
      ...(input.issuingCreditNoteSeriesId !== undefined
        ? { issuingCreditNoteSeriesId: input.issuingCreditNoteSeriesId }
        : {}),
    };

    await this.prisma.withTenant(
      (tx) =>
        tx.holdedSettings.upsert({
          where: { tenantId },
          create: {
            tenantId,
            apiKeyEncrypted: apiKeyEncrypted ?? '',
            enabled: input.enabled,
            ...series,
          },
          update: {
            ...(apiKeyEncrypted ? { apiKeyEncrypted } : {}),
            enabled: input.enabled,
            ...series,
            // Al reconfigurar limpiamos el último error.
            ...(input.apiKey || input.invoiceSeriesId ? { lastError: null } : {}),
          },
        }),
      tenantId,
    );
    return this.get(tenantId);
  }

  /** Series de facturas y rectificativas de la cuenta de Holded. */
  async listSeries(tenantId: string): Promise<HoldedSeriesListDto> {
    const apiKey = await this.getApiKey(tenantId);
    if (!apiKey) {
      throw new BadRequestException({
        code: 'holded_api_key_required',
        message: 'Guarda primero la API key de Holded',
      });
    }
    const client = new HoldedClient(apiKey);
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

  /** Devuelve la API key descifrada, o null si no hay. */
  async getApiKey(tenantId: string): Promise<string | null> {
    const row = await this.row(tenantId);
    if (!row?.apiKeyEncrypted) return null;
    return this.crypto.decryptString(row.apiKeyEncrypted, tenantId);
  }

  /**
   * Clave y series listas para copiar documentos, o el motivo por el que no se
   * puede (integración apagada, sin clave o sin serie elegida).
   */
  async resolve(tenantId: string): Promise<HoldedResolved | { reason: string }> {
    const row = await this.row(tenantId);
    if (!row?.enabled) return { reason: 'La integración con Holded no está activa' };
    if (!row.apiKeyEncrypted) return { reason: 'Falta la API key de Holded' };
    if (!row.invoiceSeriesId) {
      return {
        reason:
          'Elige en Ajustes la serie de Holded marcada «No enviar a Verifactu» donde copiar las facturas',
      };
    }
    return {
      apiKey: this.crypto.decryptString(row.apiKeyEncrypted, tenantId),
      invoiceSeriesId: row.invoiceSeriesId,
      creditNoteSeriesId: row.creditNoteSeriesId,
    };
  }

  /**
   * Clave y series para que Holded emita las facturas, o el motivo por el que
   * no puede (no depende del interruptor de la copia contable).
   */
  async resolveIssuing(tenantId: string): Promise<HoldedIssuingResolved | { reason: string }> {
    const row = await this.row(tenantId);
    if (!row?.apiKeyEncrypted) return { reason: 'Falta la API key de Holded' };
    if (!row.issuingInvoiceSeriesId || !row.issuingCreditNoteSeriesId) {
      return {
        reason:
          'Elige en Ajustes → Facturación las series de Holded donde emitir las facturas y las rectificativas',
      };
    }
    return {
      apiKey: this.crypto.decryptString(row.apiKeyEncrypted, tenantId),
      invoiceSeriesId: row.issuingInvoiceSeriesId,
      creditNoteSeriesId: row.issuingCreditNoteSeriesId,
    };
  }

  async recordResult(tenantId: string, error: string | null): Promise<void> {
    await this.prisma
      .withTenant(
        (tx) =>
          tx.holdedSettings.update({
            where: { tenantId },
            data: error ? { lastError: error } : { lastSyncAt: new Date(), lastError: null },
          }),
        tenantId,
      )
      .catch(() => undefined);
  }

  async test(tenantId: string): Promise<HoldedTestResultDto> {
    const apiKey = await this.getApiKey(tenantId);
    if (!apiKey) {
      return { ok: false, message: 'No hay API key configurada' };
    }
    try {
      await new HoldedClient(apiKey).testConnection();
      return { ok: true, message: 'Conexión correcta con Holded' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Error de conexión' };
    }
  }

  private row(tenantId: string) {
    return this.prisma.withTenant(
      (tx) => tx.holdedSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
  }

  private async findSeries(client: HoldedClient, type: 'invoice' | 'creditnote', seriesId: string) {
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
        message: 'Esa serie no existe en tu cuenta de Holded',
      });
    }
    return series;
  }

  private async assertIssuingSeries(
    client: HoldedClient,
    type: 'invoice' | 'creditnote',
    seriesId: string,
  ): Promise<void> {
    const series = await this.findSeries(client, type, seriesId);
    if (series.verifactuExcluded) {
      throw new BadRequestException({
        code: 'holded_series_excluded',
        message: `La serie «${series.name}» está marcada «No enviar a Verifactu»: si Holded emite tus facturas, deben ir a Veri*Factu. Elige otra serie.`,
      });
    }
  }

  private async assertExcludedSeries(
    client: HoldedClient,
    type: 'invoice' | 'creditnote',
    seriesId: string,
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
        message: 'Esa serie no existe en tu cuenta de Holded',
      });
    }
    if (!series.verifactuExcluded) {
      throw new BadRequestException({
        code: 'holded_series_not_excluded',
        message: `La serie «${series.name}» no está marcada «No enviar a Verifactu» en Holded. Márcala allí (Configuración → Numeración) para no registrar dos veces las facturas en la AEAT.`,
      });
    }
  }
}
