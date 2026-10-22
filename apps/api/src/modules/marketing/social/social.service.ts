import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  shiftDate,
  type ConnectSocialInput,
  type SocialDailyInput,
  type SocialPageOptionDto,
  type SocialSettingsDto,
} from '@storageos/shared';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { tenantHasFeature } from '../../../common/tenant-features';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';

import { MetaGraphClient, MetaGraphError, type MetaPage } from './meta-graph.client';

/** Días que se descargan al conectar (Instagram da algunas métricas día a día). */
const INITIAL_DAYS = 30;
/** Días que se repasan cada día (Meta termina de contar 1-2 días después). */
const DAILY_DAYS = 3;
/** Publicaciones de los últimos 90 días. */
const POSTS_DAYS = 90;
/** Se guardan unos 16 meses de métricas. */
const KEEP_DAYS = 480;

const today = () => new Date().toISOString().slice(0, 10);
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

/** Mensaje claro para el tenant a partir del error de Meta. */
function readableError(err: MetaGraphError): string {
  if (err.code === 190) {
    return 'El token de Meta ha caducado o se ha revocado. Genera uno nuevo y vuelve a conectar.';
  }
  if (err.code === 10 || err.code === 200) {
    return `Al token le faltan permisos (necesita pages_show_list, pages_read_engagement, read_insights, instagram_basic e instagram_manage_insights). ${err.message}`;
  }
  return `Meta respondió: ${err.message}`;
}

/**
 * Instagram y Facebook orgánico del tenant (Web Premium): conectar la página
 * con un token de su Business Manager y descargar cada día sus métricas y
 * publicaciones.
 */
@Injectable()
export class SocialService {
  private readonly logger = new Logger(SocialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly client: MetaGraphClient,
  ) {}

