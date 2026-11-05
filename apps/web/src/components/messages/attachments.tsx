'use client';

import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MIME_TYPES,
  MESSAGE_MAX_ATTACHMENTS,
  type MessageAttachmentDto,
  type MessageAttachmentInput,
  type MessageAttachmentUploadDto,
} from '@storageos/shared';
import { FileText, Paperclip, X } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { compressImage } from '@/lib/images/compress';

type Mime = MessageAttachmentInput['mimeType'];

/**
 * Sube un adjunto (URL firmada → PUT directo al almacenamiento) y devuelve lo
 * que hay que mandar con el mensaje. `presign` pide la URL al API que toque
 * (panel, admin o portal).
 */
export async function uploadMessageAttachment(
  original: File,
  presign: (mimeType: Mime) => Promise<MessageAttachmentUploadDto>,
): Promise<MessageAttachmentInput> {
  // Una foto del móvil pesa varios MB y aquí no hace falta tanto.
  const file = await compressImage(original);
  const up = await presign(file.type as Mime);
  const put = await fetch(up.uploadUrl, { method: 'PUT', headers: up.requiredHeaders, body: file });
  if (!put.ok) throw new Error('upload_failed');
  return { key: up.key, mimeType: file.type as Mime, filename: file.name.slice(0, 200) };
}

/** Sube varios adjuntos, uno detrás de otro. */
export async function uploadMessageAttachments(
  files: File[],
  presign: (mimeType: Mime) => Promise<MessageAttachmentUploadDto>,
): Promise<MessageAttachmentInput[]> {
  const uploaded: MessageAttachmentInput[] = [];
  for (const file of files) uploaded.push(await uploadMessageAttachment(file, presign));
  return uploaded;
}

/** Comprueba tipo y tamaño antes de subir; avisa y devuelve false si no vale. */
export interface AttachmentTexts {
  wrongType: string;
  tooBig: string;
}

const DEFAULT_TEXTS: AttachmentTexts = {
  wrongType: 'Adjunta una imagen (JPG, PNG o WebP) o un PDF.',
  tooBig: 'El adjunto no puede pasar de 10 MB.',
};

export function acceptAttachment(file: File, texts: AttachmentTexts = DEFAULT_TEXTS): boolean {
  if (!(MESSAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
    toast.error(texts.wrongType);
    return false;
  }
  if (file.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
    toast.error(texts.tooBig);
    return false;
  }
  return true;
}

/** Botón de clip + los ficheros elegidos (sin subir aún). */
export function AttachmentPicker({
  files,
  onChange,
  disabled,
  label = 'Adjuntar imágenes o PDF',
  texts,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  label?: string;
  texts?: AttachmentTexts;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={MESSAGE_ATTACHMENT_MIME_TYPES.join(',')}
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []).filter((f) => acceptAttachment(f, texts));
          onChange([...files, ...picked].slice(0, MESSAGE_MAX_ATTACHMENTS));
          if (input.current) input.current.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        disabled={disabled || files.length >= MESSAGE_MAX_ATTACHMENTS}
        onClick={() => input.current?.click()}
        aria-label={label}
        title={label}
      >
        <Paperclip className="size-4" />
      </Button>
      {files.map((f, i) => (
        <AttachmentChip
          key={`${f.name}-${i}`}
          name={f.name}
          onRemove={() => onChange(files.filter((_, n) => n !== i))}
        />
      ))}
    </>
  );
}

export function AttachmentChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs">
      <Paperclip className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Quitar adjunto"
        className="opacity-60 hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** Los adjuntos de un mensaje. */
export function AttachmentList({ attachments }: { attachments: MessageAttachmentDto[] }) {
  return (
    <>
      {attachments.map((a) => (
        <AttachmentView key={a.url} attachment={a} />
      ))}
    </>
  );
}

/** El adjunto dentro de un mensaje: miniatura de la imagen o enlace al PDF. */
export function AttachmentView({ attachment }: { attachment: MessageAttachmentDto }) {
  if (attachment.mimeType.startsWith('image/')) {
    return (
      <a href={attachment.url} target="_blank" rel="noopener noreferrer" className="mt-1 block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.url}
          alt={attachment.filename}
          className="max-h-56 max-w-full rounded-md border object-contain"
        />
      </a>
    );
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-flex items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-xs text-foreground underline-offset-2 hover:underline"
    >
      <FileText className="size-4 shrink-0" />
      <span className="truncate">{attachment.filename}</span>
    </a>
  );
}
