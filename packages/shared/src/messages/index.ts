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
