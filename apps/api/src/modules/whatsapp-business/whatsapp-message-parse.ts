import { WHATSAPP_MEDIA_LABELS, type WhatsappMediaType } from '@storageos/shared';

/** Mensaje entrante tal como lo manda Meta (los campos que usamos). */
export interface WabaInboundMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: WabaMedia;
  audio?: WabaMedia;
  video?: WabaMedia;
  document?: WabaMedia;
  sticker?: WabaMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string; description?: string };
  };
}

interface WabaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

export interface ParsedInboundMessage {
  /** Texto que se guarda y se enseña (o la etiqueta del archivo). */
  body: string;
  media: {
    type: WhatsappMediaType;
    id: string;
    mime: string | null;
    filename: string | null;
  } | null;
}

const MEDIA_TYPES: WhatsappMediaType[] = ['image', 'audio', 'video', 'document', 'sticker'];

/**
 * Convierte un mensaje de Meta en lo que guarda la bandeja. Devuelve `null`
 * para lo que no se guarda (reacciones, mensajes no soportados…).
 */
export function parseWabaMessage(msg: WabaInboundMessage): ParsedInboundMessage | null {
  const type = msg.type ?? '';
  if (type === 'text') {
    const body = msg.text?.body?.trim();
    return body ? { body, media: null } : null;
  }
  if ((MEDIA_TYPES as string[]).includes(type)) {
    const mediaType = type as WhatsappMediaType;
    const m = msg[mediaType];
    if (!m?.id) return null;
    const label =
      mediaType === 'document' && m.filename
        ? `[${WHATSAPP_MEDIA_LABELS.document}: ${m.filename}]`
        : mediaType === 'audio' && m.voice
          ? '[Nota de voz]'
          : `[${WHATSAPP_MEDIA_LABELS[mediaType]}]`;
    return {
      body: m.caption?.trim() ? `${label} ${m.caption.trim()}` : label,
      media: {
        type: mediaType,
        id: m.id,
        mime: m.mime_type ?? null,
        filename: m.filename ?? null,
      },
    };
  }
  if (type === 'location' && msg.location) {
    const { latitude, longitude, name, address } = msg.location;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
    const place = [name, address].filter(Boolean).join(', ');
    return {
      body: `📍 ${place ? `${place} · ` : ''}https://maps.google.com/?q=${latitude},${longitude}`,
      media: null,
    };
  }
  if (type === 'button' && msg.button?.text) return { body: msg.button.text, media: null };
  if (type === 'interactive') {
    const title = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title;
    return title ? { body: title, media: null } : null;
  }
  return null;
}

/** Extensión para guardar el archivo según su tipo MIME. */
export function extensionForMime(mime: string | null, filename: string | null): string {
  const fromName = filename?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'application/pdf': 'pdf',
  };
  const base = (mime ?? '').split(';')[0]?.trim() ?? '';
  return map[base] ?? 'bin';
}
