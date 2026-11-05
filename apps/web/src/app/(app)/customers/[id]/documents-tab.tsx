'use client';

import { type CustomerDocumentTypeValue } from '@storageos/shared';
import { File, Loader2, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import {
  useCancelDocumentRequest,
  useCustomerDocumentRequests,
  useRequestCustomerDocument,
} from '@/lib/customers/features-hooks';
import {
  useCustomerDocuments,
  useCustomerDocumentDownload,
  useDeleteCustomerDocument,
  useRegisterCustomerDocument,
  useRequestCustomerDocumentUpload,
} from '@/lib/customers/hooks';
import { formatDate } from '@/lib/format';

const DOC_TYPES: Array<{ value: CustomerDocumentTypeValue; label: string }> = [
  { value: 'id_front', label: 'DNI/NIE — anverso' },
  { value: 'id_back', label: 'DNI/NIE — reverso' },
  { value: 'proof_of_address', label: 'Comprobante de domicilio' },
  { value: 'other', label: 'Otro' },
];

export function CustomerDocumentsTab({ customerId }: { customerId: string }) {
  const ask = useConfirm();
  const docs = useCustomerDocuments(customerId);
  const requestUpload = useRequestCustomerDocumentUpload();
  const register = useRegisterCustomerDocument();
  const remove = useDeleteCustomerDocument();
  const download = useCustomerDocumentDownload();
  const requests = useCustomerDocumentRequests(customerId);
  const requestDocument = useRequestCustomerDocument(customerId);
  const cancelRequest = useCancelDocumentRequest(customerId);
  const [expiresOn, setExpiresOn] = useState('');
  const [askType, setAskType] = useState<CustomerDocumentTypeValue>('id_front');
  const [askNote, setAskNote] = useState('');
  const pending = (requests.data ?? []).filter((r) => r.status === 'pending');
  const fileInput = useRef<HTMLInputElement>(null);
  const typeRef = useRef<CustomerDocumentTypeValue>('id_front');

  async function sendRequest() {
    try {
      const res = await requestDocument.mutateAsync({ type: askType, note: askNote });
      toast.success(
        res.emailed
          ? 'Pedido. Le hemos avisado por correo.'
          : 'Pedido. No tiene email: avísale tú; lo verá en su área de clientes.',
      );
      setAskNote('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo pedir.');
    }
  }

  async function openDocument(id: string) {
    // Se abre antes de pedir la dirección: si no, el navegador lo toma por una ventana emergente.
    const tab = window.open('', '_blank');
    try {
      const { url } = await download.mutateAsync({ customerId, id });
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo abrir el documento.');
    }
  }

  async function handleFile(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Máximo 10 MB.');
      return;
    }
    const mime = file.type as 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';
    if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(mime)) {
      toast.error('Solo PNG, JPG, WebP o PDF.');
      return;
    }
    try {
      const { uploadUrl, publicUrl, requiredHeaders } = await requestUpload.mutateAsync({
        id: customerId,
        input: {
          type: typeRef.current,
          mimeType: mime,
          sizeBytes: file.size,
          fileName: file.name,
        },
      });
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: requiredHeaders,
        body: file,
      });
      if (!res.ok) throw new Error(`upload ${res.status}`);
      await register.mutateAsync({
        id: customerId,
        input: {
          type: typeRef.current,
          fileUrl: publicUrl,
          fileName: file.name,
          mimeType: mime,
          fileSize: file.size,
          ...(expiresOn ? { expiresAt: new Date(`${expiresOn}T12:00:00Z`).toISOString() } : {}),
        },
      });
      setExpiresOn('');
      toast.success('Documento subido.');
    } catch {
      toast.error('No se pudo subir el documento.');
    }
  }

  async function handleDelete(id: string) {
    if (!(await ask({ title: '¿Borrar este documento?', destructive: true }))) return;
    try {
      await remove.mutateAsync(id);
      toast.success('Documento borrado.');
    } catch {
      toast.error('Error al borrar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documentos</CardTitle>
        <p className="text-sm text-muted-foreground">
          PDF, PNG, JPG o WebP. Máximo 10 MB por archivo.
        </p>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Tipo</label>
            <Select
              defaultValue="id_front"
              onValueChange={(v) => {
                typeRef.current = v as CustomerDocumentTypeValue;
              }}
            >
              <SelectTrigger className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOC_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Caduca (opcional)</label>
            <DateSelect
              value={expiresOn || undefined}
              onChange={(v) => setExpiresOn(v ?? '')}
              future
            />
          </div>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          <Button
            variant="outline"
            onClick={() => fileInput.current?.click()}
            disabled={requestUpload.isPending || register.isPending}
          >
            {requestUpload.isPending || register.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1 h-4 w-4" />
            )}
            Subir
          </Button>
        </div>

        {docs.isLoading && <p className="text-sm text-muted-foreground">Cargando...</p>}
        {docs.data && docs.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay documentos.</p>
        )}
        {docs.data && docs.data.length > 0 && (
          <ul className="divide-y rounded-md border">
            {docs.data.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <button
                  type="button"
                  onClick={() => void openDocument(d.id)}
                  className="flex items-center gap-2 text-left hover:underline"
                >
                  <File className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{d.fileName}</span>
                  <span className="text-xs text-muted-foreground">
                    {DOC_TYPES.find((t) => t.value === d.type)?.label}
                  </span>
                  {d.expiresAt && (
                    <span
                      className={`text-xs ${
                        new Date(d.expiresAt) < new Date()
                          ? 'font-medium text-destructive'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {new Date(d.expiresAt) < new Date() ? 'Caducado' : 'Caduca'} el{' '}
                      {formatDate(d.expiresAt)}
                    </span>
                  )}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(d.id)}
                  className="text-destructive"
                  aria-label="Eliminar"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Can permission="customers:write">
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">Pedir un documento</p>
            {pending.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {DOC_TYPES.find((t) => t.value === r.type)?.label}
                  {r.note ? ` — ${r.note}` : ''}
                  <span className="text-muted-foreground"> · sin subir</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cancelRequest.mutate(r.id)}
                  disabled={cancelRequest.isPending}
                >
                  Cancelar
                </Button>
              </div>
            ))}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={askType}
                onValueChange={(v) => setAskType(v as CustomerDocumentTypeValue)}
              >
                <SelectTrigger className="sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Nota para el inquilino (opcional)"
                aria-label="Nota para el inquilino"
                value={askNote}
                onChange={(e) => setAskNote(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={requestDocument.isPending}
                onClick={() => void sendRequest()}
              >
                Pedir
              </Button>
            </div>
          </div>
        </Can>
      </CardContent>
    </Card>
  );
}
