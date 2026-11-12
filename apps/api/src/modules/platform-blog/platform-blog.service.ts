import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { blogImageFileName, readingMinutes } from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type { PlatformBlogPost, Prisma } from '@storageos/database';
import type {
  CreatePlatformBlogPostInput,
  PlatformBlogPostDto,
  PublicPlatformBlogPostDto,
  PublicPlatformBlogPostSummaryDto,
  UpdatePlatformBlogPostInput,
} from '@storageos/shared';

/** Slug URL-safe a partir de un texto (sin acentos, minúsculas, guiones). */
function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/** Prefijo de las portadas en el bucket público (`platform/blog/<id>/…`). */
const COVER_OWNER = 'platform';

/**
 * Blog de la web de TrasterOS (`trasteros.pro/blog`). Lo escribe el super
 * admin; la web pública solo ve las entradas publicadas.
 */
@Injectable()
export class PlatformBlogService {
  private readonly logger = new Logger(PlatformBlogService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
  ) {}

  // ── Panel admin ─────────────────────────────────────────────────────────

  async list(): Promise<PlatformBlogPostDto[]> {
    const rows = await this.admin.platformBlogPost.findMany({
      orderBy: [{ isPublished: 'asc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(id: string): Promise<PlatformBlogPostDto> {
    return this.toDto(await this.findOrThrow(id));
  }

  async create(input: CreatePlatformBlogPostInput): Promise<PlatformBlogPostDto> {
    const slug = await this.freeSlug(slugify(input.slug?.trim() || input.title));
    const publish = input.isPublished === true;
    const row = await this.admin.platformBlogPost.create({
      data: {
        slug,
        title: input.title.trim(),
        excerpt: input.excerpt?.trim() || null,
        contentMarkdown: input.contentMarkdown,
        seoTitle: input.seoTitle?.trim() || null,
        seoDescription: input.seoDescription?.trim() || null,
        coverImageAlt: input.coverImageAlt?.trim() || null,
        isPublished: publish,
        publishedAt: publish ? new Date() : null,
      },
    });
    return this.toDto(row);
  }

  async update(id: string, input: UpdatePlatformBlogPostInput): Promise<PlatformBlogPostDto> {
    const existing = await this.findOrThrow(id);
    const data: Prisma.PlatformBlogPostUpdateInput = {};
    if (input.title !== undefined) data.title = input.title.trim();
    if (input.slug !== undefined) {
      const base = slugify(input.slug?.trim() || existing.title);
      if (base !== existing.slug) data.slug = await this.freeSlug(base, id);
    }
    if (input.excerpt !== undefined) data.excerpt = input.excerpt?.trim() || null;
    if (input.contentMarkdown !== undefined) data.contentMarkdown = input.contentMarkdown;
    if (input.seoTitle !== undefined) data.seoTitle = input.seoTitle?.trim() || null;
    if (input.seoDescription !== undefined)
      data.seoDescription = input.seoDescription?.trim() || null;
    if (input.coverImageAlt !== undefined) data.coverImageAlt = input.coverImageAlt?.trim() || null;
    if (input.isPublished !== undefined) {
      data.isPublished = input.isPublished;
      // La fecha de publicación se fija la primera vez y no se mueve al
      // despublicar y volver a publicar (es la que ven el lector y Google).
      if (input.isPublished && !existing.publishedAt) data.publishedAt = new Date();
    }
    const row = await this.admin.platformBlogPost.update({ where: { id }, data });
    return this.toDto(row);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.findOrThrow(id);
    await this.admin.platformBlogPost.delete({ where: { id } });
    if (existing.coverImageKey) {
      await this.files
        .deleteObjects('public', [existing.coverImageKey])
        .catch((err) => this.logger.warn(`[blog] no se borró la portada: ${String(err)}`));
    }
  }

  async requestCoverUpload(args: {
    id: string;
    mimeType: string;
    sizeBytes: number;
    fileName?: string;
  }): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
    await this.findOrThrow(args.id);
    const fileName = args.fileName ? blogImageFileName(args.fileName) : '';
    const key = this.files.buildBlogCoverImageKey(
      COVER_OWNER,
      args.id,
      args.mimeType,
      fileName || undefined,
    );
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: args.mimeType,
      contentLengthRange: { min: 1, max: args.sizeBytes },
    });
    return { uploadUrl, key, expiresIn };
  }

  async setCover(id: string, coverImageKey: string | null): Promise<PlatformBlogPostDto> {
    const existing = await this.findOrThrow(id);
    if (coverImageKey) {
      if (!coverImageKey.startsWith(`${COVER_OWNER}/blog/${id}/`)) {
        throw new BadRequestException({
          code: 'invalid_cover_key',
          message: 'La imagen no es de esta entrada',
        });
      }
      await this.files.assertObjectMimeType('public', coverImageKey, [
        'image/png',
        'image/jpeg',
        'image/webp',
      ]);
    }
    const row = await this.admin.platformBlogPost.update({
      where: { id },
      data: { coverImageKey },
    });
    if (existing.coverImageKey && existing.coverImageKey !== coverImageKey) {
      await this.files
        .deleteObjects('public', [existing.coverImageKey])
        .catch((err) => this.logger.warn(`[blog] no se borró la portada anterior: ${String(err)}`));
    }
    return this.toDto(row);
  }

  // ── Web pública ─────────────────────────────────────────────────────────

  async listPublished(): Promise<PublicPlatformBlogPostSummaryDto[]> {
    const rows = await this.admin.platformBlogPost.findMany({
      where: { isPublished: true },
      orderBy: { publishedAt: 'desc' },
    });
    return rows.map((r) => this.toSummary(r));
  }

  async getPublished(slug: string): Promise<PublicPlatformBlogPostDto> {
    const row = await this.admin.platformBlogPost.findFirst({
      where: { slug, isPublished: true },
    });
    if (!row) throw new NotFoundException({ code: 'post_not_found', message: 'No existe' });
    const related = await this.admin.platformBlogPost.findMany({
      where: { isPublished: true, id: { not: row.id } },
      orderBy: { publishedAt: 'desc' },
      take: 3,
    });
    return {
      ...this.toSummary(row),
      contentMarkdown: row.contentMarkdown,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      updatedAt: row.updatedAt.toISOString(),
      related: related.map((r) => this.toSummary(r)),
    };
  }

  // ── Interno ─────────────────────────────────────────────────────────────

  private async findOrThrow(id: string): Promise<PlatformBlogPost> {
    const row = await this.admin.platformBlogPost.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'post_not_found', message: 'No existe' });
    return row;
  }

  /** El slug pedido, o con `-2`, `-3`… si ya lo usa otra entrada. */
  private async freeSlug(base: string, exceptId?: string): Promise<string> {
    const root = base || 'entrada';
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? root : `${root}-${n}`;
      const taken = await this.admin.platformBlogPost.findFirst({
        where: { slug: candidate, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    throw new BadRequestException({ code: 'slug_taken', message: 'Elige otra dirección' });
  }

  private coverUrl(row: PlatformBlogPost): string | null {
    return row.coverImageKey ? this.files.buildPublicUrl('public', row.coverImageKey) : null;
  }

  private toDto(row: PlatformBlogPost): PlatformBlogPostDto {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      contentMarkdown: row.contentMarkdown,
      coverImageUrl: this.coverUrl(row),
      coverImageAlt: row.coverImageAlt,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      isPublished: row.isPublished,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toSummary(row: PlatformBlogPost): PublicPlatformBlogPostSummaryDto {
    return {
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      coverImageUrl: this.coverUrl(row),
      coverImageAlt: row.coverImageAlt || row.title,
      publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
      readingMinutes: readingMinutes(row.contentMarkdown),
    };
  }
}
