import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  promoDatesIssue,
  promoLandingIsLive,
  type CreatePromoLandingInput,
  type PromoLandingDto,
  type UpdatePromoLandingInput,
} from '@storageos/shared';

import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { Prisma } from '@storageos/database';

type Row = Prisma.PromoLandingGetPayload<{ include: { coupon: { select: { code: true } } } }>;

const INCLUDE = { coupon: { select: { code: true } } } as const;

/**
 * Landings de promoción de la web del tenant (extra Web Premium). El staff las
 * crea y edita aquí; `LandingService` sirve la que esté en vigor en
 * `/promo/<slug>`.
 */
@Injectable()
export class PromoLandingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async list(tenantId: string): Promise<PromoLandingDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.promoLanding.findMany({
          where: { tenantId },
          include: INCLUDE,
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<PromoLandingDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  async create(tenantId: string, input: CreatePromoLandingInput): Promise<PromoLandingDto> {
    await this.assertRefs(tenantId, input);
    try {
      const row = await this.prisma.withTenant(
        (tx) =>
          tx.promoLanding.create({
            data: {
              tenantId,
              name: input.name,
              slug: input.slug,
              isActive: input.isActive,
              startsAt: input.startsAt ? new Date(input.startsAt) : null,
              endsAt: input.endsAt ? new Date(input.endsAt) : null,
              headline: input.headline,
              subheadline: input.subheadline,
              offerText: input.offerText,
              body: input.body,
              benefits: input.benefits,
              conditions: input.conditions,
              ctaLabel: input.ctaLabel,
              couponId: input.couponId,
              facilityIds: input.facilityIds,
              unitTypeIds: input.unitTypeIds,
              showCountdown: input.showCountdown,
              showTestimonials: input.showTestimonials,
              showFaq: input.showFaq,
              showContact: input.showContact,
              seoTitle: input.seoTitle,
              seoDescription: input.seoDescription,
              indexable: input.indexable,
            },
            include: INCLUDE,
          }),
        tenantId,
      );
      return this.toDto(row);
    } catch (err) {
      throw this.slugTaken(err);
    }
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdatePromoLandingInput,
  ): Promise<PromoLandingDto> {
    const current = await this.findOrThrow(tenantId, id);
    const issue = promoDatesIssue({
      startsAt:
        input.startsAt !== undefined ? input.startsAt : (current.startsAt?.toISOString() ?? null),
      endsAt: input.endsAt !== undefined ? input.endsAt : (current.endsAt?.toISOString() ?? null),
    });
    if (issue) throw new BadRequestException({ code: 'invalid_dates', message: issue });
    await this.assertRefs(tenantId, {
      couponId: input.couponId ?? null,
      facilityIds: input.facilityIds ?? [],
      unitTypeIds: input.unitTypeIds ?? [],
    });

    const data: Prisma.PromoLandingUpdateInput = {};
    const text = (v: string | null | undefined) => (v ? v : null);
    if (input.name !== undefined) data.name = input.name;
    if (input.slug !== undefined) data.slug = input.slug;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.startsAt !== undefined)
      data.startsAt = input.startsAt ? new Date(input.startsAt) : null;
    if (input.endsAt !== undefined) data.endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (input.headline !== undefined) data.headline = input.headline;
    if (input.subheadline !== undefined) data.subheadline = text(input.subheadline);
    if (input.offerText !== undefined) data.offerText = text(input.offerText);
    if (input.body !== undefined) data.body = text(input.body);
    if (input.benefits !== undefined) data.benefits = input.benefits;
    if (input.conditions !== undefined) data.conditions = text(input.conditions);
    if (input.ctaLabel !== undefined) data.ctaLabel = text(input.ctaLabel);
    if (input.couponId !== undefined) {
      data.coupon = input.couponId ? { connect: { id: input.couponId } } : { disconnect: true };
    }
    if (input.facilityIds !== undefined) data.facilityIds = input.facilityIds;
    if (input.unitTypeIds !== undefined) data.unitTypeIds = input.unitTypeIds;
    if (input.showCountdown !== undefined) data.showCountdown = input.showCountdown;
    if (input.showTestimonials !== undefined) data.showTestimonials = input.showTestimonials;
    if (input.showFaq !== undefined) data.showFaq = input.showFaq;
    if (input.showContact !== undefined) data.showContact = input.showContact;
    if (input.seoTitle !== undefined) data.seoTitle = text(input.seoTitle);
    if (input.seoDescription !== undefined) data.seoDescription = text(input.seoDescription);
    if (input.indexable !== undefined) data.indexable = input.indexable;
    try {
      const row = await this.prisma.withTenant(
        (tx) => tx.promoLanding.update({ where: { id }, data, include: INCLUDE }),
        tenantId,
      );
      return this.toDto(row);
    } catch (err) {
      throw this.slugTaken(err);
    }
  }

  /** Copia para la siguiente promoción: apagada, con otra dirección y la misma foto. */
  async duplicate(tenantId: string, id: string): Promise<PromoLandingDto> {
    const src = await this.findOrThrow(tenantId, id);
    const row = await this.prisma.withTenant(async (tx) => {
      let slug = `${src.slug}-copia`.slice(0, 60);
      for (let n = 2; await tx.promoLanding.findFirst({ where: { tenantId, slug } }); n++) {
        slug = `${src.slug}-copia-${n}`.slice(0, 60);
      }
      const { id: _id, createdAt: _c, updatedAt: _u, coupon: _coupon, ...rest } = src;
      return tx.promoLanding.create({
        data: { ...rest, name: `${src.name} (copia)`.slice(0, 120), slug, isActive: false },
        include: INCLUDE,
      });
    }, tenantId);
    return this.toDto(row);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOrThrow(tenantId, id);
    await this.prisma.withTenant((tx) => tx.promoLanding.delete({ where: { id } }), tenantId);
  }

  async requestImageUploadUrl(args: {
    tenantId: string;
    id: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
    await this.findOrThrow(args.tenantId, args.id);
    const key = this.files.buildPromoLandingImageKey(args.tenantId, args.id, args.mimeType);
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: args.mimeType,
      contentLengthRange: { min: 1, max: args.sizeBytes },
    });
    return { uploadUrl, key, expiresIn };
  }

  async setImage(tenantId: string, id: string, key: string | null): Promise<PromoLandingDto> {
    await this.findOrThrow(tenantId, id);
    if (key) {
      if (!key.startsWith(`${tenantId}/promo/${id}/`)) {
        throw new BadRequestException({
          code: 'invalid_image_key',
          message: 'La imagen no pertenece a esta landing',
        });
      }
      await this.files.assertObjectMimeType('public', key, [
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
    }
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.promoLanding.update({ where: { id }, data: { heroImageKey: key }, include: INCLUDE }),
      tenantId,
    );
    return this.toDto(row);
  }

  private slugTaken(err: unknown): unknown {
    if ((err as { code?: string }).code === 'P2002') {
      return new ConflictException({
        code: 'promo_slug_taken',
        message: 'Ya hay otra landing con esa dirección',
      });
    }
    return err;
  }

  /** El cupón, los locales y los tamaños deben ser del tenant. */
  private async assertRefs(
    tenantId: string,
    refs: { couponId: string | null; facilityIds: string[]; unitTypeIds: string[] },
  ): Promise<void> {
    const [coupon, facilities, types] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          refs.couponId
            ? tx.coupon.count({ where: { tenantId, id: refs.couponId } })
            : Promise.resolve(1),
          refs.facilityIds.length
            ? tx.facility.count({
                where: { tenantId, id: { in: refs.facilityIds }, deletedAt: null },
              })
            : Promise.resolve(0),
          refs.unitTypeIds.length
            ? tx.unitType.count({ where: { tenantId, id: { in: refs.unitTypeIds } } })
            : Promise.resolve(0),
        ]),
      tenantId,
    );
    if (
      coupon === 0 ||
      facilities !== new Set(refs.facilityIds).size ||
      types !== new Set(refs.unitTypeIds).size
    ) {
      throw new BadRequestException({
        code: 'invalid_reference',
        message: 'El cupón, algún local o algún tamaño no existe',
      });
    }
  }

  private async findOrThrow(tenantId: string, id: string): Promise<Row> {
    const row = await this.prisma.withTenant(
      (tx) => tx.promoLanding.findFirst({ where: { id, tenantId }, include: INCLUDE }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'promo_landing_not_found',
        message: 'Landing no encontrada',
      });
    }
    return row;
  }

  private toDto(r: Row): PromoLandingDto {
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      isActive: r.isActive,
      startsAt: r.startsAt?.toISOString() ?? null,
      endsAt: r.endsAt?.toISOString() ?? null,
      live: promoLandingIsLive(r),
      headline: r.headline,
      subheadline: r.subheadline,
      offerText: r.offerText,
      body: r.body,
      benefits: r.benefits,
      conditions: r.conditions,
      ctaLabel: r.ctaLabel,
      heroImageUrl: r.heroImageKey ? this.files.buildPublicUrl('public', r.heroImageKey) : null,
      couponId: r.couponId,
      couponCode: r.coupon?.code ?? null,
      facilityIds: r.facilityIds,
      unitTypeIds: r.unitTypeIds,
      showCountdown: r.showCountdown,
      showTestimonials: r.showTestimonials,
      showFaq: r.showFaq,
      showContact: r.showContact,
      seoTitle: r.seoTitle,
      seoDescription: r.seoDescription,
      indexable: r.indexable,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
