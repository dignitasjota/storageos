import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { blogImageFileName, parseBlogPostDraft } from '@storageos/shared';

import { forgetOldSlug, forgetRedirectsTo, rememberOldSlug } from '../../common/web-slug-redirects';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';
import { LandingService } from '../landing/landing.service';

import { BLOG_POST_DRAFT_SYSTEM, businessFacts } from './web-draft-context';

import type { BlogPost, Prisma } from '@storageos/database';
import type {
  BlogPostDraftDto,
  BlogPostDto,
  CreateBlogPostInput,
  DraftBlogPostInput,
  UpdateBlogPostInput,
} from '@storageos/shared';

/** Tipos de imagen admitidos en el blog (portada e imágenes del texto). */
const BLOG_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Tamaño máximo de una imagen del blog (el mismo que admite la URL de subida). */
const BLOG_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Otra entrada del negocio ya usa esa dirección (dos guardados a la vez). */
function slugTaken(err: unknown): unknown {
  if ((err as { code?: string })?.code === 'P2002') {
    return new ConflictException({
      code: 'blog_slug_taken',
      message: 'Ya hay otra entrada con esa dirección. Prueba con otra.',
    });
  }
  return err;
}

/** La fecha programada debe ser futura (con un minuto de margen). */
function scheduledDate(iso: string): Date {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now() + 60_000) {
    throw new BadRequestException({
      code: 'publish_at_in_past',
      message: 'La fecha y hora de publicación deben ser futuras.',
    });
  }
  return at;
}

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
    private readonly audit: AuditService,
    private readonly landing: LandingService,
    private readonly ai: AiService,
  ) {}

  /**
   * Borrador con IA de una entrada a partir de un tema y unas palabras clave,
   * con los datos reales del negocio (locales, ciudades, tamaños y precios con
   * IVA). Gasta una consulta del asistente; si la respuesta no se puede leer,
   * se devuelve. No guarda nada: el formulario lo rellena para revisarlo.
   */
  async draft(
    tenantId: string,
    userId: string,
    input: DraftBlogPostInput,
  ): Promise<BlogPostDraftDto> {
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
      tenantId,
    );
    if (!tenant) {
      throw new NotFoundException({ code: 'tenant_not_found', message: 'No encontrado' });
    }
    const [site, titles] = await Promise.all([
      this.landing.getBySlug(tenant.slug),
      this.prisma.withTenant(
        (tx) =>
          tx.blogPost.findMany({
            where: { tenantId },
            select: { title: true },
            orderBy: { createdAt: 'desc' },
            take: 30,
          }),
        tenantId,
      ),
    ]);
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
      feature: 'blog_post_draft',
      system: BLOG_POST_DRAFT_SYSTEM,
      user: [
        businessFacts(site),
        '',
        `Tema de la entrada: ${input.topic}`,
        input.keywords ? `Palabras clave: ${input.keywords}` : '',
        titles.length > 0
          ? `Entradas que ya tiene el blog (no las repitas): ${titles.map((t) => t.title).join(' | ')}`
          : '',
        'Redacta la entrada.',
      ]
        .filter(Boolean)
        .join('\n'),
      // Si la respuesta no se puede leer, la consulta se devuelve.
      accept: (reply) => parseBlogPostDraft(reply) !== null,
      rejected: () => failed(false),
    });
    const draft = parseBlogPostDraft(text);
    if (!draft) throw failed(true);
    return draft;
  }

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

  async create(
    tenantId: string,
    input: CreateBlogPostInput,
    userId: string | null = null,
  ): Promise<BlogPostDto> {
    // Programada: queda en borrador hasta la fecha.
    const publishAt = input.publishAt ? scheduledDate(input.publishAt) : null;
    const isPublished = publishAt ? false : (input.isPublished ?? false);
    const created = await this.prisma
      .withTenant(async (tx) => {
        const base = slugify(input.slug?.trim() || input.title);
        const slug = await this.freeSlug(tx, tenantId, base);
        // Si era la dirección antigua de otra entrada, ahora es de esta.
        await forgetOldSlug(tx, { tenantId, kind: 'blog', slug });
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
            publishAt,
          },
        });
      }, tenantId)
      .catch((err: unknown) => {
        throw slugTaken(err);
      });
    await this.audit.write({
      tenantId,
      userId,
      action: 'blog_post.created',
      entityType: 'BlogPost',
      entityId: created.id,
      changes: {
        title: created.title,
        slug: created.slug,
        isPublished,
        ...(publishAt ? { publishAt: publishAt.toISOString() } : {}),
      },
    });
    return this.toDto(created);
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateBlogPostInput,
    userId: string | null = null,
  ): Promise<BlogPostDto> {
    const existing = await this.findOrThrow(tenantId, id);
    const willBePublished = input.isPublished ?? existing.isPublished;
    let publishAt: Date | null | undefined;
    if (input.publishAt) {
      if (willBePublished) {
        throw new BadRequestException({
          code: 'blog_post_already_published',
          message: 'La entrada ya está publicada. Despublícala si quieres programarla.',
        });
      }
      publishAt = scheduledDate(input.publishAt);
    } else if (input.publishAt === null || input.isPublished === true) {
      // Cancelar la programación, o publicar ya (deja de estar programada).
      publishAt = null;
    }
    const updated = await this.prisma
      .withTenant(async (tx) => {
        const data: Prisma.BlogPostUpdateInput = {};
        if (publishAt !== undefined) data.publishAt = publishAt;
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
        const row = await tx.blogPost.update({ where: { id }, data });
        // La dirección antigua sigue llevando a la entrada (308 a la nueva).
        await rememberOldSlug(tx, {
          tenantId,
          kind: 'blog',
          oldSlug: existing.slug,
          newSlug: row.slug,
          targetId: id,
        });
        return row;
      }, tenantId)
      .catch((err: unknown) => {
        throw slugTaken(err);
      });
    // Rastro de lo que cambia lo que ve el público: publicar, despublicar y la dirección.
    const changes: Record<string, unknown> = {};
    if (updated.isPublished !== existing.isPublished) changes.isPublished = updated.isPublished;
    if (updated.slug !== existing.slug) changes.slug = { from: existing.slug, to: updated.slug };
    const scheduleChanged =
      (updated.publishAt?.getTime() ?? null) !== (existing.publishAt?.getTime() ?? null);
    if (scheduleChanged) changes.publishAt = updated.publishAt?.toISOString() ?? null;
    // Título y descripción para Google: SEO Avanzado los propone como actuación.
    const seoChanged =
      updated.title !== existing.title ||
      updated.seoTitle !== existing.seoTitle ||
      updated.seoDescription !== existing.seoDescription;
    if (seoChanged) changes.seo = { slug: updated.slug };
    if (Object.keys(changes).length > 0) {
      await this.audit.write({
        tenantId,
        userId,
        action:
          updated.slug !== existing.slug
            ? 'blog_post.slug_changed'
            : updated.isPublished !== existing.isPublished
              ? updated.isPublished
                ? 'blog_post.published'
                : 'blog_post.unpublished'
              : seoChanged && !scheduleChanged
                ? 'blog_post.seo_changed'
                : updated.publishAt
                  ? 'blog_post.scheduled'
                  : 'blog_post.schedule_cancelled',
        entityType: 'BlogPost',
        entityId: id,
        changes: { title: updated.title, ...changes },
      });
    }
    return this.toDto(updated);
  }

  /**
   * Entradas relacionadas: del tenant, sin repetir y sin la propia. Las que ya
   * no existen (se borraron mientras se editaba) se quitan sin dar error.
   */
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
    const found = await tx.blogPost.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true },
    });
    const existing = new Set(found.map((p) => p.id));
    return unique.filter((id) => existing.has(id));
  }

  async remove(tenantId: string, id: string, userId: string | null = null): Promise<void> {
    const existing = await this.findOrThrow(tenantId, id);
    await this.prisma.withTenant(async (tx) => {
      await tx.blogPost.delete({ where: { id } });
      // Sus direcciones antiguas ya no llevan a ningún sitio.
      await forgetRedirectsTo(tx, { tenantId, kind: 'blog', targetId: id });
      // Las entradas que la tenían como relacionada dejan de apuntar a ella.
      const others = await tx.blogPost.findMany({
        where: { tenantId, relatedPostIds: { has: id } },
        select: { id: true, relatedPostIds: true },
      });
      for (const p of others) {
        await tx.blogPost.update({
          where: { id: p.id },
          data: { relatedPostIds: p.relatedPostIds.filter((x) => x !== id) },
        });
      }
    }, tenantId);
    // Su portada ya no la usa nadie.
    if (existing.coverImageKey) {
      await this.files
        .deleteObjects('public', [existing.coverImageKey])
        .catch((err) => this.logger.warn(`blog cover cleanup failed: ${String(err)}`));
    }
    await this.audit.write({
      tenantId,
      userId,
      action: 'blog_post.deleted',
      entityType: 'BlogPost',
      entityId: id,
      changes: { title: existing.title, slug: existing.slug },
    });
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
    await this.files.assertObjectMimeType('public', key, BLOG_IMAGE_TYPES, BLOG_IMAGE_MAX_BYTES, {
      mustExist: true,
    });
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
      await this.files.assertObjectMimeType(
        'public',
        coverImageKey,
        BLOG_IMAGE_TYPES,
        BLOG_IMAGE_MAX_BYTES,
        { mustExist: true },
      );
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
      publishAt: row.publishAt ? row.publishAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
