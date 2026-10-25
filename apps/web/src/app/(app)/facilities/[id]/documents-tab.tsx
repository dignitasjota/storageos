'use client';

import {
  FACILITY_DOCUMENT_KIND_LABELS,
  FACILITY_DOCUMENT_MIME_TYPES,
  FacilityDocumentKindEnum,
  type FacilityDocumentDto,
  type FacilityDocumentKind,
} from '@storageos/shared';
import { Download, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  openFacilityDocument,
  useDeleteFacilityDocument,
  useFacilityDocuments,
  useUpdateFacilityDocument,
  useUploadFacilityDocument,
} from '@/lib/facilities/inventory-hooks';

function expiryBadge(d: FacilityDocumentDto) {
  if (d.daysToExpiry === null) return null;
  if (d.daysToExpiry < 0) return <Badge variant="destructive">Caducado</Badge>;
  if (d.daysToExpiry <= 30)
    return (
      <Badge variant="outline" className="border-amber-400 text-amber-800 dark:text-amber-300">
        Caduca en {d.daysToExpiry} días
      </Badge>
    );
  return null;
}

/** Licencias, seguros, contrato de la nave… con su caducidad. */
export function FacilityDocumentsTab({ facilityId }: { facilityId: string }) {
  const ask = useConfirm();
  const docs = useFacilityDocuments(facilityId);
  const upload = useUploadFacilityDocument(facilityId);
  const update = useUpdateFacilityDocument(facilityId);
  const remove = useDeleteFacilityDocument(facilityId);
  const canManage = useHasPermission('facilities:manage');
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<FacilityDocumentKind>('licence');
  const [name, setName] = useState('');
  const [expiresOn, setExpiresOn] = useState<string | undefined>();
  const [editing, setEditing] = useState<FacilityDocumentDto | null>(null);
  const [editExpiry, setEditExpiry] = useState<string | undefined>();

  function pick(f: File | undefined) {
    if (!f) return;
    if (!(FACILITY_DOCUMENT_MIME_TYPES as readonly string[]).includes(f.type)) {
      toast.error('Solo PDF, JPG, PNG o WebP.');
      return;
    }
    if (f.size > 20 * 1024 * 1024) {
      toast.error('Máximo 20 MB.');
      return;
    }
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, ''));
    setExpiresOn(undefined);
  }

  async function save() {
    if (!file || !name.trim()) return;
    try {
      await upload.mutateAsync({
        file,
        kind,
        name: name.trim(),
        ...(expiresOn ? { expiresOn } : {}),
      });
      toast.success('Documento guardado.');
      setFile(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir.');
    }
  }

  async function saveExpiry() {
    if (!editing) return;
    try {
      await update.mutateAsync({ id: editing.id, input: { expiresOn: editExpiry ?? null } });
      toast.success('Caducidad guardada.');
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Documentos del local</CardTitle>
          <CardDescription>
            Licencias, seguros, el contrato de la nave, inspecciones… Solo los ve el equipo. Con
            fecha de caducidad, avisa 30 días antes.
          </CardDescription>
        </div>
        {canManage && (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept={FACILITY_DOCUMENT_MIME_TYPES.join(',')}
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              <Plus className="mr-1 h-4 w-4" /> Subir documento
            </Button>
          </>
        )}
      </CardHeader>
      <CardContent>
        {docs.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (docs.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay documentos.</p>
        ) : (
          <ul className="divide-y">
            {(docs.data ?? []).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <FileText className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {d.name} {expiryBadge(d)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {FACILITY_DOCUMENT_KIND_LABELS[d.kind]}
                    {d.expiresOn
                      ? ` · caduca el ${new Date(`${d.expiresOn}T00:00:00`).toLocaleDateString('es-ES')}`
                      : ''}
                    {d.uploadedByName ? ` · ${d.uploadedByName}` : ''}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Descargar"
                    onClick={() =>
                      void openFacilityDocument(facilityId, d.id).catch(() =>
                        toast.error('No se pudo abrir.'),
                      )
                    }
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(d);
                          setEditExpiry(d.expiresOn ?? undefined);
                        }}
                      >
                        Caducidad
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Borrar"
                        onClick={async () => {
                          if (await ask({ title: `¿Borrar «${d.name}»?`, destructive: true })) {
                            remove.mutate(d.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={!!file} onOpenChange={(o) => !o && setFile(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuevo documento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="doc-name">Nombre</Label>
              <Input id="doc-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as FacilityDocumentKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FacilityDocumentKindEnum.options.map((k) => (
                    <SelectItem key={k} value={k}>
                      {FACILITY_DOCUMENT_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Caduca (opcional)</Label>
              <DateSelect years={10} future value={expiresOn} onChange={setExpiresOn} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFile(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={upload.isPending || !name.trim()}>
              {upload.isPending ? 'Subiendo…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Caducidad de {editing?.name}</DialogTitle>
          </DialogHeader>
          <DateSelect years={10} future value={editExpiry} onChange={setEditExpiry} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditExpiry(undefined)}>
              Sin caducidad
            </Button>
            <Button onClick={() => void saveExpiry()} disabled={update.isPending}>
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
