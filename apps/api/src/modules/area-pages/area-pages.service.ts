import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AREA_PAGE_CITY_MIN_WORDS,
  AREA_PAGE_MIN_WORDS,
  MAX_NEARBY_AREA_PAGES,
  areaPageSlug,
  citySlug,
  resolveAreaPages,
  wordCount,
  type AreaPageOverviewDto,
  type AreaPagesSettingsDto,
  type CreateAreaPageInput,
  type UpdateAreaPageInput,
} from '@storageos/shared';

import { PrismaService } from '../database/prisma.service';

import { toAreaContent, toAreaPageDto } from './area-page.mapper';

import type { Prisma, WebAreaPage } from '@storageos/database';

/**
 * Páginas de zona de la web del tenant (`/trasteros-en-<zona>`): el texto propio
 * de la página de cada ciudad con locales y las páginas de zonas cercanas.
 * `LandingService` las sirve; la lógica de qué se muestra vive en shared
 * (`resolveAreaPages`).
 */
@Injectable()
export class AreaPagesService {
  constructor(private readonly prisma: PrismaService) {}

  async settings(tenantId: string): Promise<AreaPagesSettingsDto> {
    const { rows, facilities } = await this.prisma.withTenant(async (tx) => {
      const [rows, facilities] = await Promise.all([
        tx.webAreaPage.findMany({ where: { tenantId }, orderBy: { name: 'asc' } }),
        this.facilities(tx, tenantId),
      ]);
      return { rows, facilities };
    }, tenantId);

    const published = rows.filter((r) => r.isPublished);
    const resolved = resolveAreaPages(facilities, published.map(toAreaContent));
    const bySlug = new Map(rows.map((r) => [r.slug, r]));

    const overview: AreaPageOverviewDto[] = resolved.map((p) => {
      const row = bySlug.get(p.slug) ?? null;
      const words = wordCount(row?.intro);
      const warnings: AreaPageOverviewDto['warnings'] = [];
      if (p.kind === 'city' && p.redirect?.to !== 'home') {
        if (words === 0) warnings.push('no_intro');
        else if (words < AREA_PAGE_CITY_MIN_WORDS) warnings.push('short_intro');
      }
      if (p.kind === 'nearby' && words < AREA_PAGE_MIN_WORDS) warnings.push('short_intro');
      return {
        slug: p.slug,
        name: p.name,
        kind: p.kind,
        facilityNames: p.facilities.map((f) => f.name),
        pageId: row?.id ?? null,
        isPublished: row?.isPublished ?? true,
        redirect: p.redirect,
        indexable: p.indexable,
        introWords: words,
        warnings,
      };
    });
    // Las guardadas que no salen en la web: apagadas o sin locales.
    const shown = new Set(resolved.map((p) => p.slug));
    for (const r of rows) {
      if (shown.has(r.slug)) continue;
      overview.push({
        slug: r.slug,
        name: r.name,
        kind: 'nearby',
        facilityNames: facilities.filter((f) => r.facilityIds.includes(f.id)).map((f) => f.name),
        pageId: r.id,
        isPublished: r.isPublished,
        redirect: null,
        indexable: false,
        introWords: wordCount(r.intro),
        warnings: [r.isPublished ? 'no_facilities' : 'not_published'],
      });
    }

    return {
      pages: rows.map(toAreaPageDto),
      overview,
      singleFacility: facilities.length === 1,
    };
  }

