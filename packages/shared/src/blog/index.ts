import { z } from 'zod';

/**
 * Blog del tenant: entradas de contenido para SEO en su web pública
 * (`/s/<slug>/blog`). Feature `web_premium`. El contenido es Markdown — se
 * renderiza con una whitelist de sintaxis (nunca HTML crudo del tenant).
 */
export interface BlogPostDto {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  contentMarkdown: string;
  /** URL pública de la imagen de portada, o null. */
  coverImageUrl: string | null;
  /** Texto alternativo de la portada (null = se usa el título). */
  coverImageAlt: string | null;
  /** Entradas relacionadas elegidas a mano, en orden (hasta 3). */
  relatedPostIds: string[];
  /** Override del `<title>` de la página; si no, se deriva de `title`. */
  seoTitle: string | null;
  /** Override de la meta description; si no, se deriva de `excerpt`. */
  seoDescription: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

export const CreateBlogPostSchema = z.object({
  /** Slug de la URL pública; si se omite, se genera del título. */
  slug: z.string().trim().max(120).optional().or(z.literal('')),
  title: z.string().trim().min(1, 'Obligatorio').max(200),
  excerpt: optionalText(500),
  contentMarkdown: z.string().trim().min(1, 'Obligatorio').max(50_000),
  seoTitle: optionalText(160),
  seoDescription: optionalText(300),
  coverImageAlt: optionalText(200),
  /** Hasta 3 entradas relacionadas; sin ninguna, la web enseña las últimas. */
  relatedPostIds: z.array(z.string().uuid()).max(3, 'Máximo 3 entradas').optional(),
  isPublished: z.boolean().optional(),
});
export type CreateBlogPostInput = z.infer<typeof CreateBlogPostSchema>;

export const UpdateBlogPostSchema = CreateBlogPostSchema.partial().refine(
  (v) => Object.values(v).some((field) => field !== undefined),
  { message: 'Debes enviar al menos un campo' },
);
export type UpdateBlogPostInput = z.infer<typeof UpdateBlogPostSchema>;

/** Solicitud de URL firmada para subir la imagen de portada de un post. */
export const RequestBlogCoverUploadSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024, 'Máximo 5 MB'),
  /** Nombre del fichero que verá Google (se limpia; sin él, uno aleatorio). */
  fileName: z.string().trim().max(120).optional(),
});
export type RequestBlogCoverUploadInput = z.infer<typeof RequestBlogCoverUploadSchema>;

export interface BlogCoverUploadResponseDto {
  uploadUrl: string;
  /** Key del objeto a confirmar al guardar el post (campo `coverImageKey`). */
  key: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
}

/** Confirma/quita la portada de un post por su key (o `null` para quitarla). */
export const SetBlogPostCoverSchema = z.object({
  coverImageKey: z.string().min(1).max(300).nullable(),
});
export type SetBlogPostCoverInput = z.infer<typeof SetBlogPostCoverSchema>;

export * from './content';
