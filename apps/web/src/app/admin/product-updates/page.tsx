'use client';

import {
  FEATURE_LABELS,
  PRODUCT_UPDATE_CATEGORY_LABELS,
  ProductUpdateCategoryEnum,
  TenantFeatures,
  type AdminProductUpdateDto,
  type ProductUpdateCategory,
  type TenantFeature,
} from '@storageos/shared';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { MarkdownView } from '@/components/public/markdown-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminProductUpdates,
  useDeleteProductUpdate,
  useSaveProductUpdate,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const NO_FEATURE = '__none__';

interface FormState {
  title: string;
  body: string;
  category: ProductUpdateCategory;
  feature: TenantFeature | null;
  link: string;
}

const EMPTY: FormState = { title: '', body: '', category: 'new', feature: null, link: '' };

/** «Novedades» que ven todos los tenants en su panel. */
export default function AdminProductUpdatesPage() {
  const updates = useAdminProductUpdates();
  const remove = useDeleteProductUpdate();
  const [editing, setEditing] = useState<AdminProductUpdateDto | 'new' | null>(null);

  async function onDelete(u: AdminProductUpdateDto) {
    if (!window.confirm(`¿Borrar «${u.title}»? Desaparece del panel de los tenants.`)) return;
    try {
      await remove.mutateAsync(u.id);
      toast.success('Novedad borrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar.');
    }
  }

  if (updates.isError) return <AdminError onRetry={() => void updates.refetch()} />;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Novedades</h1>
          <p className="text-sm text-muted-foreground">
            Lo que publiques aquí aparece en «Novedades» del panel de todos los tenants, con un
            aviso en el menú hasta que lo abren.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1 size-4" />
          Nueva
        </Button>
      </div>

      {updates.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (updates.data ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Aún no has escrito ninguna novedad.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {updates.data!.map((u) => (
            <Card key={u.id}>
              <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{u.title}</span>
                    {u.publishedAt ? (
                      <Badge variant="secondary">
                        Publicada el {new Date(u.publishedAt).toLocaleDateString('es-ES')}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Borrador</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {PRODUCT_UPDATE_CATEGORY_LABELS[u.category]}
                    {u.feature ? ` · ${FEATURE_LABELS[u.feature]}` : ''}
                    {u.authorName ? ` · ${u.authorName}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Editar"
                    title="Editar"
                    onClick={() => setEditing(u)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Borrar"
                    title="Borrar"
                    onClick={() => void onDelete(u)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <ProductUpdateDialog
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProductUpdateDialog({
  initial,
  onClose,
}: {
  initial: AdminProductUpdateDto | null;
  onClose: () => void;
}) {
  const save = useSaveProductUpdate();
  const [form, setForm] = useState<FormState>(
    initial
      ? {
          title: initial.title,
          body: initial.body,
          category: initial.category,
          feature: initial.feature,
          link: initial.link ?? '',
        }
      : EMPTY,
  );
  const [preview, setPreview] = useState(false);

  async function submit(published: boolean) {
    try {
      await save.mutateAsync({
        ...(initial ? { id: initial.id } : {}),
        input: {
          title: form.title,
          body: form.body,
          category: form.category,
          feature: form.feature,
          link: form.link.trim() || null,
          published,
        },
      });
      toast.success(published ? 'Novedad publicada.' : 'Guardada como borrador.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const valid = form.title.trim().length >= 3 && form.body.trim().length >= 3;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? 'Editar novedad' : 'Nueva novedad'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pu-title">Título</Label>
            <Input
              id="pu-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v as ProductUpdateCategory })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ProductUpdateCategoryEnum.options.map((c) => (
                    <SelectItem key={c} value={c}>
                      {PRODUCT_UPDATE_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Funcionalidad de pago (opcional)</Label>
              <Select
                value={form.feature ?? NO_FEATURE}
                onValueChange={(v) =>
                  setForm({ ...form, feature: v === NO_FEATURE ? null : (v as TenantFeature) })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FEATURE}>Ninguna (para todos)</SelectItem>
                  {TenantFeatures.map((f) => (
                    <SelectItem key={f} value={f}>
                      {FEATURE_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pu-link">Enlace dentro del panel (opcional)</Label>
            <Input
              id="pu-link"
              placeholder="/settings/web"
              value={form.link}
              onChange={(e) => setForm({ ...form, link: e.target.value })}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="pu-body">Texto (Markdown)</Label>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPreview(!preview)}>
                {preview ? 'Editar' : 'Vista previa'}
              </Button>
            </div>
            {preview ? (
              <div className="min-h-40 rounded-md border p-3">
                <MarkdownView content={form.body || '_Sin texto_'} />
              </div>
            ) : (
              <Textarea
                id="pu-body"
                rows={10}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                className="text-base sm:text-sm"
              />
            )}
          </div>
          {form.feature && (
            <p className="text-xs text-muted-foreground">
              Los tenants que no la tengan verán un enlace a los planes y extras.
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={!valid || save.isPending}
            onClick={() => void submit(false)}
          >
            {initial?.publishedAt ? 'Despublicar' : 'Guardar borrador'}
          </Button>
          <Button disabled={!valid || save.isPending} onClick={() => void submit(true)}>
            {initial?.publishedAt ? 'Guardar' : 'Publicar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
