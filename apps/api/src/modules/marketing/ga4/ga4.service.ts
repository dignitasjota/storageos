import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  WEB_ANALYTICS_DAYS,
  shiftDate,
  summarizeGa4,
  type Ga4ReportDto,
  type Ga4SettingsDto,
  type Ga4Status,
} from '@storageos/shared';

import { tenantHasFeature } from '../../../common/tenant-features';
import { PrismaAdminService } from '../../database/prisma-admin.service';
import { PrismaService } from '../../database/prisma.service';

import { Ga4Client } from './ga4.client';

/** Días que se descargan al conectar la propiedad. */
const INITIAL_DAYS = 120;
/** Días que se repasan cada día (GA4 termina de procesar 1-2 días después). */
const DAILY_DAYS = 6;
/** Se guardan unos 16 meses. */
const KEEP_DAYS = 480;

const today = () => new Date().toISOString().slice(0, 10);
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

/**
 * Google Analytics 4 de la web del tenant (Web Premium): conectar la
 * propiedad, descargar cada día sesiones por origen y páginas, y resumirlas.
 */
@Injectable()
export class Ga4Service {
  private readonly logger = new Logger(Ga4Service.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly client: Ga4Client,
  ) {}

  async settings(tenantId: string): Promise<Ga4SettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantGa4.findUnique({ where: { tenantId } }),
      tenantId,
    );
    return {
      available: this.client.available,
      serviceAccountEmail: this.client.serviceAccountEmail,
      propertyId: row?.propertyId ?? null,
      status: (row?.status as Ga4Status | undefined) ?? null,
      lastError: row?.lastError ?? null,
      connectedAt: row?.connectedAt?.toISOString() ?? null,
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    };
  }

  /** Guarda la propiedad, comprueba el acceso y descarga los últimos meses. */
  async connect(tenantId: string, propertyId: string): Promise<Ga4SettingsDto> {
    if (!this.client.available) {
      throw new ServiceUnavailableException({
        code: 'ga4_not_configured',
        message: 'La conexión con Google Analytics no está disponible todavía.',
      });
    }
    const denied = await this.client.checkAccess(propertyId);
    const lastError = denied
      ? `Nuestra cuenta (${this.client.serviceAccountEmail}) no puede leer la propiedad ${propertyId}. Añádela como «Lector» en Google Analytics → Administrar → Gestión del acceso a la propiedad. (${denied})`
      : null;
    const data = {
      propertyId,
      status: denied ? 'error' : 'connected',
      lastError,
      connectedAt: denied ? null : new Date(),
    };
    await this.prisma.withTenant(async (tx) => {
      const current = await tx.tenantGa4.findUnique({ where: { tenantId } });
      // Otra propiedad: lo descargado de la anterior ya no vale.
      if (current && current.propertyId !== propertyId) {
        await tx.ga4SourceRow.deleteMany({ where: { tenantId } });
        await tx.ga4PageRow.deleteMany({ where: { tenantId } });
      }
      await tx.tenantGa4.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: data,
      });
    }, tenantId);
    if (denied) {
      throw new BadRequestException({ code: 'ga4_no_access', message: lastError });
    }
    await this.sync(tenantId, INITIAL_DAYS);
    return this.settings(tenantId);
  }

  async disconnect(tenantId: string): Promise<Ga4SettingsDto> {
    await this.prisma.withTenant(async (tx) => {
      await tx.ga4SourceRow.deleteMany({ where: { tenantId } });
      await tx.ga4PageRow.deleteMany({ where: { tenantId } });
      await tx.tenantGa4.deleteMany({ where: { tenantId } });
    }, tenantId);
    return this.settings(tenantId);
  }

  /**
   * Descarga los últimos `days` días y sustituye lo guardado de ese tramo.
   * Un fallo queda en `lastError` (no lanza).
   */
  async sync(tenantId: string, days = DAILY_DAYS): Promise<{ ok: boolean }> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantGa4.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row) return { ok: false };
    const end = shiftDate(today(), -1);
    const start = shiftDate(end, -(days - 1));
    try {
      const [sources, pages] = await Promise.all([
        this.client.sourceRows(row.propertyId, start, end),
        this.client.pageRows(row.propertyId, start, end),
      ]);
      await this.prisma.withTenant(
        async (tx) => {
          const stale = {
            tenantId,
            OR: [
              { date: { gte: asDate(start) } },
              { date: { lt: asDate(shiftDate(today(), -KEEP_DAYS)) } },
            ],
          };
          await tx.ga4SourceRow.deleteMany({ where: stale });
          await tx.ga4PageRow.deleteMany({ where: stale });
          if (sources.length > 0) {
            await tx.ga4SourceRow.createMany({
              data: sources.map((r) => ({ tenantId, ...r, date: asDate(r.date) })),
              skipDuplicates: true,
            });
          }
          if (pages.length > 0) {
            await tx.ga4PageRow.createMany({
              data: pages.map((r) => ({ tenantId, ...r, date: asDate(r.date) })),
              skipDuplicates: true,
            });
          }
          await tx.tenantGa4.update({
            where: { tenantId },
            data: { status: 'connected', lastError: null, lastSyncedAt: new Date() },
          });
        },
        tenantId,
        { timeout: 60_000 },
      );
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[ga4] tenant ${tenantId}: ${message}`);
      await this.prisma.withTenant(
        (tx) =>
          tx.tenantGa4.update({
            where: { tenantId },
            data: { status: 'error', lastError: message.slice(0, 500) },
          }),
        tenantId,
      );
      return { ok: false };
    }
  }

  /** Cron diario: todos los tenants conectados que tienen Web Premium. */
  async syncAllDue(): Promise<{ tenants: number; synced: number }> {
    const rows = await this.admin.tenantGa4.findMany({
      where: { status: { in: ['connected', 'error'] } },
      select: { tenantId: true },
    });
    let synced = 0;
    for (const { tenantId } of rows) {
      if (!(await tenantHasFeature(this.admin, tenantId, 'web_premium'))) continue;
      if ((await this.sync(tenantId)).ok) synced += 1;
    }
    return { tenants: rows.length, synced };
  }

  /** Resumen de los últimos 7, 30 o 90 días (hasta ayer) frente al periodo anterior. */
  async report(tenantId: string, daysInput: number): Promise<Ga4ReportDto> {
    const days = (WEB_ANALYTICS_DAYS as readonly number[]).includes(daysInput) ? daysInput : 30;
    const to = shiftDate(today(), -1);
    const since = asDate(shiftDate(to, -(days * 2 - 1)));
    const [sources, pages] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.ga4SourceRow.findMany({ where: { date: { gte: since } } }),
          tx.ga4PageRow.findMany({ where: { date: { gte: since } } }),
        ]),
      tenantId,
    );
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return summarizeGa4(
      sources.map((r) => ({
        date: day(r.date),
        source: r.source,
        medium: r.medium,
        campaign: r.campaign,
        device: r.device,
        sessions: r.sessions,
        engagedSessions: r.engagedSessions,
        pageViews: r.pageViews,
        keyEvents: r.keyEvents,
      })),
      pages.map((r) => ({
        date: day(r.date),
        pagePath: r.pagePath,
        pageViews: r.pageViews,
        sessions: r.sessions,
      })),
      days,
      to,
    );
  }
}
