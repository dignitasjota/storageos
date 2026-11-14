'use client';

import { OPS_FILES_MAX, type MessageAttachmentUploadDto, type OpsFileDto } from '@storageos/shared';
import { FileText, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { acceptAttachment, uploadMessageAttachment } from '@/components/messages/attachments';
import { Button } from '@/components/ui/button';
import { ApiError, apiFetch } from '@/lib/auth/api';

/**
 * Fotos y documentos de una tarea, una incidencia o un vencimiento: subir
 * (comprimidas), ver y quitar. `basePath` es `/tasks/<id>/photos`,
 * `/incidents/<id>/photos` o `/business-reminders/<id>/attachments`.
 */
export function OpsFiles({
  files,
  basePath,
  canEdit,
  onChanged,
  label = 'Fotos y documentos',
  signedUrls = true,
}: {
  files: OpsFileDto[];
  basePath: string;
  canEdit: boolean;
  onChanged: () => void;
  label?: string;
  /** Si los ficheros no traen URL, se pide al pulsar (`GET <basePath>/<id>`). */
  signedUrls?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(list: FileList | null) {
    const picked = Array.from(list ?? []).filter((f) => acceptAttachment(f));
    if (picked.length === 0) return;
    if (files.length + picked.length > OPS_FILES_MAX) {
      toast.error(`Como mucho ${OPS_FILES_MAX} fotos o documentos.`);
      return;
    }
    setBusy(true);
    try {
      for (const file of picked) {
        const att = await uploadMessageAttachment(file, (mimeType) =>
          apiFetch<MessageAttachmentUploadDto>(`${basePath}/upload-url`, {
            method: 'POST',
            json: { mimeType },
          }),
        );
        await apiFetch(basePath, { method: 'POST', json: att });
      }
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(f: OpsFileDto) {
    setBusy(true);
    try {
      await apiFetch(`${basePath}/${f.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    } finally {
      setBusy(false);
    }
  }

  async function open(f: OpsFileDto) {
    try {
      const url = signedUrls ? f.url : (await apiFetch<{ url: string }>(`${basePath}/${f.id}`)).url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo abrir.');
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        {canEdit && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => void upload(e.target.files)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || files.length >= OPS_FILES_MAX}
              onClick={() => input.current?.click()}
            >
              {busy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="mr-1 h-4 w-4" />
              )}
              Añadir
            </Button>
          </>
        )}
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sin fotos ni documentos.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {files.map((f) => (
            <div key={f.id} className="group relative overflow-hidden rounded-md border">
              <button
                type="button"
                onClick={() => void open(f)}
                className="flex aspect-square w-full items-center justify-center bg-muted/40"
                title={f.filename}
              >
                {f.mimeType.startsWith('image/') && f.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.url} alt={f.filename} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex flex-col items-center gap-1 p-1 text-center text-[11px] text-muted-foreground">
                    <FileText className="h-5 w-5" />
                    <span className="line-clamp-2 break-all">{f.filename}</span>
                  </span>
                )}
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => void remove(f)}
                  disabled={busy}
                  aria-label={`Quitar ${f.filename}`}
                  className="absolute right-1 top-1 rounded bg-background/90 p-1 text-destructive shadow-sm"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
