import { z } from 'zod';

/**
 * Borrador con IA de una entrada del blog: a partir de un tema y unas palabras
 * clave propone título, resumen, texto en Markdown y SEO con los datos reales
 * del negocio. No se guarda: rellena el formulario para revisarlo.
 */
export const DraftBlogPostSchema = z.object({
  topic: z.string().trim().min(3, 'Escribe de qué va la entrada').max(300),
  keywords: z.string().trim().max(300).optional().or(z.literal('')),
});
export type DraftBlogPostInput = z.infer<typeof DraftBlogPostSchema>;

export interface BlogPostDraftDto {
  title: string;
  excerpt: string | null;
  contentMarkdown: string;
  seoTitle: string | null;
  seoDescription: string | null;
}

/** Texto recortado a `max` caracteres (sin cortar a media palabra si se puede). */
export function clipDraftText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

/** El primer objeto JSON de la respuesta del modelo, o null si no se puede leer. */
export function draftJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Lee la respuesta del modelo: null si falta el título o el texto. */
export function parseBlogPostDraft(text: string): BlogPostDraftDto | null {
  const raw = draftJsonObject(text);
  if (!raw) return null;
  const title = clipDraftText(raw.title, 200);
  // El texto no se recorta a media frase: si se pasa del máximo, no vale.
  const content = typeof raw.contentMarkdown === 'string' ? raw.contentMarkdown.trim() : '';
  if (!title || content.length < 50 || content.length > 50_000) return null;
  return {
    title,
    excerpt: clipDraftText(raw.excerpt, 500),
    contentMarkdown: content,
    seoTitle: clipDraftText(raw.seoTitle, 160),
    seoDescription: clipDraftText(raw.seoDescription, 300),
  };
}
