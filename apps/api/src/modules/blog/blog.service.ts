import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { blogImageFileName } from '@storageos/shared';

import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { BlogPost, Prisma } from '@storageos/database';
import type { BlogPostDto, CreateBlogPostInput, UpdateBlogPostInput } from '@storageos/shared';

/** Slug URL-safe a partir de un texto (sin acentos, minúsculas, guiones). */
function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * Blog del tenant (SEO de contenido, feature `web_premium`). El staff lo
 * gestiona desde el panel; `LandingService` sirve las entradas publicadas en
 * la web pública (`/s/<slug>/blog`).
 */
@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async list(tenantId: string): Promise<BlogPostDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.blogPost.findMany({ where: { tenantId }, orderBy: [{ createdAt: 'desc' }] }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<BlogPostDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  /** Busca un slug libre en el tenant a partir de un base (con sufijo -N). */
  private async freeSlug(
    tx: Prisma.TransactionClient,
    tenantId: string,
    base: string,
    excludeId?: string,
  ): Promise<string> {
    const root = base || 'post';
    let candidate = root;
    let n = 1;
    for (;;) {
      const clash = await tx.blogPost.findFirst({
        where: { tenantId, slug: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { id: true },
      });
      if (!clash) return candidate;
      n += 1;
      candidate = `${root}-${n}`;
    }
  }

  async create(tenantId: string, input: CreateBlogPostInput): Promise<BlogPostDto> {
    const isPublished = input.isPublished ?? false;
    const created = await this.prisma.withTenant(async (tx) => {
      const base = slugify(input.slug?.trim() || input.title);
      const slug = await this.freeSlug(tx, tenantId, base);
      return tx.blogPost.create({
        data: {
          tenantId,
          slug,
          title: input.title.trim(),
          excerpt: input.excerpt?.trim() || null,
          contentMarkdown: input.contentMarkdown,
          seoTitle: input.seoTitle?.trim() || null,
          seoDescription: input.seoDescription?.trim() || null,
          coverImageAlt: input.coverImageAlt?.trim() || null,
          relatedPostIds: await this.checkRelated(tx, tenantId, input.relatedPostIds),
          isPublished,
          publishedAt: isPublished ? new Date() : null,
        },
      });
    }, tenantId);
    return this.toDto(created);
  }

  async update(tenantId: string, id: string, input: UpdateBlogPostInput): Promise<BlogPostDto> {
    const existing = await this.findOrThrow(tenantId, id);
    const updated = await this.prisma.withTenant(async (tx) => {
      const data: Prisma.BlogPostUpdateInput = {};
      if (input.slug !== undefined) {
        const base = slugify(input.slug?.trim() || existing.title);
        data.slug = await this.freeSlug(tx, tenantId, base, id);
      }
      if (input.title !== undefined) data.title = input.title.trim();
      if (input.excerpt !== undefined) data.excerpt = input.excerpt?.trim() || null;
      if (input.contentMarkdown !== undefined) data.contentMarkdown = input.contentMarkdown;
      if (input.seoTitle !== undefined) data.seoTitle = input.seoTitle?.trim() || null;
      if (input.seoDescription !== undefined) {
        data.seoDescription = input.seoDescription?.trim() || null;
      }
      if (input.coverImageAlt !== undefined) {
        data.coverImageAlt = input.coverImageAlt?.trim() || null;
      }
      if (input.relatedPostIds !== undefined) {
        data.relatedPostIds = await this.checkRelated(tx, tenantId, input.relatedPostIds, id);
      }
      if (input.isPublished !== undefined) {
        data.isPublished = input.isPublished;
        // Publicar por primera vez fija la fecha; despublicar la conserva (si
        // se vuelve a publicar luego, no se pisa la fecha original).
        if (input.isPublished && !existing.publishedAt) data.publishedAt = new Date();
      }
      return tx.blogPost.update({ where: { id }, data });
    }, tenantId);
    return this.toDto(updated);
  }

  /** Entradas relacionadas: del tenant, sin repetir y sin la propia. */
  private async checkRelated(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ids: string[] | undefined,
    selfId?: string,
  ): Promise<string[]> {
    const unique = [...new Set(ids ?? [])];
    if (unique.length === 0) return [];
    if (selfId && unique.includes(selfId)) {
      throw new BadRequestException({
        code: 'related_post_self',
        message: 'Una entrada no puede ser relacionada de sí misma',
      });
    }
    const found = await tx.blogPost.count({ where: { tenantId, id: { in: unique } } });
    if (found !== unique.length) {
      throw new BadRequestException({
        code: 'related_post_not_found',
        message: 'Alguna entrada relacionada no existe',
      });
    }
    return unique;
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOrThrow(tenantId, id);
    await this.prisma.withTenant((tx) => tx.blogPost.delete({ where: { id } }), tenantId);
  }

  async requestCoverUploadUrl(args: {
    tenantId: string;
    id: string;
    mimeType: string;
    sizeBytes: number;
    fileName?: string;
  }): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
    await this.findOrThrow(args.tenantId, args.id);
    const fileName = args.fileName ? blogImageFileName(args.fileName) : '';
    const key = this.files.buildBlogCoverImageKey(
      args.tenantId,
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

  /** URL firmada para subir una imagen del texto del post (sin post: vale antes de guardarlo). */
  async requestImageUploadUrl(args: {
    tenantId: string;
    mimeType: string;
    sizeBytes: number;
    fileName?: string;
  }): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
    const fileName = args.fileName ? blogImageFileName(args.fileName) : '';
    const key = this.files.buildBlogBodyImageKey(
      args.tenantId,
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

  /** Comprueba la imagen subida (del tenant y una imagen de verdad) y da su dirección. */
  async confirmImage(tenantId: string, key: string): Promise<{ url: string }> {
    if (!key.startsWith(`${tenantId}/blog/images/`) || key.includes('..')) {
      throw new NotFoundException({
        code: 'invalid_image_key',
        message: 'La imagen no pertenece a este negocio',
      });
    }
    await this.files.assertObjectMimeType('public', key, ['image/jpeg', 'image/png', 'image/webp']);
    return { url: this.files.buildPublicUrl('public', key) };
  }

  /** Confirma (o quita, con `null`) la portada por su key. */
  async setCover(tenantId: string, id: string, coverImageKey: string | null): Promise<BlogPostDto> {
    const existing = await this.findOrThrow(tenantId, id);
    if (coverImageKey) {
      const prefix = `${tenantId}/blog/${id}/`;
      if (!coverImageKey.startsWith(prefix)) {
        throw new NotFoundException({
          code: 'invalid_image_key',
          message: 'La imagen no pertenece a este post',
        });
      }
      // Bytes reales, no solo el Content-Type declarado al pedir la URL.
      await this.files.assertObjectMimeType('public', coverImageKey, [
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
    }
    const updated = await this.prisma.withTenant(
      (tx) => tx.blogPost.update({ where: { id }, data: { coverImageKey } }),
      tenantId,
    );
    // La portada anterior ya no la usa nadie.
    if (existing.coverImageKey && existing.coverImageKey !== coverImageKey) {
      await this.files
        .deleteObjects('public', [existing.coverImageKey])
        .catch((err) => this.logger.warn(`blog cover cleanup failed: ${String(err)}`));
    }
    return this.toDto(updated);
  }

  private async findOrThrow(tenantId: string, id: string): Promise<BlogPost> {
    const row = await this.prisma.withTenant(
      (tx) => tx.blogPost.findFirst({ where: { id, tenantId } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'blog_post_not_found',
        message: 'Entrada no encontrada',
      });
    }
    return row;
  }

  private toDto(row: BlogPost): BlogPostDto {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      contentMarkdown: row.contentMarkdown,
      coverImageUrl: row.coverImageKey
        ? this.files.buildPublicUrl('public', row.coverImageKey)
        : null,
      coverImageAlt: row.coverImageAlt,
      relatedPostIds: row.relatedPostIds,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      isPublished: row.isPublished,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
