import { DEFAULT_LEGAL_DOCUMENTS, type LegalDocumentDto, type LegalSlug } from '@storageos/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Carga un documento legal desde la API (editable por el super admin). Si la API
 * no responde o no hay contenido guardado, cae al contenido por defecto redactado
 * en `@storageos/shared`, de modo que la landing nunca queda sin texto.
 */
export async function fetchLegalDoc(slug: LegalSlug): Promise<LegalDocumentDto> {
  try {
    const res = await fetch(`${API_URL}/v1/platform-legal/${slug}`, {
      next: { revalidate: 300 },
    });
    if (res.ok) {
      const doc = (await res.json()) as LegalDocumentDto;
      if (doc?.content?.trim()) return doc;
    }
  } catch {
    /* usamos el fallback de abajo */
  }
  const def = DEFAULT_LEGAL_DOCUMENTS[slug];
  return { slug, title: def.title, content: def.content, updatedAt: null };
}
