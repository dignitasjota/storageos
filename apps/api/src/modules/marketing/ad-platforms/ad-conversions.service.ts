import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import { AdClickIdsSchema } from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';

import { type AdConversionPlatform } from './ad-conversion-stats';
import { GoogleAdsSettingsService } from './google-ads-settings.service';
import { GoogleAdsClient } from './google-ads.client';
import { MetaAdsSettingsService } from './meta-ads-settings.service';
import { MetaAdsClient } from './meta-ads.client';

/** Se mandan los contratos firmados en los últimos 7 días (Meta no acepta más antiguos). */
const LOOKBACK_DAYS = 7;
/** Sin llamar a Google ni a Meta en las pruebas o con el modo simulado. */
const stubMode = () =>
  process.env.NODE_ENV === 'test' || process.env.AD_CONVERSIONS_MODE === 'stub';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Devuelve a Google Ads y a Meta los contratos firmados de quien llegó por un
 * anuncio (con el identificador del clic, que solo se guarda si el visitante
 * aceptó todas las cookies): así la plataforma sabe qué anuncios traen
 * clientes y no solo clics. Un envío por contrato y plataforma
 * (`ad_conversion_uploads`); el valor es la cuota mensual sin IVA.
 */
@Injectable()
export class AdConversionsService {
  private readonly logger = new Logger(AdConversionsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly google: GoogleAdsSettingsService,
    private readonly meta: MetaAdsSettingsService,
  ) {}

  /** Todos los negocios con la devolución configurada. */
  async runAll(now = new Date()): Promise<{ sent: number; failed: number }> {
    const [g, m] = await Promise.all([
      this.admin.googleAdsSettings.findMany({
        where: { enabled: true, conversionActionId: { not: null } },
        select: { tenantId: true },
      }),
      this.admin.metaAdsSettings.findMany({
        where: { enabled: true, pixelId: { not: null } },
        select: { tenantId: true },
      }),
    ]);
    const totals = { sent: 0, failed: 0 };
    for (const tenantId of new Set([...g, ...m].map((r) => r.tenantId))) {
      try {
        const r = await this.runTenant(tenantId, now);
        totals.sent += r.sent;
        totals.failed += r.failed;
      } catch (err) {
        this.logger.warn(`[ad-conversions] ${tenantId}: ${(err as Error).message}`);
      }
    }
    return totals;
  }

  async runTenant(tenantId: string, now = new Date()): Promise<{ sent: number; failed: number }> {
    const result = { sent: 0, failed: 0 };
    const [google, meta] = await Promise.all([
      this.google.getConversionTarget(tenantId),
      this.meta.getConversionTarget(tenantId),
    ]);
    if (!google && !meta) return result;
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
    const leads = await this.prisma.withTenant(
      (tx) =>
        tx.lead.findMany({
          where: {
            deletedAt: null,
            clickIds: { not: Prisma.AnyNull },
            convertedContract: {
              deletedAt: null,
              status: { not: 'cancelled' },
              signedAt: { gte: since },
            },
          },
          select: {
            email: true,
            phone: true,
            clickIds: true,
            convertedContract: {
              select: {
                id: true,
                signedAt: true,
                priceMonthly: true,
                discountAmount: true,
                adConversionUploads: { select: { platform: true } },
              },
            },
          },
        }),
      tenantId,
    );
    const seen = new Set<string>();
    for (const lead of leads) {
      const contract = lead.convertedContract;
      if (!contract?.signedAt || seen.has(contract.id)) continue;
      seen.add(contract.id);
      const ids = AdClickIdsSchema.safeParse(lead.clickIds);
      if (!ids.success) continue;
      const click = ids.data;
      const done = new Set(contract.adConversionUploads.map((u) => u.platform));
      const value = round2(
        Math.max(0, Number(contract.priceMonthly) - Number(contract.discountAmount)),
      );
      if (google && !done.has('google_ads') && (click.gclid || click.gbraid || click.wbraid)) {
        const ok = await this.send(tenantId, contract.id, 'google_ads', value, async () => {
          if (stubMode()) {
            if ((click.gclid ?? click.gbraid ?? click.wbraid)!.startsWith('fail')) {
              throw new Error('Google Ads: clic no reconocido (simulado)');
            }
            return;
          }
          await new GoogleAdsClient(google.credentials).uploadClickConversion({
            conversionActionId: google.conversionActionId,
            gclid: click.gclid,
            gbraid: click.gbraid,
            wbraid: click.wbraid,
            conversionDateTime: contract.signedAt!,
            value,
            currency: 'EUR',
            orderId: contract.id,
          });
        });
        if (ok !== null) result[ok ? 'sent' : 'failed'] += 1;
      }
      if (meta && !done.has('meta') && click.fbclid) {
        const ok = await this.send(tenantId, contract.id, 'meta', value, async () => {
          if (stubMode()) {
            if (click.fbclid!.startsWith('fail')) {
              throw new Error('Meta Ads: píxel no válido (simulado)');
            }
            return;
          }
          await new MetaAdsClient(meta.credentials).sendConversion({
            pixelId: meta.pixelId,
            eventId: contract.id,
            eventTime: contract.signedAt!,
            value,
            currency: 'EUR',
            email: lead.email,
            phone: lead.phone,
            fbclid: click.fbclid ?? null,
            clickAt: click.at ?? null,
          });
        });
        if (ok !== null) result[ok ? 'sent' : 'failed'] += 1;
      }
    }
    return result;
  }

  /**
   * Reserva el envío (uno por contrato y plataforma, aunque haya dos procesos)
   * y lo hace. null si otro proceso ya lo había reservado.
   */
  private async send(
    tenantId: string,
    contractId: string,
    platform: AdConversionPlatform,
    value: number,
    run: () => Promise<void>,
  ): Promise<boolean | null> {
    const claim = await this.prisma
      .withTenant(
        (tx) =>
          tx.adConversionUpload.create({
            data: { tenantId, contractId, platform, status: 'pending', value },
            select: { id: true },
          }),
        tenantId,
      )
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return null;
        }
        throw err;
      });
    if (!claim) return null;
    let error: string | null = null;
    try {
      await run();
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.adConversionUpload.update({
          where: { id: claim.id },
          data: error
            ? { status: 'failed', error }
            : { status: 'sent', sentAt: new Date(), error: null },
        }),
      tenantId,
    );
    return !error;
  }
}
