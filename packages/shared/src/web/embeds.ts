/**
 * Helpers puros para embeber contenido de terceros en la web pública del
 * tenant (mapa del local + vídeo). Nunca se inyecta la URL del tenant
 * directamente en un `iframe`: se valida/transforma primero a un formato de
 * embed conocido (YouTube/Vimeo) y solo entonces se renderiza.
 */

/** URL de embed de Google Maps sin API key (`output=embed`). Prioriza coordenadas si existen. */
export function mapEmbedUrl(f: {
  address: string | null;
  city: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
}): string | null {
  if (f.latitude != null && f.longitude != null) {
    return `https://www.google.com/maps?q=${f.latitude},${f.longitude}&z=15&output=embed`;
  }
  const query = [f.address, f.postalCode, f.city].filter(Boolean).join(', ');
  return query ? `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed` : null;
}

/**
 * Convierte una URL de YouTube/Vimeo (cualquier formato habitual) a su URL de
 * embed. `null` si no es una URL válida o no es de un proveedor reconocido —
 * el frontend debe mostrar un enlace de respaldo en ese caso, nunca embeber
 * la URL tal cual.
 *
 * Parseo por regex (no `new URL`) para no depender de tipos DOM/Node en un
 * paquete isomorfo (se usa tanto en el API como en el frontend).
 */
export function toEmbedVideoUrl(url: string): string | null {
  const trimmed = url.trim();
  // Solo http(s) — evita esquemas peligrosos (`javascript:`, `data:`...).
  const match = trimmed.match(/^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!match) return null;
  const host = match[1]!
    .toLowerCase()
    .replace(/^(www\.|m\.)/, '')
    .split(':')[0];
  const path = match[2] ?? '';
  const query = match[3] ?? '';

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = query.match(/[?&]v=([\w-]+)/)?.[1];
    if (v) return `https://www.youtube.com/embed/${v}`;
    const id = path.match(/^\/(?:embed|shorts)\/([\w-]+)/)?.[1];
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host === 'youtu.be') {
    const id = path.match(/^\/([\w-]+)/)?.[1];
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host === 'vimeo.com') {
    const id = path.match(/^\/(\d+)/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  if (host === 'player.vimeo.com') {
    const id = path.match(/^\/video\/(\d+)/)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : null;
  }
  return null;
}
