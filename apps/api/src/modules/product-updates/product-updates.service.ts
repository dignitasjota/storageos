import { Injectable, NotFoundException } from '@nestjs/common';

import { tenantFeatures } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

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
  ) {}

  // --- Super admin ---

  async adminList(): Promise<AdminProductUpdateDto[]> {
    const rows = await this.admin.productUpdate.findMany({
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
      include: { createdBy: { select: { fullName: true } } },
    });
    return rows.map((r) => this.toAdminDto(r));
  }

  async create(
    input: UpsertProductUpdateInput,
    superAdminId: string,
  ): Promise<AdminProductUpdateDto> {
    const row = await this.admin.productUpdate.create({
      data: {
        ...this.fields(input),
        publishedAt: input.published ? new Date() : null,
        createdById: superAdminId,
      },
      include: { createdBy: { select: { fullName: true } } },
    });
    return this.toAdminDto(row);
  }

  async update(id: string, input: UpsertProductUpdateInput): Promise<AdminProductUpdateDto> {
    const current = await this.admin.productUpdate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException({ code: 'product_update_not_found' });
    // Publicar conserva la fecha original si ya estaba publicada (no vuelve a
    // salir como nueva al corregir una errata).
    const publishedAt = input.published ? (current.publishedAt ?? new Date()) : null;
    const row = await this.admin.productUpdate.update({
      where: { id },
      data: { ...this.fields(input), publishedAt },
      include: { createdBy: { select: { fullName: true } } },
    });
    return this.toAdminDto(row);
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
    };
  }

  private toAdminDto(r: Row): AdminProductUpdateDto {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      category: r.category as ProductUpdateCategory,
      feature: (r.feature as TenantFeature | null) ?? null,
      link: r.link,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      authorName: r.createdBy?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
