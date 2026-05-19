'use client';

import { type CustomerDocumentTypeValue } from '@storageos/shared';
import { File, Loader2, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCustomerDocuments,
  useDeleteCustomerDocument,
  useRegisterCustomerDocument,
  useRequestCustomerDocumentUpload,
} from '@/lib/customers/hooks';

const DOC_TYPES: Array<{ value: CustomerDocumentTypeValue; label: string }> = [
  { value: 'id_front', label: 'DNI/NIE — anverso' },
  { value: 'id_back', label: 'DNI/NIE — reverso' },
  { value: 'proof_of_address', label: 'Comprobante de domicilio' },
  { value: 'other', label: 'Otro' },
];

export function CustomerDocumentsTab({ customerId }: { customerId: string }) {
  const docs = useCustomerDocuments(customerId);
  const requestUpload = useRequestCustomerDocumentUpload();
  const register = useRegisterCustomerDocument();
  const remove = useDeleteCustomerDocument();
  const fileInput = useRef<HTMLInputElement>(null);
  const typeRef = useRef<CustomerDocumentTypeValue>('id_front');

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
        },
      });
      toast.success('Documento subido.');
    } catch {
      toast.error('No se pudo subir el documento.');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Borrar este documento?')) return;
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
        <div className="mb-4 flex items-end gap-2">
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
                <a
                  href={d.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 hover:underline"
                >
                  <File className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{d.fileName}</span>
                  <span className="text-xs text-muted-foreground">
                    {DOC_TYPES.find((t) => t.value === d.type)?.label}
                  </span>
                </a>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(d.id)}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
