import { Injectable, Logger } from '@nestjs/common';
import {
  SEO_SISTRIX_DATA_TYPES,
  SEO_SISTRIX_DEFAULT_FREQUENCIES,
  SEO_SISTRIX_DEFAULT_LIMITS,
  madridInstant,
  madridToday,
  sistrixWeekStart,
  type SeoSistrixDataType,
  type SeoSyncFrequency,
  type SeoSyncSettingsDto,
  type UpdateSeoSyncSettingsInput,
} from '@storageos/shared';

import { CryptoService } from '../../../common/crypto/crypto.service';
import { isUniqueViolation } from '../../../common/prisma-errors';
import { PlatformAlertsService } from '../../admin/platform-alerts.service';
import { PrismaAdminService } from '../../database/prisma-admin.service';

import type { Prisma, SeoProviderConnection } from '@storageos/database';

/** Fondo de datos: null = la conexión de la plataforma; un id = la clave de ese tenant. */
export type SeoPool = string | null;
export type SistrixProvider = 'sistrix_mcp' | 'sistrix_api';

export const poolLabel = (pool: SeoPool) => pool ?? 'platform';

/**
 * Conexiones con SISTRIX (filas de `seo_provider_connections`) y ajustes de
 * cada fondo. Todo con la conexión de administración y filtrando siempre por
 * el dueño. Los secretos se cifran con AES-GCM ligados a su fondo y campo.
 */
@Injectable()
export class SistrixConnectionsService {
  private readonly logger = new Logger(SistrixConnectionsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly alerts: PlatformAlertsService,
  ) {}

  // ----------------------------------------------------------- cifrado

  private aad(pool: SeoPool, provider: SistrixProvider, field: string): string {
    return `seo-provider:${poolLabel(pool)}:${provider}:${field}`;
  }

  encrypt(pool: SeoPool, provider: SistrixProvider, field: string, value: string): string {
    return this.crypto.encryptString(value, this.aad(pool, provider, field));
  }

  decrypt(pool: SeoPool, provider: SistrixProvider, field: string, envelope: string): string {
    return this.crypto.decryptString(envelope, this.aad(pool, provider, field));
  }

  // --------------------------------------------------------- conexiones

  find(pool: SeoPool, provider: SistrixProvider): Promise<SeoProviderConnection | null> {
    return this.admin.seoProviderConnection.findFirst({ where: { tenantId: pool, provider } });
  }

