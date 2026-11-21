import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PlatformHelpTopic } from '@storageos/database';
import {
  HELP_IMAGE_MAX_BYTES,
  HELP_IMAGE_MIME_TYPES,
  HELP_IMAGE_PREFIX,
  HELP_TOPIC_GROUPS,
  HELP_TOPICS,
  TenantFeatures,
  mergeHelpTopics,
  visibleHelpTopics,
} from '@storageos/shared';

import { TtlCache } from '../../common/cache/ttl-cache';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type {
  AdminHelpTopicDto,
  CreateHelpTopicInput,
  HelpImageUploadDto,
  HelpTopicContent,
  HelpTopicContentInput,
  HelpTopicDto,
  HelpTopicGroup,
  HelpTopicOverride,
  TenantFeature,
  UpdateHelpTopicInput,
} from '@storageos/shared';

/**
 * Guías de «Cómo funciona»: las del código (`HELP_TOPICS`) con lo que el
 * super admin haya cambiado, ocultado o añadido (`platform_help_topics`).
 */
@Injectable()
export class HelpTopicsService {
  /** Lo que ven los tenants, unos segundos en memoria (se vacía al guardar). */
  private readonly cache = new TtlCache<HelpTopicDto[]>(
    process.env.NODE_ENV === 'test' ? 0 : 30_000,
  );

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
  ) {}

  listForTenant(): Promise<HelpTopicDto[]> {
    return this.cache.get('visible', async () => visibleHelpTopics(await this.merged()));
  }

  listForAdmin(): Promise<AdminHelpTopicDto[]> {
    return this.merged();
  }

  async create(input: CreateHelpTopicInput): Promise<AdminHelpTopicDto> {
    if (HELP_TOPICS.some((t) => t.id === input.id)) {
      throw new ConflictException({
        code: 'help_topic_exists',
        message: 'Ya hay una guía con ese identificador',
      });
    }
    const existing = await this.admin.platformHelpTopic.findUnique({
      where: { topicId: input.id },
    });
    if (existing) {
      throw new ConflictException({
        code: 'help_topic_exists',
        message: 'Ya hay una guía con ese identificador',
      });
    }
    await this.checkImage(input.imageKey ?? null);
    await this.admin.platformHelpTopic.create({
      data: {
        topicId: input.id,
        ...contentData(input.content),
        imageKey: input.imageKey ?? null,
        videoUrl: input.videoUrl || null,
        position: input.position ?? null,
        published: input.published ?? true,
      },
    });
    return this.done(input.id);
  }

  async update(topicId: string, input: UpdateHelpTopicInput): Promise<AdminHelpTopicDto> {
    const fromCode = HELP_TOPICS.some((t) => t.id === topicId);
    const row = await this.admin.platformHelpTopic.findUnique({ where: { topicId } });
    if (!fromCode && !row) throw notFound();
    if (!fromCode && input.content === null) {
      throw new BadRequestException({
        code: 'help_topic_content_required',
        message: 'Una guía creada en el panel necesita su texto',
      });
    }

    const data: Prisma.PlatformHelpTopicUncheckedCreateInput = { topicId };
    if (input.content !== undefined) {
      Object.assign(data, input.content ? contentData(input.content) : emptyContent());
    }
    if (input.imageKey !== undefined) {
      await this.checkImage(input.imageKey ?? null);
      data.imageKey = input.imageKey ?? null;
    }
    if (input.videoUrl !== undefined) data.videoUrl = input.videoUrl || null;
    if (input.position !== undefined) data.position = input.position ?? null;
    if (input.published !== undefined) data.published = input.published;
    if (input.hidden !== undefined) data.hidden = input.hidden;

    const { topicId: _id, ...changes } = data;
    await this.admin.platformHelpTopic.upsert({
      where: { topicId },
      create: data,
      update: changes,
    });
    if (input.imageKey !== undefined) {
      await this.dropImage(row?.imageKey ?? null, input.imageKey ?? null);
    }
    return this.done(topicId);
  }

  /**
   * Una guía creada en el panel se borra; en una del código se quitan los
   * cambios (vuelve a la original y deja de estar oculta).
   */
  async remove(topicId: string): Promise<void> {
    const fromCode = HELP_TOPICS.some((t) => t.id === topicId);
    const row = await this.admin.platformHelpTopic.findUnique({ where: { topicId } });
    if (!row) {
      if (fromCode) return;
      throw notFound();
    }
    await this.admin.platformHelpTopic.delete({ where: { topicId } });
    await this.dropImage(row.imageKey, null);
    this.cache.clear();
  }

  /** URL firmada para subir la imagen de una guía al bucket público. */
  async requestImageUpload(mimeType: string): Promise<HelpImageUploadDto> {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const key = `${HELP_IMAGE_PREFIX}${randomUUID()}.${ext}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'public',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': mimeType } };
  }

  private async merged(): Promise<AdminHelpTopicDto[]> {
    const rows = await this.admin.platformHelpTopic.findMany({ orderBy: { createdAt: 'asc' } });
    return mergeHelpTopics(
      HELP_TOPICS,
      rows.map((r) => this.toOverride(r)),
    );
  }

  private async done(topicId: string): Promise<AdminHelpTopicDto> {
    this.cache.clear();
    const topic = (await this.merged()).find((t) => t.id === topicId);
    if (!topic) throw notFound();
    return topic;
  }

  private toOverride(row: PlatformHelpTopic): HelpTopicOverride {
    return {
      topicId: row.topicId,
      content: row.title ? rowContent(row) : null,
      imageUrl: row.imageKey ? this.files.buildPublicUrl('public', row.imageKey) : null,
      imageKey: row.imageKey,
      videoUrl: row.videoUrl,
      position: row.position,
      published: row.published,
      hidden: row.hidden,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Los bytes subidos son de verdad una imagen permitida y no pasan de 2 MB. */
  private async checkImage(key: string | null): Promise<void> {
    if (!key) return;
    if (!key.startsWith(HELP_IMAGE_PREFIX) || key.includes('..')) {
      throw new BadRequestException({ code: 'invalid_image_key', message: 'Imagen no válida' });
    }
    await this.files.assertObjectMimeType(
      'public',
      key,
      HELP_IMAGE_MIME_TYPES,
      HELP_IMAGE_MAX_BYTES,
    );
  }

  /** La imagen sustituida o quitada ya no la usa nadie: fuera del bucket. */
  private async dropImage(previous: string | null, current: string | null): Promise<void> {
    if (previous && previous !== current) {
      await this.files.deleteObjects('public', [previous]).catch(() => undefined);
    }
  }
}

function notFound(): NotFoundException {
  return new NotFoundException({ code: 'help_topic_not_found', message: 'La guía no existe' });
}

function contentData(c: HelpTopicContentInput) {
  return {
    group: c.group,
    title: c.title,
    summary: c.summary,
    steps: c.steps as Prisma.InputJsonValue,
    links: c.links as unknown as Prisma.InputJsonValue,
    keywords: c.keywords || null,
    feature: c.feature ?? null,
  };
}

function emptyContent() {
  return {
    group: null,
    title: null,
    summary: null,
    steps: Prisma.DbNull,
    links: Prisma.DbNull,
    keywords: null,
    feature: null,
  };
}

/** El texto guardado, a prueba de datos raros (los JSON no los valida la BD). */
function rowContent(row: PlatformHelpTopic): HelpTopicContent {
  const group = (HELP_TOPIC_GROUPS as readonly string[]).includes(row.group ?? '')
    ? (row.group as HelpTopicGroup)
    : 'Tu negocio';
  const steps = Array.isArray(row.steps)
    ? row.steps.filter((s): s is string => typeof s === 'string')
    : [];
  const links = Array.isArray(row.links)
    ? row.links.flatMap((l) => {
        if (!l || typeof l !== 'object' || Array.isArray(l)) return [];
        const { label, href } = l as Record<string, unknown>;
        return typeof label === 'string' && typeof href === 'string' ? [{ label, href }] : [];
      })
    : [];
  const feature = (TenantFeatures as readonly string[]).includes(row.feature ?? '')
    ? (row.feature as TenantFeature)
    : null;
  return {
    group,
    title: row.title ?? '',
    summary: row.summary ?? '',
    steps,
    links,
    keywords: row.keywords,
    feature,
  };
}
