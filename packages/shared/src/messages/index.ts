import { z } from 'zod';

/**
 * Adjuntos de los mensajes (tickets de soporte y chat inquilino ↔ equipo):
 * imágenes y PDF, al bucket privado. Sin SVG ni HTML (se sirven desde el
 * dominio de ficheros).
 */
export const MESSAGE_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type MessageAttachmentMimeType = (typeof MESSAGE_ATTACHMENT_MIME_TYPES)[number];
export const MESSAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const MessageAttachmentUploadSchema = z.object({
  mimeType: z.enum(MESSAGE_ATTACHMENT_MIME_TYPES),
});
export type MessageAttachmentUploadInput = z.infer<typeof MessageAttachmentUploadSchema>;

/** El adjunto ya subido que acompaña al mensaje. */
export const MessageAttachmentSchema = z.object({
  key: z.string().min(1).max(300),
  mimeType: z.enum(MESSAGE_ATTACHMENT_MIME_TYPES),
  filename: z.string().trim().min(1).max(200),
});
export type MessageAttachmentInput = z.infer<typeof MessageAttachmentSchema>;

export interface MessageAttachmentUploadDto {
  uploadUrl: string;
  key: string;
  requiredHeaders: Record<string, string>;
}

export interface MessageAttachmentDto {
  /** URL firmada (unos minutos). */
  url: string;
  mimeType: string;
  filename: string;
}

/** Texto que representa un adjunto cuando el mensaje no lleva texto (avisos, vistas previas). */
export function attachmentLabel(filename: string): string {
  return `[Adjunto: ${filename}]`;
}

/** Mensajes por página de un hilo (se piden de más nuevos a más viejos). */
export const MESSAGE_THREAD_PAGE = 50;

const QUOTE_HEADER = [
  /^\s*(?:El|On)\b.{5,200}\b(?:escribi[óo]|wrote):\s*$/i,
  /^\s*-{2,}\s*(?:Mensaje original|Original Message|Forwarded message|Mensaje reenviado)/i,
  /^\s*_{5,}\s*$/,
  /^\s*(?:De|From):\s.+$/i,
];

/**
 * Lo escrito de verdad en una respuesta por correo: quita lo citado del correo
 * anterior. Si no queda nada, devuelve el texto entero (mejor citado que perdido).
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Gmail parte a veces la cabecera en dos líneas.
    const joined = `${line} ${lines[i + 1] ?? ''}`;
    if (
      line.startsWith('>') ||
      QUOTE_HEADER.some((re) => re.test(line)) ||
      QUOTE_HEADER[0]!.test(joined)
    ) {
      end = i;
      break;
    }
  }
  const kept = lines
    .slice(0, end)
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .trim();
  return kept || text.trim();
}
