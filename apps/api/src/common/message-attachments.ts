import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  type MessageAttachmentDto,
  type MessageAttachmentInput,
  type MessageAttachmentUploadDto,
} from '@storageos/shared';

import type { FilesService } from '../modules/files/files.service';
import type { Prisma } from '@storageos/database';

/**
 * Adjuntos de los mensajes (tickets y chat): bucket privado `uploads`, una
 * carpeta por conversación (`prefix`), bytes comprobados al guardar y URL
 * firmada al leer.
 */
export interface StoredAttachment {
  key: string;
  mimeType: string;
  filename: string;
}

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

/** Lo que se guarda de los adjuntos de un mensaje: el primero, en sus columnas. */
export async function assertAttachments(
  files: FilesService,
  prefix: string,
  list: MessageAttachmentInput[],
): Promise<{
  attachmentKey?: string;
  attachmentMime?: string;
  attachmentName?: string;
  extraAttachments?: Prisma.InputJsonValue;
}> {
  const checked = await Promise.all(list.map((att) => assertAttachment(files, prefix, att)));
  const [first, ...rest] = checked;
  if (!first) return {};
  return {
    ...first,
    extraAttachments: rest.map(
      (a): StoredAttachment => ({
        key: a.attachmentKey,
        mimeType: a.attachmentMime,
        filename: a.attachmentName,
      }),
    ) as unknown as Prisma.InputJsonValue,
  };
}

/** Claves de todos los adjuntos de un mensaje guardado (para borrarlos). */
export function attachmentKeysOf(row: {
  attachmentKey: string | null;
  extraAttachments?: unknown;
}): string[] {
  return [
    ...(row.attachmentKey ? [row.attachmentKey] : []),
    ...((row.extraAttachments as StoredAttachment[] | null) ?? []).map((a) => a.key),
  ];
}

/** La URL de un adjunto no cambia en este tiempo: el hilo se refresca solo y sin esto
 * cada refresco volvería a descargar todas las fotos. */
const STABLE_URL_MS = 5 * 60 * 1000;

/** URL firmada (de 10 a 15 min) del adjunto de un mensaje, o null si no tiene. */
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
    900,
    // Los PDF se descargan; las imágenes se ven en el hilo.
    row.attachmentMime === 'application/pdf' ? name : undefined,
    new Date(Math.floor(Date.now() / STABLE_URL_MS) * STABLE_URL_MS),
  );
  return { url, mimeType: row.attachmentMime ?? 'application/octet-stream', filename: name };
}

/** Todos los adjuntos de un mensaje con su URL firmada. */
export async function attachmentsDto(
  files: FilesService,
  row: {
    attachmentKey: string | null;
    attachmentMime: string | null;
    attachmentName: string | null;
    extraAttachments?: unknown;
  },
): Promise<MessageAttachmentDto[]> {
  const extras = (row.extraAttachments as StoredAttachment[] | null) ?? [];
  const all = await Promise.all([
    attachmentDto(files, row),
    ...extras.map((a) =>
      attachmentDto(files, {
        attachmentKey: a.key,
        attachmentMime: a.mimeType,
        attachmentName: a.filename,
      }),
    ),
  ]);
  return all.filter((a): a is MessageAttachmentDto => a !== null);
}
