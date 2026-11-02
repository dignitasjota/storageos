import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { tenantFeatures } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type {
  AdminProductUpdateDto,
  ProductUpdateCategory,
  ProductUpdateDto,
  TenantFeature,
  UpsertProductUpdateInput,
} from '@storageos/shared';

type Row = {
  id: string;
  title: string;
  body: string;
  category: string;
  feature: string | null;
  link: string | null;
  publishedAt: Date | null;
  imageKey: string | null;
  highlighted: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: { fullName: string } | null;
};

/** Cuántas novedades se muestran en el panel del tenant. */
const TENANT_LIMIT = 50;

/**
 * «Novedades» de la plataforma: el super admin las escribe (Markdown) y las
 * publica; cada usuario de un tenant las ve en su panel, con aviso de las que
 * se publicaron después de la última vez que entró.
 */
@Injectable()
export class ProductUpdatesService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  private static readonly IMAGE_PREFIX = 'platform/updates/';

  /** Subida de la captura (bucket público). */
  async requestImageUpload(
    mimeType: string,
  ): Promise<{ uploadUrl: string; key: string; requiredHeaders: Record<string, string> }> {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const key = `${ProductUpdatesService.IMAGE_PREFIX}${randomUUID()}.${ext}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': mimeType } };
  }

  private imageUrl(key: string | null): string | null {
    return key ? this.files.buildPublicUrl('public', key) : null;
  }

  // --- Super admin ---

  async adminList(): Promise<AdminProductUpdateDto[]> {
    const rows = await this.admin.productUpdate.findMany({
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
      include: { createdBy: { select: { fullName: true } } },
    });
    const seen = await Promise.all(rows.map((r) => this.seenBy(r.publishedAt)));
    return rows.map((r, i) => this.toAdminDto(r, seen[i] ?? 0));
  }

  /** Usuarios activos que abrieron «Novedades» desde que se publicó. */
  private async seenBy(publishedAt: Date | null): Promise<number> {
    if (!publishedAt || publishedAt > new Date()) return 0;
    return this.admin.user.count({
      where: { isActive: true, productUpdatesSeenAt: { gte: publishedAt } },
    });
  }

  private async checkImage(key: string | null | undefined): Promise<void> {
    if (!key) return;
    if (!key.startsWith(ProductUpdatesService.IMAGE_PREFIX) || key.includes('..')) {
      throw new BadRequestException({ code: 'invalid_image_key', message: 'Imagen no válida' });
    }
    await this.files.assertObjectMimeType(
      'public',
      key,
      ['image/png', 'image/jpeg', 'image/webp'],
      5 * 1024 * 1024,
    );
  }

  async create(
    input: UpsertProductUpdateInput,
    superAdminId: string,
  ): Promise<AdminProductUpdateDto> {
    await this.checkImage(input.imageKey);
    const at = input.publishAt ? new Date(input.publishAt) : new Date();
    const row = await this.admin.productUpdate.create({
      data: {
        ...this.fields(input),
        ...(input.imageKey !== undefined ? { imageKey: input.imageKey } : {}),
        ...(input.published ? { publishedAt: at, firstPublishedAt: at } : {}),
        createdById: superAdminId,
      },
      include: { createdBy: { select: { fullName: true } } },
    });
    return this.toAdminDto(row, 0);
  }

  async update(id: string, input: UpsertProductUpdateInput): Promise<AdminProductUpdateDto> {
    const current = await this.admin.productUpdate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException({ code: 'product_update_not_found' });
    await this.checkImage(input.imageKey);
    // Publicar conserva la fecha de la primera publicación: corregir una errata
    // o despublicar y volver a publicar no la saca como nueva. Mientras una
    // programada no ha salido, su fecha se puede cambiar.
    const now = new Date();
    const first = current.firstPublishedAt ?? current.publishedAt;
    const wentLive = first != null && first <= now;
    const publishedAt = !input.published
      ? null
      : wentLive
        ? first
        : input.publishAt
          ? new Date(input.publishAt)
          : now;
    const row = await this.admin.productUpdate.update({
      where: { id },
      data: {
        ...this.fields(input),
        ...(input.imageKey !== undefined ? { imageKey: input.imageKey } : {}),
        publishedAt,
        ...(input.published && !wentLive ? { firstPublishedAt: publishedAt } : {}),
      },
      include: { createdBy: { select: { fullName: true } } },
    });
    return this.toAdminDto(row, await this.seenBy(row.publishedAt));
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.admin.productUpdate.deleteMany({ where: { id } });
    if (deleted.count === 0) throw new NotFoundException({ code: 'product_update_not_found' });
  }

  // --- Tenant ---

  async listForUser(tenantId: string, userId: string): Promise<ProductUpdateDto[]> {
    const [rows, seenAt, features] = await Promise.all([
      this.admin.productUpdate.findMany({
        where: { publishedAt: { not: null, lte: new Date() } },
        orderBy: { publishedAt: 'desc' },
        take: TENANT_LIMIT,
      }),
      this.seenAt(tenantId, userId),
      tenantFeatures(this.admin, tenantId),
    ]);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      category: r.category as ProductUpdateCategory,
      feature: (r.feature as TenantFeature | null) ?? null,
      featureIncluded: r.feature ? features.includes(r.feature as TenantFeature) : null,
      link: r.link,
      publishedAt: r.publishedAt!.toISOString(),
      highlighted: r.highlighted,
      imageUrl: this.imageUrl(r.imageKey),
      unread: !seenAt || r.publishedAt! > seenAt,
    }));
  }

  async unreadCount(tenantId: string, userId: string): Promise<{ count: number }> {
    const seenAt = await this.seenAt(tenantId, userId);
    const count = await this.admin.productUpdate.count({
      where: {
        publishedAt: seenAt ? { gt: seenAt, lte: new Date() } : { not: null, lte: new Date() },
      },
    });
    return { count };
  }

  async markSeen(tenantId: string, userId: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        tx.user.updateMany({
          where: { id: userId, tenantId },
          data: { productUpdatesSeenAt: new Date() },
        }),
      tenantId,
    );
  }

  private async seenAt(tenantId: string, userId: string): Promise<Date | null> {
    const user = await this.prisma.withTenant(
      (tx) =>
        tx.user.findFirst({
          where: { id: userId, tenantId },
          select: { productUpdatesSeenAt: true },
        }),
      tenantId,
    );
    return user?.productUpdatesSeenAt ?? null;
  }

  private fields(input: UpsertProductUpdateInput) {
    return {
      title: input.title,
      body: input.body,
      category: input.category,
      feature: input.feature ?? null,
      link: input.link ?? null,
      highlighted: input.highlighted,
    };
  }

  private toAdminDto(r: Row, seenBy: number): AdminProductUpdateDto {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      category: r.category as ProductUpdateCategory,
      feature: (r.feature as TenantFeature | null) ?? null,
      link: r.link,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      scheduled: r.publishedAt != null && r.publishedAt > new Date(),
      highlighted: r.highlighted,
      imageUrl: this.imageUrl(r.imageKey),
      seenBy,
      authorName: r.createdBy?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
