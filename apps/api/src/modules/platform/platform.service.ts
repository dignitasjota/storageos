import { Injectable } from '@nestjs/common';
import { DEFAULT_LEGAL_DOCUMENTS } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  LegalDocumentDto,
  LegalSlug,
  PlatformBannerDto,
  SuperAdminNotificationDto,
  UpdateLegalDocumentInput,
  UpdatePlatformBannerInput,
} from '@storageos/shared';

/** Banner global + feed de notificaciones del super admin. */
@Injectable()
export class PlatformService {
  constructor(private readonly admin: PrismaAdminService) {}

  // ---- banner global ----

  async getBanner(): Promise<PlatformBannerDto> {
    let row = await this.admin.platformBanner.findFirst();
    row ??= await this.admin.platformBanner.create({ data: {} });
    return {
      message: row.message,
      level: row.level as PlatformBannerDto['level'],
      enabled: row.enabled,
    };
  }

  /** Banner que ve el tenant: solo si está activo y tiene mensaje. */
  async getPublicBanner(): Promise<PlatformBannerDto | null> {
    const row = await this.admin.platformBanner.findFirst();
    if (!row?.enabled || !row.message.trim()) return null;
    return { message: row.message, level: row.level as PlatformBannerDto['level'], enabled: true };
  }

  async updateBanner(input: UpdatePlatformBannerInput): Promise<PlatformBannerDto> {
    const existing = await this.admin.platformBanner.findFirst();
    const data = { message: input.message, level: input.level, enabled: input.enabled };
    const row = existing
      ? await this.admin.platformBanner.update({ where: { id: existing.id }, data })
      : await this.admin.platformBanner.create({ data });
    return {
      message: row.message,
      level: row.level as PlatformBannerDto['level'],
      enabled: row.enabled,
    };
  }

  // ---- notificaciones del super admin ----

  /** Crea una notificación en el feed del super admin (best-effort). */
  async notify(input: {
    type: string;
    title: string;
    body?: string;
    link?: string;
  }): Promise<void> {
    await this.admin.superAdminNotification
      .create({
        data: {
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          link: input.link ?? null,
        },
      })
      .catch(() => undefined);
  }

  async listNotifications(): Promise<SuperAdminNotificationDto[]> {
    const rows = await this.admin.superAdminNotification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async unreadCount(): Promise<{ count: number }> {
    const count = await this.admin.superAdminNotification.count({ where: { readAt: null } });
    return { count };
  }

  async markAllRead(): Promise<void> {
    await this.admin.superAdminNotification.updateMany({
      where: { readAt: null },
      data: { readAt: new Date() },
    });
  }

  // ---- documentos legales (términos, privacidad) ----

  /**
   * Documento legal por slug. Si no se ha guardado nunca en BD, devuelve el
   * contenido por defecto (el redactado en `@storageos/shared`) con
   * `updatedAt: null`, para que la landing siempre tenga texto que mostrar.
   */
  async getLegal(slug: LegalSlug): Promise<LegalDocumentDto> {
    const row = await this.admin.platformLegalDocument.findUnique({ where: { slug } });
    if (row) {
      return {
        slug,
        title: row.title,
        content: row.content,
        updatedAt: row.updatedAt.toISOString(),
      };
    }
    const def = DEFAULT_LEGAL_DOCUMENTS[slug];
    return { slug, title: def.title, content: def.content, updatedAt: null };
  }

  async updateLegal(slug: LegalSlug, input: UpdateLegalDocumentInput): Promise<LegalDocumentDto> {
    const row = await this.admin.platformLegalDocument.upsert({
      where: { slug },
      create: { slug, title: input.title, content: input.content },
      update: { title: input.title, content: input.content },
    });
    return {
      slug,
      title: row.title,
      content: row.content,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
