'use client';

import { Download, FileText, Loader2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
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

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

function typeLabels(
  t: ReturnType<typeof useTranslations<'portal.consume.documents'>>,
): Record<CustomerDocumentTypeValue, string> {
  return {
    id_front: t('typeIdFront'),
    id_back: t('typeIdBack'),
    proof_of_address: t('typeProofOfAddress'),
    other: t('typeOther'),
  };
}

/** El inquilino sube y consulta sus documentos (KYC) desde el portal. */
export function DocumentsCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.documents');
  const labels = typeLabels(t);
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
      toast.error(err instanceof ApiError ? err.body.message : t('downloadError'));
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_MIME.includes(file.type)) {
      toast.error(t('invalidFormat'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('tooLarge'));
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
      toast.success(t('uploaded'));
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('uploadError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={type} onValueChange={(v) => setType(v as CustomerDocumentTypeValue)}>
            <SelectTrigger className="sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(labels) as CustomerDocumentTypeValue[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {labels[k]}
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
            {t('upload')}
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
                    {labels[d.type as CustomerDocumentTypeValue] ?? d.type}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => void download(d.id)}
                  >
                    <Download className="h-4 w-4" />
                    <span className="sr-only">{t('downloadSr', { fileName: d.fileName })}</span>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}
      </CardContent>
    </Card>
  );
}