  async settings(tenantId: string): Promise<SocialSettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantSocialAccount.findUnique({ where: { tenantId } }),
      tenantId,
    );
    return {
      connected: !!row,
      status: (row?.status as SocialSettingsDto['status']) ?? null,
      pageId: row?.pageId ?? null,
      pageName: row?.pageName ?? null,
      instagramUsername: row?.instagramUsername ?? null,
      lastError: row?.lastError ?? null,
      connectedAt: row?.connectedAt?.toISOString() ?? null,
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    };
  }

  /**
   * Comprueba el token, elige la página (si da acceso a varias hay que
   * indicarla) y descarga el último mes.
   */
  async connect(tenantId: string, input: ConnectSocialInput): Promise<SocialSettingsDto> {
    let pages: MetaPage[];
    try {
      pages = await this.client.pages(input.accessToken);
    } catch (err) {
      if (!(err instanceof MetaGraphError)) throw err;
      throw new BadRequestException({ code: 'social_token_invalid', message: readableError(err) });
    }
    if (pages.length === 0) {
      throw new BadRequestException({
        code: 'social_no_pages',
        message: 'El token no da acceso a ninguna página de Facebook.',
      });
    }
    const options: SocialPageOptionDto[] = pages.map((p) => ({
      id: p.id,
      name: p.name,
      instagramUsername: p.instagramUsername,
    }));
    let page = pages.length === 1 ? pages[0] : undefined;
    if (input.pageId) page = pages.find((p) => p.id === input.pageId);
    if (!page) {
      throw new BadRequestException({
        code: input.pageId ? 'social_page_not_found' : 'social_choose_page',
        message: input.pageId
          ? 'El token no da acceso a esa página.'
          : 'El token da acceso a varias páginas: elige cuál conectar.',
        details: { pages: options },
      });
    }

    const data = {
      pageId: page.id,
      pageName: page.name,
      instagramUserId: page.instagramUserId,
      instagramUsername: page.instagramUsername,
      accessTokenEncrypted: this.crypto.encryptString(page.accessToken, tenantId),
      status: 'connected',
      lastError: null,
      connectedAt: new Date(),
    };
    await this.prisma.withTenant(async (tx) => {
      const current = await tx.tenantSocialAccount.findUnique({ where: { tenantId } });
      // Otra página: lo descargado de la anterior ya no vale.
      if (current && current.pageId !== page.id) {
        await tx.socialDailyMetric.deleteMany({ where: { tenantId } });
        await tx.socialPost.deleteMany({ where: { tenantId } });
      }
      await tx.tenantSocialAccount.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: data,
      });
    }, tenantId);
    await this.sync(tenantId, INITIAL_DAYS);
    return this.settings(tenantId);
  }

  async disconnect(tenantId: string): Promise<SocialSettingsDto> {
    await this.prisma.withTenant(async (tx) => {
      await tx.socialDailyMetric.deleteMany({ where: { tenantId } });
      await tx.socialPost.deleteMany({ where: { tenantId } });
      await tx.tenantSocialAccount.deleteMany({ where: { tenantId } });
    }, tenantId);
    return this.settings(tenantId);
  }

  /**
   * Descarga los últimos `days` días y las publicaciones recientes. Un fallo
   * queda en `lastError` (no lanza).
   */
  async sync(tenantId: string, days = DAILY_DAYS): Promise<{ ok: boolean }> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantSocialAccount.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row) return { ok: false };
    const page: MetaPage = {
      id: row.pageId,
      name: row.pageName,
      accessToken: this.crypto.decryptString(row.accessTokenEncrypted, tenantId),
      instagramUserId: row.instagramUserId,
      instagramUsername: row.instagramUsername,
    };
    const end = shiftDate(today(), -1);
    const start = shiftDate(end, -(days - 1));
    try {
      const [daily, posts] = await Promise.all([
        this.client.daily(page, start, end),
        this.client.posts(page, shiftDate(today(), -POSTS_DAYS)),
      ]);
      await this.prisma.withTenant(
        async (tx) => {
          for (const d of daily) {
            const values = metricValues(d);
            await tx.socialDailyMetric.upsert({
              where: {
                tenantId_network_date: { tenantId, network: d.network, date: asDate(d.date) },
              },
              create: { tenantId, network: d.network, date: asDate(d.date), ...values },
              // Lo que Meta no devuelve hoy no borra lo que se guardó otro día.
              update: Object.fromEntries(Object.entries(values).filter(([, v]) => v != null)),
            });
          }
          for (const p of posts) {
            const { network, externalId, publishedAt, ...rest } = p;
            await tx.socialPost.upsert({
              where: { tenantId_network_externalId: { tenantId, network, externalId } },
              create: {
                tenantId,
                network,
                externalId,
                publishedAt: new Date(publishedAt),
                ...rest,
              },
              update: { publishedAt: new Date(publishedAt), ...rest },
            });
          }
          await tx.socialDailyMetric.deleteMany({
            where: { tenantId, date: { lt: asDate(shiftDate(today(), -KEEP_DAYS)) } },
          });
          await tx.socialPost.deleteMany({
            where: { tenantId, publishedAt: { lt: asDate(shiftDate(today(), -KEEP_DAYS)) } },
          });
          await tx.tenantSocialAccount.update({
            where: { tenantId },
            data: { status: 'connected', lastError: null, lastSyncedAt: new Date() },
          });
        },
        tenantId,
        { timeout: 30_000 },
      );
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof MetaGraphError
          ? readableError(err)
          : `No se pudo descargar: ${(err as Error).message}`;
      this.logger.warn(`[social] tenant ${tenantId}: ${message}`);
      await this.prisma.withTenant(
        (tx) =>
          tx.tenantSocialAccount.update({
            where: { tenantId },
            data: { status: 'error', lastError: message },
          }),
        tenantId,
      );
      return { ok: false };
    }
  }

  /** Cron diario: cuentas conectadas de tenants con Web Premium. */
  async syncAllDue(): Promise<{ tenants: number; synced: number }> {
    const rows = await this.admin.tenantSocialAccount.findMany({
      where: { tenant: { deletedAt: null } },
      select: { tenantId: true },
    });
    let synced = 0;
    for (const { tenantId } of rows) {
      if (!(await tenantHasFeature(this.admin, tenantId, 'web_premium'))) continue;
      if ((await this.sync(tenantId)).ok) synced += 1;
    }
    return { tenants: rows.length, synced };
  }
}

function metricValues(d: SocialDailyInput) {
  return {
    followers: d.followers,
    newFollowers: d.newFollowers,
    reach: d.reach,
    views: d.views,
    profileViews: d.profileViews,
    websiteClicks: d.websiteClicks,
    engagements: d.engagements,
  };
}
