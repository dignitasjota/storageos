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
