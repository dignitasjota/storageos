import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  type MessageAttachmentDto,
  type MessageAttachmentInput,
  type MessageAttachmentUploadDto,
} from '@storageos/shared';

import type { FilesService } from '../modules/files/files.service';

/**
 * Adjuntos de los mensajes (tickets y chat): bucket privado `uploads`, una
 * carpeta por conversación (`prefix`), bytes comprobados al guardar y URL
 * firmada al leer.
 */
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export async function requestAttachmentUpload(
  files: FilesService,
  prefix: string,
  mimeType: string,
): Promise<MessageAttachmentUploadDto> {
  const key = `${prefix}${randomUUID()}.${EXT[mimeType] ?? 'bin'}`;
  const { uploadUrl } = await files.getPresignedPutUrl({
    bucket: 'uploads',
    key,
    contentType: mimeType,
  });
  return { uploadUrl, key, requiredHeaders: { 'Content-Type': mimeType } };
}

/** Comprueba que el adjunto es de esta conversación y que los bytes son los declarados. */
export async function assertAttachment(
  files: FilesService,
  prefix: string,
  att: MessageAttachmentInput,
): Promise<{ attachmentKey: string; attachmentMime: string; attachmentName: string }> {
  if (!att.key.startsWith(prefix) || att.key.includes('..')) {
    throw new BadRequestException({ code: 'invalid_attachment', message: 'Adjunto no válido' });
  }
  await files.assertObjectMimeType(
    'uploads',
    att.key,
    [att.mimeType],
    MESSAGE_ATTACHMENT_MAX_BYTES,
  );
  return {
    attachmentKey: att.key,
    attachmentMime: att.mimeType,
    attachmentName: att.filename.replace(/[\r\n"]/g, ' ').slice(0, 200),
  };
}

/** URL firmada (10 min) del adjunto de un mensaje, o null si no tiene. */
export async function attachmentDto(
  files: FilesService,
  row: {
    attachmentKey: string | null;
    attachmentMime: string | null;
    attachmentName: string | null;
  },
): Promise<MessageAttachmentDto | null> {
  if (!row.attachmentKey) return null;
  const name = row.attachmentName ?? 'adjunto';
  const url = await files.getPresignedGetUrl(
    'uploads',
    row.attachmentKey,
    600,
    // Los PDF se descargan; las imágenes se ven en el hilo.
    row.attachmentMime === 'application/pdf' ? name : undefined,
  );
  return { url, mimeType: row.attachmentMime ?? 'application/octet-stream', filename: name };
}
