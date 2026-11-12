import { z } from 'zod';

/**
 * Blog de la web de TrasterOS (`trasteros.pro/blog`): guías para quien gestiona
 * o va a abrir un negocio de trasteros. Lo escribe el super admin (panel admin →
 * Blog de TrasterOS). El contenido es Markdown, que se pinta con una lista
 * cerrada de sintaxis (nunca HTML).
 */
export interface PlatformBlogPostDto {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  contentMarkdown: string;
  coverImageUrl: string | null;
  coverImageAlt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Entrada en el listado público. */
export interface PublicPlatformBlogPostSummaryDto {
  slug: string;
  title: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  /** Texto alternativo de la portada (si no, el título). */
  coverImageAlt: string;
  publishedAt: string;
  /** Minutos de lectura aproximados. */
  readingMinutes: number;
}

/** Entrada publicada, con las tres más recientes para «Sigue leyendo». */
export interface PublicPlatformBlogPostDto extends PublicPlatformBlogPostSummaryDto {
  contentMarkdown: string;
  seoTitle: string | null;
  seoDescription: string | null;
  updatedAt: string;
  related: PublicPlatformBlogPostSummaryDto[];
}

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

export const CreatePlatformBlogPostSchema = z.object({
  /** Dirección pública; si se omite, se genera del título. */
  slug: optionalText(120),
  title: z.string().trim().min(1, 'Obligatorio').max(200),
  excerpt: optionalText(500),
  contentMarkdown: z.string().trim().min(1, 'Obligatorio').max(80_000),
  seoTitle: optionalText(160),
  seoDescription: optionalText(300),
  coverImageAlt: optionalText(200),
  isPublished: z.boolean().optional(),
});
export type CreatePlatformBlogPostInput = z.infer<typeof CreatePlatformBlogPostSchema>;

export const UpdatePlatformBlogPostSchema = CreatePlatformBlogPostSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
export type UpdatePlatformBlogPostInput = z.infer<typeof UpdatePlatformBlogPostSchema>;

export const RequestPlatformBlogCoverSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024, 'Máximo 5 MB'),
  /** Nombre del fichero que verá Google (se limpia; sin él, uno aleatorio). */
  fileName: z.string().trim().max(120).optional(),
});
export type RequestPlatformBlogCoverInput = z.infer<typeof RequestPlatformBlogCoverSchema>;

export const SetPlatformBlogCoverSchema = z.object({
  coverImageKey: z.string().min(1).max(300).nullable(),
});
export type SetPlatformBlogCoverInput = z.infer<typeof SetPlatformBlogCoverSchema>;

/** Minutos de lectura (unas 200 palabras por minuto, mínimo uno). */
export function readingMinutes(markdown: string): number {
  const words = markdown.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
