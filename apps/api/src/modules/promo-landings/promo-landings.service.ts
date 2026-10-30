import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  parsePromoLandingContent,
  promoCampaign,
  promoDatesIssue,
  promoLandingIsLive,
  type CreatePromoLandingInput,
  type PromoLandingDto,
  type PromoLandingPreviewDto,
  type PromoLandingStatsDto,
  type PromoLandingStatsRowDto,
  type UpdatePromoLandingInput,
} from '@storageos/shared';

import {
  PROMO_PREVIEW_TTL_MS,
  buildPromoPreviewToken,
  promoPreviewKey,
} from '../../common/marketing/promo-preview-token';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { Env } from '../../config/env.schema';
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
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Enlace de vista previa (borradores incluidos) en la dirección de la
   * plataforma. Firmado y válido 30 minutos; la página no se indexa ni cuenta visitas.
   */
  async previewLink(tenantId: string, id: string): Promise<PromoLandingPreviewDto> {
    const landing = await this.findOrThrow(tenantId, id);
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
      tenantId,
    );
    const expires = Date.now() + PROMO_PREVIEW_TTL_MS;
    const token = buildPromoPreviewToken(
      promoPreviewKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true })),
      landing.id,
      expires,
    );
    const base = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    return {
      url: `${base}/s/${tenant!.slug}/promo/${landing.slug}?preview=${encodeURIComponent(token)}`,
      expiresAt: new Date(expires).toISOString(),
    };
  }

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
              couponId: input.couponId,
              facilityIds: input.facilityIds,
              unitTypeIds: input.unitTypeIds,
              showCountdown: input.showCountdown,
              content: input.content as Prisma.InputJsonValue,
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
    if (input.content !== undefined) data.content = input.content as Prisma.InputJsonValue;
    if (input.couponId !== undefined) {
      data.coupon = input.couponId ? { connect: { id: input.couponId } } : { disconnect: true };
    }
    if (input.facilityIds !== undefined) data.facilityIds = input.facilityIds;
    if (input.unitTypeIds !== undefined) data.unitTypeIds = input.unitTypeIds;
    if (input.showCountdown !== undefined) data.showCountdown = input.showCountdown;
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
      const { id: _id, createdAt: _c, updatedAt: _u, coupon: _coupon, content, ...rest } = src;
      return tx.promoLanding.create({
        data: {
          ...rest,
          content: content as Prisma.InputJsonValue,
          name: `${src.name} (copia)`.slice(0, 120),
          slug,
          isActive: false,
        },
        include: INCLUDE,
      });
    }, tenantId);
    return this.toDto(row);
  }

  /**
   * Resultados de una landing: visitas por origen y, de las reservas online
   * hechas desde ella (contacto con `utm_campaign` = `promo-<nombre>`), cuántas
   * se firmaron, cuántas pagaron el primer pago y cuánto se cobró (sin fianza).
   */
  async stats(tenantId: string, id: string, days: number): Promise<PromoLandingStatsDto> {
    const landing = await this.findOrThrow(tenantId, id);
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null;
    const { visits, leads, requests } = await this.prisma.withTenant(
      async (tx) => ({
        visits: await tx.promoLandingVisit.findMany({
          where: { promoLandingId: id, ...(since ? { createdAt: { gte: since } } : {}) },
          select: { visitorId: true, source: true },
        }),
        requests: await tx.lead.findMany({
          where: {
            source: 'landing',
            utmCampaign: promoCampaign(landing.slug),
            deletedAt: null,
            ...(since ? { createdAt: { gte: since } } : {}),
          },
          select: { utmSource: true },
        }),
        leads: await tx.lead.findMany({
          where: {
            utmCampaign: promoCampaign(landing.slug),
            convertedContractId: { not: null },
            deletedAt: null,
            ...(since ? { wonAt: { gte: since } } : {}),
          },
          select: { utmSource: true, convertedContractId: true },
        }),
      }),
      tenantId,
    );
    const contractIds = [...new Set(leads.map((l) => l.convertedContractId!))];
    const [contracts, invoices, couponUses] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.contract.findMany({
            where: { id: { in: contractIds } },
            select: { id: true, signedAt: true },
          }),
          tx.invoice.findMany({
            where: { contractId: { in: contractIds }, kind: 'invoice', deletedAt: null },
            select: {
              contractId: true,
              status: true,
              amountPaid: true,
              withholdingAmount: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
          }),
          landing.couponId
            ? tx.couponRedemption.count({
                where: { couponId: landing.couponId, contractId: { in: contractIds } },
              })
            : Promise.resolve(0),
        ]),
      tenantId,
    );
    const signed = new Set(contracts.filter((c) => c.signedAt).map((c) => c.id));
    // Primer pago = la primera factura de cada contrato.
    const first = new Map<string, (typeof invoices)[number]>();
    for (const inv of invoices) {
      if (inv.contractId && !first.has(inv.contractId)) first.set(inv.contractId, inv);
    }

    const rows = new Map<string, PromoLandingStatsRowDto & { ids: Set<string> }>();
    const row = (source: string | null) => {
      const key = source || 'web';
      let r = rows.get(key);
      if (!r) {
        r = {
          source: key,
          visits: 0,
          visitors: 0,
          requests: 0,
          bookings: 0,
          signed: 0,
          paid: 0,
          revenue: 0,
          ids: new Set(),
        };
        rows.set(key, r);
      }
      return r;
    };
    for (const v of visits) {
      const r = row(v.source);
      r.visits += 1;
      r.ids.add(v.visitorId);
    }
    for (const l of requests) row(l.utmSource?.toLowerCase() ?? null).requests += 1;
    const seen = new Set<string>();
    for (const l of leads) {
      const cid = l.convertedContractId!;
      if (seen.has(cid)) continue;
      seen.add(cid);
      const r = row(l.utmSource?.toLowerCase() ?? null);
      r.bookings += 1;
      if (signed.has(cid)) r.signed += 1;
      const inv = first.get(cid);
      if (inv?.status === 'paid') r.paid += 1;
      if (inv) r.revenue += Number(inv.amountPaid) - Number(inv.withholdingAmount);
    }
    const bySource = [...rows.values()]
      .map(({ ids, ...r }) => ({
        ...r,
        visitors: ids.size,
        revenue: Math.round(r.revenue * 100) / 100,
      }))
      .sort((a, b) => b.visits - a.visits || b.requests - a.requests || b.bookings - a.bookings);
    const visitors = new Set(visits.map((v) => v.visitorId)).size;
    const sum = (k: 'requests' | 'bookings' | 'signed' | 'paid' | 'revenue') =>
      bySource.reduce((acc, r) => acc + r[k], 0);
    const paid = sum('paid');
    return {
      days,
      visits: visits.length,
      visitors,
      requests: sum('requests'),
      bookings: sum('bookings'),
      signed: sum('signed'),
      paid,
      revenue: Math.round(sum('revenue') * 100) / 100,
      conversionPct: visitors > 0 ? Math.round((paid / visitors) * 1000) / 10 : null,
      couponUses,
      bySource,
    };
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
      heroImageUrl: r.heroImageKey ? this.files.buildPublicUrl('public', r.heroImageKey) : null,
      couponId: r.couponId,
      couponCode: r.coupon?.code ?? null,
      facilityIds: r.facilityIds,
      unitTypeIds: r.unitTypeIds,
      showCountdown: r.showCountdown,
      content: parsePromoLandingContent(r.content),
      seoTitle: r.seoTitle,
      seoDescription: r.seoDescription,
      indexable: r.indexable,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
