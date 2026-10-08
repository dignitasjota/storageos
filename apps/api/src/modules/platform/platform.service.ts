import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { DEFAULT_LEGAL_DOCUMENTS } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type {
  LegalDocumentDto,
  LegalSlug,
  PlatformBannerDto,
  PlatformFounderOfferDto,
  PlatformLogoUploadDto,
  PlatformWebsiteDto,
  SuperAdminNotificationDto,
  UpdateLegalDocumentInput,
  UpdatePlatformBannerInput,
  UpdatePlatformFounderOfferInput,
} from '@storageos/shared';

/** Banner global + feed de notificaciones del super admin. */
@Injectable()
export class PlatformService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
  ) {}

  // ---- web de TrasterOS: logo ----

  private static readonly LOGO_PREFIX = 'platform/logo/';

  async getWebsite(): Promise<PlatformWebsiteDto> {
    const row = await this.admin.platformWebsite.findFirst();
    return {
      logoUrl: row?.logoKey ? this.files.buildPublicUrl('public', row.logoKey) : null,
    };
  }

  /** URL firmada para subir el logo directo al bucket público. */
  async requestLogoUpload(mimeType: string): Promise<PlatformLogoUploadDto> {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const key = `${PlatformService.LOGO_PREFIX}${randomUUID()}.${ext}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': mimeType } };
  }

  async setLogo(key: string | null): Promise<PlatformWebsiteDto> {
    if (key && (!key.startsWith(PlatformService.LOGO_PREFIX) || key.includes('..'))) {
      throw new BadRequestException({ code: 'invalid_logo_key', message: 'Logo no válido' });
    }
    const existing = await this.admin.platformWebsite.findFirst();
    if (existing) {
      await this.admin.platformWebsite.update({
        where: { id: existing.id },
        data: { logoKey: key },
      });
    } else {
      await this.admin.platformWebsite.create({ data: { logoKey: key } });
    }
    return this.getWebsite();
  }

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

  // ---- oferta fundador de la web de TrasterOS ----

  async getFounderOffer(): Promise<PlatformFounderOfferDto> {
    let row = await this.admin.platformFounderOffer.findFirst();
    row ??= await this.admin.platformFounderOffer.create({ data: {} });
    return toFounderOfferDto(row);
  }

  /** La que se ve en la web: solo si está activada. */
  async getPublicFounderOffer(): Promise<PlatformFounderOfferDto | null> {
    const row = await this.admin.platformFounderOffer.findFirst();
    return row?.enabled ? toFounderOfferDto(row) : null;
  }

  async updateFounderOffer(
    input: UpdatePlatformFounderOfferInput,
  ): Promise<PlatformFounderOfferDto> {
    const existing = await this.admin.platformFounderOffer.findFirst();
    const row = existing
      ? await this.admin.platformFounderOffer.update({ where: { id: existing.id }, data: input })
      : await this.admin.platformFounderOffer.create({ data: input });
    return toFounderOfferDto(row);
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

function toFounderOfferDto(row: {
  enabled: boolean;
  title: string;
  text: string;
  setupStrike: string;
  setupText: string;
}): PlatformFounderOfferDto {
  return {
    enabled: row.enabled,
    title: row.title,
    text: row.text,
    setupStrike: row.setupStrike,
    setupText: row.setupText,
  };
}
