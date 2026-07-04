'use client';

import { Download, FileText, Loader2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type {
  CustomerDocumentDto,
  CustomerDocumentUploadDto,
  CustomerDocumentTypeValue,
  PortalSessionDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, apiFetch } from '@/lib/auth/api';

const TYPE_LABELS: Record<CustomerDocumentTypeValue, string> = {
  id_front: 'DNI / NIE (anverso)',
  id_back: 'DNI / NIE (reverso)',
  proof_of_address: 'Justificante de domicilio',
  other: 'Otro documento',
};

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

/** El inquilino sube y consulta sus documentos (KYC) desde el portal. */
export function DocumentsCard({ session }: { session: PortalSessionDto }) {
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const [docs, setDocs] = useState<CustomerDocumentDto[]>([]);
  const [type, setType] = useState<CustomerDocumentTypeValue>('id_front');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const list = await apiFetch<CustomerDocumentDto[]>('/portal/me/documents', { headers });
      setDocs(list);
    } catch {
      /* opcional */
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  async function download(id: string) {
    try {
      const { url } = await apiFetch<{ url: string }>(`/portal/me/documents/${id}/download`, {
        headers,
      });
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.body.message : 'No se pudo descargar el documento.',
      );
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_MIME.includes(file.type)) {
      toast.error('Formato no válido. Sube una imagen (PNG/JPG/WebP) o un PDF.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('El archivo supera los 10 MB.');
      return;
    }
    setBusy(true);
    try {
      // 1) URL firmada para subir a MinIO.
      const up = await apiFetch<CustomerDocumentUploadDto>('/portal/me/documents/upload-url', {
        method: 'POST',
        json: { type, mimeType: file.type, sizeBytes: file.size, fileName: file.name },
        headers,
      });
      // 2) Subida directa al almacenamiento.
      const put = await fetch(up.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: up.requiredHeaders,
      });
      if (!put.ok) throw new Error('upload_failed');
      // 3) Registrar el documento.
      await apiFetch<CustomerDocumentDto>('/portal/me/documents', {
        method: 'POST',
        json: {
          type,
          fileUrl: up.publicUrl,
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
        },
        headers,
      });
      toast.success('Documento subido.');
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir el documento.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4" /> Mis documentos
        </CardTitle>
        <CardDescription>
          Sube tu documentación (DNI, justificante de domicilio…) para agilizar tu gestión.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={type} onValueChange={(v) => setType(v as CustomerDocumentTypeValue)}>
            <SelectTrigger className="sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TYPE_LABELS) as CustomerDocumentTypeValue[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {TYPE_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            ref={fileRef}
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.pdf"
            className="hidden"
            onChange={onFile}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1 h-4 w-4" />
            )}
            Subir documento
          </Button>
        </div>

        {docs.length > 0 ? (
          <ul className="space-y-2 border-t pt-3">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{d.fileName}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {TYPE_LABELS[d.type as CustomerDocumentTypeValue] ?? d.type}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => void download(d.id)}
                  >
                    <Download className="h-4 w-4" />
                    <span className="sr-only">Descargar {d.fileName}</span>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Aún no has subido documentos.</p>
        )}
      </CardContent>
    </Card>
  );
}
