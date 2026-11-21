import { z } from 'zod';

import { TenantFeatures, type TenantFeature } from '../features';
import { toEmbedVideoUrl } from '../web/embeds';

import { HELP_TOPIC_GROUPS, type HelpTopic } from './topics';

/** Id de una guía (ancla `/help#id`): minúsculas, números y guiones. */
export const HELP_TOPIC_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Enlace de una guía: solo a pantallas del panel (`/…`), nunca fuera. */
export const HELP_TOPIC_LINK_RE = /^\/(?![/\\])[^\s\\]*$/;

export const HELP_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const HELP_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Carpeta del bucket público donde van las imágenes de las guías. */
export const HELP_IMAGE_PREFIX = 'platform/help/';

export const HelpTopicLinkSchema = z.object({
  label: z.string().trim().min(1).max(60),
  href: z
    .string()
    .trim()
    .max(300)
    .regex(HELP_TOPIC_LINK_RE, 'Solo enlaces a pantallas del panel (empiezan por «/»)'),
});

export const HelpTopicContentSchema = z.object({
  group: z.enum(HELP_TOPIC_GROUPS),
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(3).max(300),
  steps: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
  links: z.array(HelpTopicLinkSchema).max(8),
  keywords: z.string().trim().max(300).nullish(),
  feature: z.enum(TenantFeatures).nullish(),
});
export type HelpTopicContentInput = z.infer<typeof HelpTopicContentSchema>;

/** URL de YouTube o Vimeo; `''` o null la quita. */
const VideoUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || toEmbedVideoUrl(v) !== null, 'Solo vídeos de YouTube o Vimeo')
  .nullish();

const ImageKeySchema = z
  .string()
  .max(300)
  .refine((k) => k.startsWith(HELP_IMAGE_PREFIX) && !k.includes('..'), 'Imagen no válida')
  .nullish();

/** Guía nueva (que no está en el código). */
export const CreateHelpTopicSchema = z.object({
  id: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(HELP_TOPIC_ID_RE, 'Solo minúsculas, números y guiones'),
  content: HelpTopicContentSchema,
  imageKey: ImageKeySchema,
  videoUrl: VideoUrlSchema,
  position: z.number().int().min(0).max(100000).nullish(),
  published: z.boolean().optional(),
});
export type CreateHelpTopicInput = z.infer<typeof CreateHelpTopicSchema>;

/**
 * Cambios de una guía (lo que no se envía no se toca). En una guía del código,
 * `content: null` vuelve a su texto original.
 */
export const UpdateHelpTopicSchema = z.object({
  content: HelpTopicContentSchema.nullable().optional(),
  imageKey: ImageKeySchema,
  videoUrl: VideoUrlSchema,
  position: z.number().int().min(0).max(100000).nullish(),
  published: z.boolean().optional(),
  hidden: z.boolean().optional(),
});
export type UpdateHelpTopicInput = z.infer<typeof UpdateHelpTopicSchema>;

export const RequestHelpImageUploadSchema = z.object({
  mimeType: z.enum(HELP_IMAGE_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(HELP_IMAGE_MAX_BYTES),
});
export type RequestHelpImageUploadInput = z.infer<typeof RequestHelpImageUploadSchema>;

/** Guía tal como la ve el panel del tenant. */
export type HelpTopicDto = HelpTopic & {
  /** Imagen de la guía (bucket público). */
  imageUrl: string | null;
  /** Vídeo ya convertido a su dirección de embed (YouTube/Vimeo). */
  videoEmbedUrl: string | null;
};

/** Guía en el panel de administración, con su origen y su estado. */
export type AdminHelpTopicDto = HelpTopicDto & {
  /** `code`: viene con la aplicación; `custom`: creada desde el panel. */
  source: 'code' | 'custom';
  /** Guía del código con el texto cambiado desde el panel. */
  edited: boolean;
  hidden: boolean;
  published: boolean;
  position: number;
  videoUrl: string | null;
  imageKey: string | null;
  updatedAt: string | null;
  /** La guía tal como viene en el código (null en las creadas). */
  original: HelpTopic | null;
};

export interface HelpImageUploadDto {
  uploadUrl: string;
  key: string;
  requiredHeaders: Record<string, string>;
}

/** Contenido guardado de una guía (lo que el panel cambia del código). */
export interface HelpTopicContent {
  group: HelpTopic['group'];
  title: string;
  summary: string;
  steps: string[];
  links: { label: string; href: string }[];
  keywords: string | null;
  feature: TenantFeature | null;
}
