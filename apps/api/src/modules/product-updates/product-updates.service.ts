import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SELF_ADDON_TRIAL_DAYS } from '@storageos/shared';

import { pageArgs, toPage, type PageRequest } from '../../common/pagination';
import { tenantFeatures } from '../../common/tenant-features';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { Prisma } from '@storageos/database';
import type {
  AdminProductUpdateDto,
  PageDto,
  ProductUpdateCategory,
  ProductUpdateDto,
  ProductUpdateReaction,
  ProductUpdateTrialOfferDto,
  TenantFeature,
  UpsertProductUpdateInput,
  UserRole,
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
  targetPlans: string[];
  targetRoles: string[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: { fullName: string } | null;
};

/** Cuántas novedades devuelve la lista sin paginar del panel del tenant. */
const TENANT_LIMIT = 50;

/**
 * La ventana de la novedad destacada solo sale para novedades recientes: una
 * destacada de hace meses que el usuario no abrió no se le enseña al entrar.
 */
const HIGHLIGHT_MAX_AGE_DAYS = 30;

type TenantRow = {
  id: string;
  title: string;
  body: string;
  category: string;
  feature: string | null;
  link: string | null;
  publishedAt: Date | null;
  imageKey: string | null;
  highlighted: boolean;
};

/** Quién mira las novedades (ver `ProductUpdatesService.viewer`). */
type Viewer = {
  readUntil: Date;
  role: string;
  planSlug: string | null;
  features: TenantFeature[];
};

/** Filtros de la página de Novedades. */
export interface ProductUpdatesFilters {
  category?: ProductUpdateCategory;
  /** En el título y el texto. */
  search?: string;
  /** Oculta las novedades de funciones que el negocio no tiene. */
  onlyMyPlan?: boolean;
}

/** Página de novedades con la fecha hasta la que el usuario ya las había leído. */
export type ProductUpdatesPageDto = PageDto<ProductUpdateDto> & {
  /** Lo publicado después es «sin leer» (ISO); se calcula antes de marcar como vistas. */
  readUntil: string;
};

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
    const [seen, reactions] = await Promise.all([
      Promise.all(rows.map((r) => this.seenBy(r))),
      this.admin.productUpdateReaction.groupBy({
        by: ['productUpdateId', 'value'],
        _count: { _all: true },
      }),
    ]);
    const helpful = new Map<string, { up: number; down: number }>();
    for (const r of reactions) {
      const cur = helpful.get(r.productUpdateId) ?? { up: 0, down: 0 };
      if (r.value === 'up') cur.up += r._count._all;
      else cur.down += r._count._all;
      helpful.set(r.productUpdateId, cur);
    }
    return rows.map((r, i) => this.toAdminDto(r, seen[i] ?? 0, helpful.get(r.id)));
  }

  /**
   * Usuarios activos que abrieron «Novedades» desde que se publicó (solo los
   * de los planes y roles a los que va dirigida).
   */
  private async seenBy(row: {
    publishedAt: Date | null;
    targetPlans: string[];
    targetRoles: string[];
  }): Promise<number> {
    if (!row.publishedAt || row.publishedAt > new Date()) return 0;
    return this.admin.user.count({
      where: {
        isActive: true,
        productUpdatesSeenAt: { gte: row.publishedAt },
        ...(row.targetRoles.length > 0 ? { role: { in: row.targetRoles as UserRole[] } } : {}),
        ...(row.targetPlans.length > 0
          ? { tenant: { subscription: { plan: { slug: { in: row.targetPlans } } } } }
          : {}),
      },
    });
  }

  private async helpfulFor(id: string): Promise<{ up: number; down: number }> {
    const rows = await this.admin.productUpdateReaction.groupBy({
      by: ['value'],
      where: { productUpdateId: id },
      _count: { _all: true },
    });
    return {
      up: rows.find((r) => r.value === 'up')?._count._all ?? 0,
      down: rows.find((r) => r.value === 'down')?._count._all ?? 0,
    };
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
    const [seen, helpful] = await Promise.all([this.seenBy(row), this.helpfulFor(row.id)]);
    return this.toAdminDto(row, seen, helpful);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.admin.productUpdate.deleteMany({ where: { id } });
    if (deleted.count === 0) throw new NotFoundException({ code: 'product_update_not_found' });
  }

  // --- Tenant ---

  async listForUser(tenantId: string, userId: string): Promise<ProductUpdateDto[]> {
    const viewer = await this.viewer(tenantId, userId);
    const rows = await this.admin.productUpdate.findMany({
      where: { AND: [this.publishedWhere(), this.targetWhere(viewer)] },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: TENANT_LIMIT,
    });
    return this.toTenantDtos(tenantId, userId, rows, viewer);
  }

  /** Novedades publicadas por páginas (cursor = id de la última vista), con filtros. */
  async pageForUser(
    tenantId: string,
    userId: string,
    page: PageRequest,
    filters: ProductUpdatesFilters = {},
  ): Promise<ProductUpdatesPageDto> {
    const viewer = await this.viewer(tenantId, userId);
    const search = filters.search?.trim();
    const rows = await this.admin.productUpdate.findMany({
      where: {
        AND: [
          this.publishedWhere(),
          this.targetWhere(viewer),
          ...(filters.category ? [{ category: filters.category }] : []),
          ...(search
            ? [
                {
                  OR: [
                    { title: { contains: search, mode: 'insensitive' as const } },
                    { body: { contains: search, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
          // «Solo lo de mi plan»: fuera las de funciones que no tiene.
          ...(filters.onlyMyPlan
            ? [{ OR: [{ feature: null }, { feature: { in: viewer.features as string[] } }] }]
            : []),
        ],
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(page),
    });
    const result = toPage(rows, page);
    const items = await this.toTenantDtos(tenantId, userId, result.items, viewer);
    return { items, nextCursor: result.nextCursor, readUntil: viewer.readUntil.toISOString() };
  }

  /**
   * La novedad destacada que se enseña al entrar al panel: la más reciente,
   * sin leer y publicada en los últimos días (null si no hay ninguna).
   */
  async highlightedForUser(tenantId: string, userId: string): Promise<ProductUpdateDto | null> {
    const viewer = await this.viewer(tenantId, userId);
    const recentFrom = new Date(Date.now() - HIGHLIGHT_MAX_AGE_DAYS * 86_400_000);
    const since = viewer.readUntil > recentFrom ? viewer.readUntil : recentFrom;
    const row = await this.admin.productUpdate.findFirst({
      where: {
        AND: [
          { highlighted: true, publishedAt: { gt: since, lte: new Date() } },
          this.targetWhere(viewer),
        ],
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    });
    if (!row) return null;
    const [dto] = await this.toTenantDtos(tenantId, userId, [row], viewer);
    return dto ?? null;
  }

  async unreadCount(tenantId: string, userId: string): Promise<{ count: number }> {
    const viewer = await this.viewer(tenantId, userId);
    const count = await this.admin.productUpdate.count({
      where: {
        AND: [{ publishedAt: { gt: viewer.readUntil, lte: new Date() } }, this.targetWhere(viewer)],
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

  /**
   * «¿Te ha sido útil?»: guarda, cambia o quita (null) la reacción del usuario.
   * Solo sobre novedades que puede ver (publicadas y dirigidas a él).
   */
  async setReaction(
    tenantId: string,
    userId: string,
    updateId: string,
    value: ProductUpdateReaction | null,
  ): Promise<{ value: ProductUpdateReaction | null }> {
    const viewer = await this.viewer(tenantId, userId);
    const visible = await this.admin.productUpdate.count({
      where: { AND: [{ id: updateId }, this.publishedWhere(), this.targetWhere(viewer)] },
    });
    if (visible === 0) throw new NotFoundException({ code: 'product_update_not_found' });
    await this.prisma.withTenant(async (tx) => {
      if (value === null) {
        await tx.productUpdateReaction.deleteMany({
          where: { productUpdateId: updateId, userId },
        });
        return;
      }
      await tx.productUpdateReaction.upsert({
        where: { productUpdateId_userId: { productUpdateId: updateId, userId } },
        create: { tenantId, productUpdateId: updateId, userId, value },
        update: { value },
      });
    }, tenantId);
    return { value };
  }

  /**
   * Quién mira: hasta cuándo tiene leídas las novedades (la última vez que
   * abrió «Novedades» o, si nunca lo ha hecho, su alta: a quien llega nuevo no
   * se le enseña todo el historial como sin leer), su rol, el plan del negocio
   * y sus funciones (para las novedades dirigidas y «Solo lo de mi plan»).
   */
  private async viewer(tenantId: string, userId: string): Promise<Viewer> {
    const [user, subscription, features] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.user.findFirst({
            where: { id: userId, tenantId },
            select: { productUpdatesSeenAt: true, createdAt: true, role: true },
          }),
        tenantId,
      ),
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: { plan: { select: { slug: true } } },
      }),
      tenantFeatures(this.admin, tenantId),
    ]);
    return {
      readUntil: user?.productUpdatesSeenAt ?? user?.createdAt ?? new Date(0),
      role: user?.role ?? 'readonly',
      planSlug: subscription?.plan.slug ?? null,
      features,
    };
  }

  private publishedWhere(): Prisma.ProductUpdateWhereInput {
    return { publishedAt: { not: null, lte: new Date() } };
  }

  /** Novedades dirigidas: vacío = a todos; si no, su plan y su rol deben estar. */
  private targetWhere(viewer: Pick<Viewer, 'planSlug' | 'role'>): Prisma.ProductUpdateWhereInput {
    return {
      AND: [
        {
          OR: [
            { targetPlans: { isEmpty: true } },
            ...(viewer.planSlug ? [{ targetPlans: { has: viewer.planSlug } }] : []),
          ],
        },
        { OR: [{ targetRoles: { isEmpty: true } }, { targetRoles: { has: viewer.role } }] },
      ],
    };
  }

  /** Filas → DTO del tenant con su reacción y la prueba gratis que se puede activar. */
  private async toTenantDtos(
    tenantId: string,
    userId: string,
    rows: TenantRow[],
    viewer: Viewer,
  ): Promise<ProductUpdateDto[]> {
    if (rows.length === 0) return [];
    const missing = [
      ...new Set(
        rows
          .map((r) => r.feature)
          .filter((f): f is string => !!f && !viewer.features.includes(f as TenantFeature)),
      ),
    ];
    const [reactions, offers] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.productUpdateReaction.findMany({
            where: { userId, productUpdateId: { in: rows.map((r) => r.id) } },
            select: { productUpdateId: true, value: true },
          }),
        tenantId,
      ),
      this.trialOffers(tenantId, missing, viewer.planSlug),
    ]);
    const mine = new Map(reactions.map((r) => [r.productUpdateId, r.value]));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      category: r.category as ProductUpdateCategory,
      feature: (r.feature as TenantFeature | null) ?? null,
      featureIncluded: r.feature ? viewer.features.includes(r.feature as TenantFeature) : null,
      link: r.link,
      publishedAt: r.publishedAt!.toISOString(),
      highlighted: r.highlighted,
      imageUrl: this.imageUrl(r.imageKey),
      unread: r.publishedAt! > viewer.readUntil,
      myReaction: (mine.get(r.id) as ProductUpdateReaction | undefined) ?? null,
      trialOffer: (r.feature && offers.get(r.feature)) || null,
    }));
  }

  /**
   * Prueba gratis que el negocio puede activar por función: un extra activo
   * del catálogo que la da (el más barato si hay varios), que no tiene y que
   * nunca ha probado.
   */
  private async trialOffers(
    tenantId: string,
    features: string[],
    planSlug: string | null,
  ): Promise<Map<string, ProductUpdateTrialOfferDto>> {
    const offers = new Map<string, ProductUpdateTrialOfferDto>();
    if (features.length === 0) return offers;
    const [addons, owned, tried, running] = await Promise.all([
      this.admin.subscriptionAddon.findMany({
        where: { isActive: true, isSystem: false, feature: { in: features } },
        select: { id: true, name: true, feature: true, planSlugs: true, priceMonthly: true },
        orderBy: [{ priceMonthly: 'asc' }, { name: 'asc' }],
      }),
      this.admin.tenantSubscriptionAddon.findMany({
        where: { tenantId },
        select: { addonId: true },
      }),
      this.admin.tenantAddonTrial.findMany({ where: { tenantId }, select: { addonId: true } }),
      this.admin.tenantFeatureOverride.findMany({
        where: { tenantId, trialAddonId: { not: null } },
        select: { trialAddonId: true },
      }),
    ]);
    // Una función ya probada (o contratada) con cualquier extra no se vuelve a ofrecer.
    const used = new Set([
      ...owned.map((o) => o.addonId),
      ...tried.map((t) => t.addonId),
      ...running.map((t) => t.trialAddonId!),
    ]);
    const usedFeatures = new Set(
      (
        await this.admin.subscriptionAddon.findMany({
          where: { id: { in: [...used] }, feature: { in: features } },
          select: { feature: true },
        })
      ).map((a) => a.feature),
    );
    for (const a of addons) {
      if (!a.feature || offers.has(a.feature) || usedFeatures.has(a.feature)) continue;
      if (a.planSlugs.length > 0 && (!planSlug || !a.planSlugs.includes(planSlug))) continue;
      offers.set(a.feature, { addonId: a.id, addonName: a.name, days: SELF_ADDON_TRIAL_DAYS });
    }
    return offers;
  }

  private fields(input: UpsertProductUpdateInput) {
    return {
      title: input.title,
      body: input.body,
      category: input.category,
      feature: input.feature ?? null,
      link: input.link ?? null,
      highlighted: input.highlighted,
      targetPlans: [...new Set(input.targetPlans)],
      targetRoles: [...new Set(input.targetRoles)],
    };
  }

  private toAdminDto(
    r: Row,
    seenBy: number,
    helpful: { up: number; down: number } = { up: 0, down: 0 },
  ): AdminProductUpdateDto {
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
      helpfulUp: helpful.up,
      helpfulDown: helpful.down,
      targetPlans: r.targetPlans,
      targetRoles: r.targetRoles as UserRole[],
      authorName: r.createdBy?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
