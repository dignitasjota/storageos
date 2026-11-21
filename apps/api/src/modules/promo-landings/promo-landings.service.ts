import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  couponSummary,
  parsePromoLandingContent,
  parsePromoLandingDraft,
  promoCampaign,
  promoDatesIssue,
  promoLandingIsLive,
  promoShortPathReserved,
  type CreatePromoLandingInput,
  type DraftPromoLandingInput,
  type PromoLandingDraftDto,
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
import { forgetOldSlug, forgetRedirectsTo, rememberOldSlug } from '../../common/web-slug-redirects';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../auth/audit.service';
import { PROMO_LANDING_DRAFT_SYSTEM, businessFacts } from '../blog/web-draft-context';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { LandingService } from '../landing/landing.service';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';

type Row = Prisma.PromoLandingGetPayload<{ include: { coupon: { select: { code: true } } } }>;

const INCLUDE = { coupon: { select: { code: true } } } as const;

/** Tipos y tamaño máximo de la foto de la landing (los de la URL de subida). */
const PROMO_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const PROMO_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SLUG_MAX = 60;

/** Dirección de la copia: cabe siempre en 60 caracteres (recorta antes del sufijo). */
export function copySlug(base: string, n: number): string {
  const suffix = n <= 1 ? '-copia' : `-copia-${n}`;
  const head = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '');
  return `${head}${suffix}`;
}