  /** La fila de la conexión (se crea la primera vez). */
  async ensure(pool: SeoPool, provider: SistrixProvider): Promise<SeoProviderConnection> {
    const existing = await this.find(pool, provider);
    if (existing) return existing;
    try {
      return await this.admin.seoProviderConnection.create({
        data: { tenantId: pool, provider },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.find(pool, provider);
      if (!raced) throw err;
      return raced;
    }
  }

  update(
    id: string,
    data: Prisma.SeoProviderConnectionUpdateInput,
  ): Promise<SeoProviderConnection> {
    return this.admin.seoProviderConnection.update({ where: { id }, data });
  }

  /** Clave de la API de un fondo (descifrada) si está puesta. */
  apiKeyOf(conn: SeoProviderConnection | null): string | null {
    if (!conn?.apiKeyEncrypted) return null;
    return this.decrypt(conn.tenantId, 'sistrix_api', 'api_key', conn.apiKeyEncrypted);
  }

  // ------------------------------------------------------- presupuesto

  /** Créditos gastados esta semana (si la guardada es de otra semana, 0). */
  weekSpent(
    conn: Pick<SeoProviderConnection, 'weekStart' | 'weekSpent'>,
    now = new Date(),
  ): number {
    const current = sistrixWeekStart(now);
    const stored = conn.weekStart ? conn.weekStart.toISOString().slice(0, 10) : null;
    return stored === current ? conn.weekSpent : 0;
  }

  /** Suma los créditos de una respuesta al gasto de la semana (atómico, con cambio de semana). */
  async addSpent(connId: string, credits: number, now = new Date()): Promise<void> {
    if (credits <= 0) return;
    const week = sistrixWeekStart(now);
    await this.admin.$executeRaw`
      UPDATE "seo_provider_connections"
         SET "week_spent" = CASE WHEN "week_start" = ${week}::date THEN "week_spent" + ${credits} ELSE ${credits} END,
             "week_start" = ${week}::date,
             "updated_at" = now()
       WHERE "id" = ${connId}::uuid`;
  }

  // ----------------------------------------------------------- avisos

  /** Aviso al super admin: notificación en el panel y correo a los de Alertas. */
  async notifySuperAdmin(type: string, title: string, body: string): Promise<void> {
    await this.admin.superAdminNotification
      .create({ data: { type, title, body, link: '/admin/seo/integrations' } })
      .catch((err: unknown) => this.logger.warn(`Aviso SEO: ${(err as Error).message}`));
    await this.alerts
      .emailAdmins({
        kind: 'seo',
        subject: `[TrasterOS] ${title}`,
        html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
        text: body,
      })
      .catch((err: unknown) => this.logger.warn(`Aviso SEO por correo: ${(err as Error).message}`));
  }

  // ----------------------------------------------------------- ajustes

  async settingsRow(pool: SeoPool) {
    const row = await this.admin.seoSyncSettings.findFirst({ where: { tenantId: pool } });
    if (row) return row;
    try {
      return await this.admin.seoSyncSettings.create({
        data: {
          tenantId: pool,
          maxRequestsPerDay: SEO_SISTRIX_DEFAULT_LIMITS.maxRequestsPerDay,
          maxRequestsPerBatch: SEO_SISTRIX_DEFAULT_LIMITS.maxRequestsPerBatch,
          pauseMs: SEO_SISTRIX_DEFAULT_LIMITS.pauseMs,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return (await this.admin.seoSyncSettings.findFirst({ where: { tenantId: pool } }))!;
    }
  }

  frequenciesOf(raw: unknown): Record<SeoSistrixDataType, SeoSyncFrequency> {
    const stored = (raw && typeof raw === 'object' ? raw : {}) as Partial<
      Record<SeoSistrixDataType, SeoSyncFrequency>
    >;
    return Object.fromEntries(
      SEO_SISTRIX_DATA_TYPES.map((t) => [t, stored[t] ?? SEO_SISTRIX_DEFAULT_FREQUENCIES[t]]),
    ) as Record<SeoSistrixDataType, SeoSyncFrequency>;
  }

  /** Consultas reales (no las servidas de la caché) de hoy en el fondo. */
  async requestsToday(pool: SeoPool, now = new Date()): Promise<number> {
    return this.admin.seoApiRequest.count({
      where: {
        tenantId: pool,
        status: { not: 'cached' },
        createdAt: { gte: madridInstant(madridToday(now), 0, 0) },
      },
    });
  }

  async settings(pool: SeoPool): Promise<SeoSyncSettingsDto> {
    const row = await this.settingsRow(pool);
    return {
      frequencies: this.frequenciesOf(row.frequencies),
      maxRequestsPerDay: row.maxRequestsPerDay,
      maxRequestsPerBatch: row.maxRequestsPerBatch,
      pauseMs: row.pauseMs,
      requestsToday: await this.requestsToday(pool),
    };
  }

  async updateSettings(
    pool: SeoPool,
    input: UpdateSeoSyncSettingsInput,
  ): Promise<SeoSyncSettingsDto> {
    const row = await this.settingsRow(pool);
    const frequencies = input.frequencies
      ? {
          ...(row.frequencies as Record<string, string>),
          ...Object.fromEntries(
            Object.entries(input.frequencies).filter(([, v]) => v !== undefined),
          ),
        }
      : undefined;
    await this.admin.seoSyncSettings.update({
      where: { id: row.id },
      data: {
        ...(frequencies ? { frequencies } : {}),
        ...(input.maxRequestsPerDay !== undefined
          ? { maxRequestsPerDay: input.maxRequestsPerDay }
          : {}),
        ...(input.maxRequestsPerBatch !== undefined
          ? { maxRequestsPerBatch: input.maxRequestsPerBatch }
          : {}),
        ...(input.pauseMs !== undefined ? { pauseMs: input.pauseMs } : {}),
      },
    });
    return this.settings(pool);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
