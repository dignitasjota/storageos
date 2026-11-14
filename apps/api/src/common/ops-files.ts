import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import {
  OPS_FILES_MAX,
  type AddOpsFileInput,
  type MessageAttachmentUploadDto,
  type OpsFileDto,
} from '@storageos/shared';

import { assertAttachment, requestAttachmentUpload } from './message-attachments';

import type { FilesService } from '../modules/files/files.service';
import type { Prisma } from '@storageos/database';

/**
 * Fotos y documentos de tareas, incidencias y vencimientos: bucket privado
 * `uploads`, una carpeta por registro (`prefix`), bytes comprobados al guardar
 * y URL firmada al leer. Se guardan en una columna JSON.
 */
export interface StoredOpsFile {
  id: string;
  key: string;
  mimeType: string;
  filename: string;
  createdAt: string;
}

/** Lo guardado, sin lo que no tenga forma de fichero. */
export function readOpsFiles(raw: unknown): StoredOpsFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is StoredOpsFile =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as StoredOpsFile).id === 'string' &&
      typeof (f as StoredOpsFile).key === 'string',
  );
}

export function opsFileUploadUrl(
  files: FilesService,
  prefix: string,
  mimeType: string,
): Promise<MessageAttachmentUploadDto> {
  return requestAttachmentUpload(files, prefix, mimeType);
}

/** Comprueba el fichero subido (carpeta y bytes) y lo añade a la lista. */
export async function addOpsFile(
  files: FilesService,
  prefix: string,
  current: StoredOpsFile[],
  input: AddOpsFileInput,
): Promise<StoredOpsFile[]> {
  if (current.length >= OPS_FILES_MAX) {
    throw new BadRequestException({
      code: 'too_many_files',
      message: `Como mucho ${OPS_FILES_MAX} fotos o documentos`,
    });
  }
  if (current.some((f) => f.key === input.key)) return current;
  const checked = await assertAttachment(files, prefix, input);
  return [
    ...current,
    {
      id: randomUUID(),
      key: checked.attachmentKey,
      mimeType: checked.attachmentMime,
      filename: checked.attachmentName,
      createdAt: new Date().toISOString(),
    },
  ];
}

/** Quita un fichero de la lista (y lo borra del almacenamiento). */
export async function removeOpsFile(
  files: FilesService,
  current: StoredOpsFile[],
  fileId: string,
): Promise<StoredOpsFile[]> {
  const target = current.find((f) => f.id === fileId);
  if (!target) {
    throw new BadRequestException({ code: 'file_not_found', message: 'Fichero no encontrado' });
  }
  await files.deleteObjects('uploads', [target.key]).catch(() => undefined);
  return current.filter((f) => f.id !== fileId);
}

/** Para la respuesta: con URL firmada en la ficha, sin ella en las listas. */
export async function opsFilesDto(
  files: FilesService | null,
  list: StoredOpsFile[],
): Promise<OpsFileDto[]> {
  return Promise.all(
    list.map(async (f) => ({
      id: f.id,
      filename: f.filename,
      mimeType: f.mimeType,
      createdAt: f.createdAt,
      url: files ? await files.getPresignedGetUrl('uploads', f.key, 600).catch(() => '') : '',
    })),
  );
}

export const asJson = (list: StoredOpsFile[]): Prisma.InputJsonValue =>
  list as unknown as Prisma.InputJsonValue;