  async create(tenantId: string, input: CreateAreaPageInput): Promise<AreaPagesSettingsDto> {
    const slug = areaPageSlug(input);
    if (!slug) {
      throw new BadRequestException({ code: 'invalid_slug', message: 'Nombre no válido' });
    }
    await this.prisma.withTenant(async (tx) => {
      const isCity = await this.isCity(tx, tenantId, slug);
      if (!isCity) {
        await this.assertFacilities(tx, tenantId, input.facilityIds);
        const nearby = await this.countNearby(tx, tenantId);
        if (nearby >= MAX_NEARBY_AREA_PAGES) {
          throw new BadRequestException({
            code: 'area_page_limit',
            message: `Como mucho ${MAX_NEARBY_AREA_PAGES} páginas de zonas cercanas.`,
          });
        }
      }
      try {
        await tx.webAreaPage.create({
          data: {
            tenantId,
            slug,
            name: input.name,
            facilityIds: isCity ? [] : input.facilityIds,
            nearestNote: isCity ? null : (input.nearestNote ?? null),
            intro: input.intro ?? null,
            nearbyAreas: input.nearbyAreas,
            faqs: input.faqs as Prisma.InputJsonValue,
            seoTitle: input.seoTitle ?? null,
            seoDescription: input.seoDescription ?? null,
            isPublished: input.isPublished,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          throw new ConflictException({
            code: 'area_page_slug_taken',
            message: 'Ya hay una página con esa dirección.',
          });
        }
        throw err;
      }
    }, tenantId);
    return this.settings(tenantId);
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateAreaPageInput,
  ): Promise<AreaPagesSettingsDto> {
    await this.prisma.withTenant(async (tx) => {
      const row = await this.findOrThrow(tx, tenantId, id);
      // La dirección solo cambia si se pide (cambiar el nombre no rompe enlaces).
      const slug = input.slug ? areaPageSlug({ name: row.name, slug: input.slug }) : row.slug;
      const isCity = await this.isCity(tx, tenantId, slug);
      if (!isCity && input.facilityIds)
        await this.assertFacilities(tx, tenantId, input.facilityIds);
      try {
        await tx.webAreaPage.update({
          where: { id },
          data: {
            slug,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.facilityIds !== undefined
              ? { facilityIds: isCity ? [] : input.facilityIds }
              : {}),
            ...(input.nearestNote !== undefined ? { nearestNote: input.nearestNote || null } : {}),
            ...(input.intro !== undefined ? { intro: input.intro || null } : {}),
            ...(input.nearbyAreas !== undefined ? { nearbyAreas: input.nearbyAreas } : {}),
            ...(input.faqs !== undefined ? { faqs: input.faqs as Prisma.InputJsonValue } : {}),
            ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle || null } : {}),
            ...(input.seoDescription !== undefined
              ? { seoDescription: input.seoDescription || null }
              : {}),
            ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') {
          throw new ConflictException({
            code: 'area_page_slug_taken',
            message: 'Ya hay una página con esa dirección.',
          });
        }
        throw err;
      }
    }, tenantId);
    return this.settings(tenantId);
  }

  async remove(tenantId: string, id: string): Promise<AreaPagesSettingsDto> {
    await this.prisma.withTenant(async (tx) => {
      await this.findOrThrow(tx, tenantId, id);
      await tx.webAreaPage.delete({ where: { id } });
    }, tenantId);
    return this.settings(tenantId);
  }

  private facilities(tx: Prisma.TransactionClient, tenantId: string) {
    return tx.facility.findMany({
      where: { tenantId, deletedAt: null, isActive: true },
      select: { id: true, name: true, city: true, publicSlug: true },
      orderBy: { name: 'asc' },
    });
  }

  private async isCity(
    tx: Prisma.TransactionClient,
    tenantId: string,
    slug: string,
  ): Promise<boolean> {
    const facilities = await this.facilities(tx, tenantId);
    return facilities.some((f) => f.city && citySlug(f.city) === slug);
  }

  private async countNearby(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
    const [rows, facilities] = await Promise.all([
      tx.webAreaPage.findMany({ where: { tenantId }, select: { slug: true } }),
      this.facilities(tx, tenantId),
    ]);
    const cities = new Set(facilities.flatMap((f) => (f.city ? [citySlug(f.city)] : [])));
    return rows.filter((r) => !cities.has(r.slug)).length;
  }

  private async assertFacilities(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) {
      throw new BadRequestException({
        code: 'area_page_facilities_required',
        message: 'Elige el local o los locales que se muestran en esta zona.',
      });
    }
    const found = await tx.facility.count({
      where: { tenantId, id: { in: ids }, deletedAt: null },
    });
    if (found !== new Set(ids).size) {
      throw new BadRequestException({ code: 'invalid_facility', message: 'Local no válido' });
    }
  }

  private async findOrThrow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<WebAreaPage> {
    const row = await tx.webAreaPage.findFirst({ where: { id, tenantId } });
    if (!row) {
      throw new NotFoundException({ code: 'area_page_not_found', message: 'No encontrada' });
    }
    return row;
  }
}
