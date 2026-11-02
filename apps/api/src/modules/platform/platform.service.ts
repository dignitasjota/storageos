import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  DEFAULT_LEGAL_DOCUMENTS,
  DEFAULT_PLATFORM_FOOTER,
  DEFAULT_PLATFORM_SEO,
  UpdatePlatformFooterSchema,
  UpdatePlatformSeoSchema,
} from '@storageos/shared';

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
  UpsertPlatformBannerInput,
  AdminPlatformBannerDto,
  UpdatePlatformFooterInput,
  UpdatePlatformFounderOfferInput,
  UpdatePlatformSeoInput,
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
      // Sin email de destino el formulario no se muestra (los mensajes no llegarían).
      contactForm:
        row?.contactEnabled && row.contactEmail
          ? {
              title: row.contactTitle,
              subtitle: row.contactSubtitle,
              showPhone: row.contactShowPhone,
              requirePhone: row.contactShowPhone && row.contactRequirePhone,
              showCompany: row.contactShowCompany,
              showUnits: row.contactShowUnits,
              showProfile: row.contactShowProfile,
            }
          : null,
      footer: PlatformService.parseFooter(row?.footer),
      seo: {
        ...PlatformService.parseSeo(row?.seo),
        ogImageUrl: row?.ogImageKey ? this.files.buildPublicUrl('public', row.ogImageKey) : null,
      },
    };
  }

  private static parseSeo(raw: unknown): UpdatePlatformSeoInput {
    if (raw == null) return DEFAULT_PLATFORM_SEO;
    const parsed = UpdatePlatformSeoSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_PLATFORM_SEO;
  }

  async updateSeo(input: UpdatePlatformSeoInput): Promise<PlatformWebsiteDto> {
    await this.upsertWebsite({ seo: input as unknown as Prisma.InputJsonValue });
    return this.getWebsite();
  }

  private async upsertWebsite(data: Prisma.PlatformWebsiteUpdateInput): Promise<void> {
    const existing = await this.admin.platformWebsite.findFirst();
    if (existing) {
      await this.admin.platformWebsite.update({ where: { id: existing.id }, data });
    } else {
      await this.admin.platformWebsite.create({ data: data as Prisma.PlatformWebsiteCreateInput });
    }
  }

  /** El pie guardado si es válido; si no (o no hay), el de por defecto. */
  private static parseFooter(raw: unknown): UpdatePlatformFooterInput {
    if (raw == null) return DEFAULT_PLATFORM_FOOTER;
    const parsed = UpdatePlatformFooterSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_PLATFORM_FOOTER;
  }

  async updateFooter(input: UpdatePlatformFooterInput): Promise<PlatformWebsiteDto> {
    const footer = input as unknown as Prisma.InputJsonValue;
    const existing = await this.admin.platformWebsite.findFirst();
    if (existing) {
      await this.admin.platformWebsite.update({ where: { id: existing.id }, data: { footer } });
    } else {
      await this.admin.platformWebsite.create({ data: { footer } });
    }
    return this.getWebsite();
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

  private static readonly OG_PREFIX = 'platform/og/';

  /** URL firmada para subir la imagen para redes (1200×630) al bucket público. */
  async requestOgImageUpload(mimeType: string): Promise<PlatformLogoUploadDto> {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const key = `${PlatformService.OG_PREFIX}${randomUUID()}.${ext}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': mimeType } };
  }

  async setOgImage(key: string | null): Promise<PlatformWebsiteDto> {
    if (key && (!key.startsWith(PlatformService.OG_PREFIX) || key.includes('..'))) {
      throw new BadRequestException({ code: 'invalid_image_key', message: 'Imagen no válida' });
    }
    await this.upsertWebsite({ ogImageKey: key });
    return this.getWebsite();
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

  // ---- banners ----

  async listBanners(now = new Date()): Promise<AdminPlatformBannerDto[]> {
    const rows = await this.admin.platformBanner.findMany({
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
    return rows.map((r) => toAdminBannerDto(r, now));
  }

  async createBanner(input: UpsertPlatformBannerInput): Promise<AdminPlatformBannerDto> {
    const row = await this.admin.platformBanner.create({ data: bannerData(input) });
    return toAdminBannerDto(row, new Date());
  }

  async updateBanner(
    id: string,
    input: UpsertPlatformBannerInput,
  ): Promise<AdminPlatformBannerDto> {
    await this.bannerOrThrow(id);
    const row = await this.admin.platformBanner.update({ where: { id }, data: bannerData(input) });
    return toAdminBannerDto(row, new Date());
  }

  async deleteBanner(id: string): Promise<void> {
    await this.bannerOrThrow(id);
    await this.admin.platformBanner.delete({ where: { id } });
  }

  private async bannerOrThrow(id: string): Promise<void> {
    const exists = await this.admin.platformBanner.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException({ code: 'banner_not_found', message: 'Banner no encontrado' });
    }
  }

  /**
   * Banner que ve un tenant: el de más prioridad activo, dentro de sus fechas y
   * cuyo público (plan, estado) incluye al tenant.
   */
  async getPublicBanner(tenantId: string, now = new Date()): Promise<PlatformBannerDto | null> {
    const [rows, tenant] = await Promise.all([
      this.admin.platformBanner.findMany({
        where: {
          enabled: true,
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          ],
        },
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      }),
      this.admin.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, subscription: { select: { plan: { select: { slug: true } } } } },
      }),
    ]);
    const plan = tenant?.subscription?.plan.slug ?? null;
    const status = tenant?.status ?? null;
    const row = rows.find(
      (r) =>
        (r.plans.length === 0 || (plan != null && r.plans.includes(plan))) &&
        (r.statuses.length === 0 || (status != null && r.statuses.includes(status))),
    );
    return row ? toBannerDto(row) : null;
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

  /**
   * Notificaciones paginadas por cursor (de la más nueva a la más antigua),
   * todas o solo las sin leer.
   */
  async pageNotifications(args: {
    cursor?: string;
    limit?: number;
    unread?: boolean;
  }): Promise<{ items: SuperAdminNotificationDto[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    const rows = await this.admin.superAdminNotification.findMany({
      where: args.unread ? { readAt: null } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return {
      items,
      nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async markRead(id: string): Promise<void> {
    await this.admin.superAdminNotification.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date() },
    });
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

type BannerRow = {
  id: string;
  message: string;
  level: string;
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  dismissible: boolean;
  linkUrl: string | null;
  linkLabel: string | null;
  plans: string[];
  statuses: string[];
  priority: number;
  updatedAt: Date;
};

function bannerData(input: UpsertPlatformBannerInput) {
  return {
    message: input.message,
    level: input.level,
    enabled: input.enabled,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    dismissible: input.dismissible,
    linkUrl: input.linkUrl,
    linkLabel: input.linkUrl ? (input.linkLabel ?? null) : null,
    plans: input.plans,
    statuses: input.statuses,
    priority: input.priority,
  };
}

function toBannerDto(row: BannerRow): PlatformBannerDto {
  const level = row.level as PlatformBannerDto['level'];
  return {
    id: row.id,
    message: row.message,
    level,
    enabled: row.enabled,
    linkUrl: row.linkUrl,
    linkLabel: row.linkLabel,
    endsAt: row.endsAt?.toISOString() ?? null,
    // Un aviso crítico no se puede cerrar.
    dismissible: row.dismissible && level !== 'critical',
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAdminBannerDto(row: BannerRow, now: Date): AdminPlatformBannerDto {
  const level = row.level as AdminPlatformBannerDto['level'];
  return {
    id: row.id,
    message: row.message,
    level,
    enabled: row.enabled,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    dismissible: row.dismissible && level !== 'critical',
    linkUrl: row.linkUrl,
    linkLabel: row.linkLabel,
    plans: row.plans,
    statuses: row.statuses,
    priority: row.priority,
    live:
      row.enabled && (!row.startsAt || row.startsAt <= now) && (!row.endsAt || row.endsAt > now),
    updatedAt: row.updatedAt.toISOString(),
  };
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