/** ¿El contacto llegó por esta landing? Por su id si lo guardó; si no (antiguos), por la campaña. */
function fromLanding(
  lead: { metadata: unknown; utmCampaign: string | null },
  landingId: string,
  campaign: string,
): boolean {
  const meta = lead.metadata as { promoLandingId?: unknown } | null;
  if (meta && typeof meta.promoLandingId === 'string') return meta.promoLandingId === landingId;
  return lead.utmCampaign === campaign;
}

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
    private readonly audit: AuditService,
    private readonly landing: LandingService,
    private readonly ai: AiService,
  ) {}

  /**
   * Borrador con IA de los textos de una landing a partir de la oferta: titular,
   * subtítulo, ventajas, condiciones y SEO, con los datos reales del negocio
   * (los locales y tamaños de la promoción, y su cupón). Gasta una consulta del
   * asistente; si la respuesta no se puede leer, se devuelve. No guarda nada.
   */
  async draft(
    tenantId: string,
    userId: string,
    input: DraftPromoLandingInput,
  ): Promise<PromoLandingDraftDto> {
    const [tenant, coupon] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
          input.couponId
            ? tx.coupon.findFirst({
                where: { tenantId, id: input.couponId },
                select: {
                  code: true,
                  discountType: true,
                  discountValue: true,
                  minMonths: true,
                  validUntil: true,
                },
              })
            : Promise.resolve(null),
        ]),
      tenantId,
    );
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const site = await this.landing.getBySlug(tenant.slug);
    const couponLine = coupon
      ? `Cupón que se aplica al reservar: ${coupon.code} (${couponSummary({
          discountType: coupon.discountType,
          discountValue: Number(coupon.discountValue),
          minMonths: coupon.minMonths,
        })}${coupon.validUntil ? `, válido hasta el ${coupon.validUntil.toISOString().slice(0, 10)}` : ''}).`
      : '';
    const failed = (spent: boolean) =>
      new BadGatewayException({
        code: 'ai_draft_failed',
        message: spent
          ? 'No se ha podido redactar el texto. Inténtalo de nuevo.'
          : 'No se ha podido redactar el texto. Inténtalo de nuevo: no ha gastado consulta.',
      });
    const text = await this.ai.completeText({
      tenantId,
      userId,
      feature: 'promo_landing_draft',
      system: PROMO_LANDING_DRAFT_SYSTEM,
      user: [
        businessFacts(site, {
          facilityIds: input.facilityIds ?? [],
          unitTypeIds: input.unitTypeIds ?? [],
        }),
        '',
        `Oferta: ${input.offer}`,
        couponLine,
        'Redacta los textos de la landing.',
      ]
        .filter(Boolean)
        .join('\n'),
      accept: (reply) => parsePromoLandingDraft(reply) !== null,
      rejected: () => failed(false),
    });
    const draft = parsePromoLandingDraft(text);
    if (!draft) throw failed(true);
    return draft;
  }

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

  async create(
    tenantId: string,
    input: CreatePromoLandingInput,
    userId: string | null = null,
  ): Promise<PromoLandingDto> {
    const refs = await this.cleanRefs(tenantId, input);
    if (input.shortPath) await this.assertShortPathFree(tenantId, input.slug);
    try {
      const row = await this.prisma.withTenant(async (tx) => {
        const created = await tx.promoLanding.create({
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
            facilityIds: refs.facilityIds,
            unitTypeIds: refs.unitTypeIds,
            showCountdown: input.showCountdown,
            shortPath: input.shortPath,
            content: input.content as Prisma.InputJsonValue,
            seoTitle: input.seoTitle,
            seoDescription: input.seoDescription,
            indexable: input.indexable,
          },
          include: INCLUDE,
        });
        if (created.shortPath) await this.forgetFacilityRedirect(tx, created.slug);
        // Si era la dirección antigua de otra landing, ahora es de esta.
        await forgetOldSlug(tx, { tenantId, kind: 'promo', slug: created.slug });
        return created;
      }, tenantId);
      await this.audit.write({
        tenantId,
        userId,
        action: 'promo_landing.created',
        entityType: 'PromoLanding',
        entityId: row.id,
        changes: { name: row.name, slug: row.slug, isActive: row.isActive },
      });
      return this.toDto(row);
    } catch (err) {
      throw this.slugTaken(err);
    }
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdatePromoLandingInput,
    userId: string | null = null,
  ): Promise<PromoLandingDto> {
    const current = await this.findOrThrow(tenantId, id);
    const issue = promoDatesIssue({
      startsAt:
        input.startsAt !== undefined ? input.startsAt : (current.startsAt?.toISOString() ?? null),
      endsAt: input.endsAt !== undefined ? input.endsAt : (current.endsAt?.toISOString() ?? null),
    });
    if (issue) throw new BadRequestException({ code: 'invalid_dates', message: issue });
    const refs = await this.cleanRefs(tenantId, {
      couponId: input.couponId ?? null,
      facilityIds: input.facilityIds ?? [],
      unitTypeIds: input.unitTypeIds ?? [],
    });
    const shortPath = input.shortPath ?? current.shortPath;
    if (shortPath && (input.shortPath || (input.slug && input.slug !== current.slug))) {
      await this.assertShortPathFree(tenantId, input.slug ?? current.slug);
    }

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
    if (input.facilityIds !== undefined) data.facilityIds = refs.facilityIds;
    if (input.unitTypeIds !== undefined) data.unitTypeIds = refs.unitTypeIds;
    if (input.showCountdown !== undefined) data.showCountdown = input.showCountdown;
    if (input.shortPath !== undefined) data.shortPath = input.shortPath;
    if (input.seoTitle !== undefined) data.seoTitle = text(input.seoTitle);
    if (input.seoDescription !== undefined) data.seoDescription = text(input.seoDescription);
    if (input.indexable !== undefined) data.indexable = input.indexable;
    try {
      const row = await this.prisma.withTenant(async (tx) => {
        const updated = await tx.promoLanding.update({ where: { id }, data, include: INCLUDE });
        if (updated.shortPath) await this.forgetFacilityRedirect(tx, updated.slug);
        // La dirección antigua (enlaces y QR repartidos) sigue llevando a la landing.
        await rememberOldSlug(tx, {
          tenantId,
          kind: 'promo',
          oldSlug: current.slug,
          newSlug: updated.slug,
          targetId: id,
        });
        return updated;
      }, tenantId);
      // Rastro de lo que cambia lo que ve el público: activar, apagar y la dirección.
      const changes: Record<string, unknown> = {};
      if (row.isActive !== current.isActive) changes.isActive = row.isActive;
      if (row.slug !== current.slug) changes.slug = { from: current.slug, to: row.slug };
      if (Object.keys(changes).length > 0) {
        await this.audit.write({
          tenantId,
          userId,
          action:
            row.slug !== current.slug
              ? 'promo_landing.slug_changed'
              : row.isActive
                ? 'promo_landing.published'
                : 'promo_landing.unpublished',
          entityType: 'PromoLanding',
          entityId: id,
          changes: { name: row.name, ...changes },
        });
      }
      return this.toDto(row);
    } catch (err) {
      throw this.slugTaken(err);
    }
  }

  /** Copia para la siguiente promoción: apagada, con otra dirección y la misma foto. */
  async duplicate(
    tenantId: string,
    id: string,
    userId: string | null = null,
  ): Promise<PromoLandingDto> {
    const src = await this.findOrThrow(tenantId, id);
    const row = await this.prisma
      .withTenant(async (tx) => {
        let n = 1;
        let slug = copySlug(src.slug, n);
        while (
          await tx.promoLanding.findFirst({ where: { tenantId, slug }, select: { id: true } })
        ) {
          n += 1;
          slug = copySlug(src.slug, n);
        }
        const { id: _id, createdAt: _c, updatedAt: _u, coupon: _coupon, content, ...rest } = src;
        await forgetOldSlug(tx, { tenantId, kind: 'promo', slug });
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
      }, tenantId)
      .catch((err: unknown) => {
        throw this.slugTaken(err);
      });
    await this.audit.write({
      tenantId,
      userId,
      action: 'promo_landing.duplicated',
      entityType: 'PromoLanding',
      entityId: row.id,
      changes: { from: src.id, name: row.name, slug: row.slug },
    });
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
    const campaign = promoCampaign(landing.slug);
    const byLanding: Prisma.LeadWhereInput[] = [
      { metadata: { path: ['promoLandingId'], equals: id } },
      { utmCampaign: campaign },
    ];
    const {
      visits,
      leads: leadRows,
      requests: requestRows,
    } = await this.prisma.withTenant(
      async (tx) => ({
        visits: await tx.promoLandingVisit.findMany({
          where: { promoLandingId: id, ...(since ? { createdAt: { gte: since } } : {}) },
          select: { visitorId: true, source: true },
        }),
        requests: await tx.lead.findMany({
          where: {
            source: 'landing',
            OR: byLanding,
            deletedAt: null,
            ...(since ? { createdAt: { gte: since } } : {}),
          },
          select: { utmSource: true, utmCampaign: true, metadata: true },
        }),
        leads: await tx.lead.findMany({
          where: {
            OR: byLanding,
            convertedContractId: { not: null },
            deletedAt: null,
            // Por el día de la reserva (el contacto se gana al firmar).
            ...(since
              ? { OR: [{ bookedAt: { gte: since } }, { bookedAt: null, wonAt: { gte: since } }] }
              : {}),
          },
          select: {
            utmSource: true,
            utmCampaign: true,
            metadata: true,
            convertedContractId: true,
          },
        }),
      }),
      tenantId,
    );
    // Por el id de la landing (los nuevos) o, en los antiguos, por la campaña
    // de su dirección: cambiar la dirección no pierde reservas ni la hereda otra.
    const requests = requestRows.filter((l) => fromLanding(l, id, campaign));
    const leads = leadRows.filter((l) => fromLanding(l, id, campaign));
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

  async remove(tenantId: string, id: string, userId: string | null = null): Promise<void> {
    const landing = await this.findOrThrow(tenantId, id);
    await this.prisma.withTenant(async (tx) => {
      await tx.promoLanding.delete({ where: { id } });
      // Sus direcciones antiguas ya no llevan a ningún sitio.
      await forgetRedirectsTo(tx, { tenantId, kind: 'promo', targetId: id });
    }, tenantId);
    await this.forgetImage(tenantId, landing.heroImageKey);
    await this.audit.write({
      tenantId,
      userId,
      action: 'promo_landing.deleted',
      entityType: 'PromoLanding',
      entityId: id,
      changes: { name: landing.name, slug: landing.slug },
    });
  }

  /**
   * Borra una foto que ya no usa ninguna landing (las copias comparten la foto
   * de la original). Best-effort.
   */
  private async forgetImage(tenantId: string, key: string | null): Promise<void> {
    if (!key) return;
    const inUse = await this.prisma.withTenant(
      (tx) => tx.promoLanding.count({ where: { tenantId, heroImageKey: key } }),
      tenantId,
    );
    if (inUse > 0) return;
    await this.files.deleteObjects('public', [key]).catch(() => undefined);
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
    const current = await this.findOrThrow(tenantId, id);
    if (key) {
      if (!key.startsWith(`${tenantId}/promo/${id}/`)) {
        throw new BadRequestException({
          code: 'invalid_image_key',
          message: 'La imagen no pertenece a esta landing',
        });
      }
      await this.files.assertObjectMimeType(
        'public',
        key,
        PROMO_IMAGE_TYPES,
        PROMO_IMAGE_MAX_BYTES,
        { mustExist: true },
      );
    }
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.promoLanding.update({ where: { id }, data: { heroImageKey: key }, include: INCLUDE }),
      tenantId,
    );
    // La foto anterior, si ya no la usa ninguna landing.
    if (current.heroImageKey && current.heroImageKey !== key) {
      await this.forgetImage(tenantId, current.heroImageKey);
    }
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

  /**
   * La dirección corta `/<nombre>` no puede coincidir con una página fija de la
   * web, una página de ciudad ni un local del negocio (el local ganaría).
   */
  private async assertShortPathFree(tenantId: string, slug: string): Promise<void> {
    const facility = promoShortPathReserved(slug)
      ? null
      : await this.prisma.withTenant(
          (tx) =>
            tx.facility.findFirst({
              where: { tenantId, publicSlug: slug, deletedAt: null },
              select: { id: true },
            }),
          tenantId,
        );
    if (promoShortPathReserved(slug) || facility) {
      throw new ConflictException({
        code: 'promo_short_path_taken',
        message: facility
          ? 'Esa dirección corta es la de uno de tus locales. Cambia el nombre de la landing.'
          : 'Esa dirección corta está reservada para otra página de la web. Cambia el nombre de la landing.',
      });
    }
  }

  /** Si fue la dirección de un local, deja de redirigir: ahora es de esta landing. */
  private async forgetFacilityRedirect(tx: Prisma.TransactionClient, slug: string): Promise<void> {
    await tx.facilitySlugRedirect.deleteMany({ where: { oldSlug: slug } });
  }

  /**
   * El cupón debe ser del tenant. De los locales y tamaños se quedan los que
   * siguen existiendo (uno borrado mientras se editaba se quita sin dar error),
   * salvo que no quede ninguno: vacío significa «todos» y la promoción se
   * ampliaría sin querer.
   */
  private async cleanRefs(
    tenantId: string,
    refs: { couponId: string | null; facilityIds: string[]; unitTypeIds: string[] },
  ): Promise<{ facilityIds: string[]; unitTypeIds: string[] }> {
    const [coupon, facilities, types] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          refs.couponId
            ? tx.coupon.count({ where: { tenantId, id: refs.couponId } })
            : Promise.resolve(1),
          refs.facilityIds.length
            ? tx.facility.findMany({
                where: { tenantId, id: { in: refs.facilityIds }, deletedAt: null },
                select: { id: true },
              })
            : Promise.resolve([]),
          refs.unitTypeIds.length
            ? tx.unitType.findMany({
                where: { tenantId, id: { in: refs.unitTypeIds } },
                select: { id: true },
              })
            : Promise.resolve([]),
        ]),
      tenantId,
    );
    if (coupon === 0) {
      throw new BadRequestException({
        code: 'invalid_reference',
        message: 'El cupón elegido ya no existe. Elige otro o quítalo.',
      });
    }
    const keep = (ids: string[], found: { id: string }[]) => {
      const live = new Set(found.map((r) => r.id));
      return [...new Set(ids)].filter((x) => live.has(x));
    };
    const facilityIds = keep(refs.facilityIds, facilities);
    const unitTypeIds = keep(refs.unitTypeIds, types);
    if (refs.facilityIds.length > 0 && facilityIds.length === 0) {
      throw new BadRequestException({
        code: 'invalid_reference',
        message: 'Los locales elegidos ya no existen. Elige otros.',
      });
    }
    if (refs.unitTypeIds.length > 0 && unitTypeIds.length === 0) {
      throw new BadRequestException({
        code: 'invalid_reference',
        message: 'Los tamaños elegidos ya no existen. Elige otros.',
      });
    }
    return { facilityIds, unitTypeIds };
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
      shortPath: r.shortPath,
      content: parsePromoLandingContent(r.content),
      seoTitle: r.seoTitle,
      seoDescription: r.seoDescription,
      indexable: r.indexable,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
