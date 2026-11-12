'use client';

import { type CreatePlatformBlogPostInput, type PlatformBlogPostDto } from '@storageos/shared';
import { ExternalLink, ImagePlus, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { ArticleMarkdown } from '@/components/marketing/article-markdown';
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
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminPlatformBlogPosts,
  useDeletePlatformBlogPost,
  useRemovePlatformBlogCover,
  useSavePlatformBlogPost,
  useUploadPlatformBlogCover,
} from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDate } from '@/lib/format';

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro').replace(/\/$/, '');

interface FormState {
  title: string;
  slug: string;
  excerpt: string;
  contentMarkdown: string;
  seoTitle: string;
  seoDescription: string;
  coverImageAlt: string;
  isPublished: boolean;
}

const EMPTY: FormState = {
  title: '',
  slug: '',
  excerpt: '',
  contentMarkdown: '',
  seoTitle: '',
  seoDescription: '',
  coverImageAlt: '',
  isPublished: false,
};

function toForm(p: PlatformBlogPostDto): FormState {
  return {
    title: p.title,
    slug: p.slug,
    excerpt: p.excerpt ?? '',
    contentMarkdown: p.contentMarkdown,
    seoTitle: p.seoTitle ?? '',
    seoDescription: p.seoDescription ?? '',
    coverImageAlt: p.coverImageAlt ?? '',
    isPublished: p.isPublished,
  };
}

/** Blog de trasteros.pro: guías para captar a quien busca cómo gestionar trasteros. */
export default function AdminPlatformBlogPage() {
  const confirm = useConfirm();
  const canEdit = useIsSuperadmin();
  const posts = useAdminPlatformBlogPosts();
  const remove = useDeletePlatformBlogPost();
  const [editing, setEditing] = useState<PlatformBlogPostDto | 'new' | null>(null);

  async function onDelete(p: PlatformBlogPostDto) {
    if (
      !(await confirm({ title: `¿Borrar «${p.title}»? No se puede deshacer.`, destructive: true }))
    )
      return;
    try {
      await remove.mutateAsync(p.id);
      toast.success('Entrada borrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar.');
    }
  }

  if (posts.isError) return <AdminError onRetry={() => void posts.refetch()} />;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Blog de TrasterOS</h1>
          <p className="text-sm text-muted-foreground">
            Guías en trasteros.pro/blog para quien busca cómo montar o gestionar un negocio de
            trasteros. Solo se ven las publicadas; cada una lleva un botón para probar TrasterOS y
            pedir una demo.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing('new')} disabled={!canEdit}>
          <Plus className="mr-1 size-4" />
          Nueva entrada
        </Button>
      </div>

      {posts.isLoading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : (posts.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">Aún no hay entradas.</p>
      ) : (
        <div className="space-y-2">
          {(posts.data ?? []).map((p) => (
            <Card key={p.id}>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{p.title}</p>
                    {p.isPublished ? (
                      <Badge>Publicada</Badge>
                    ) : (
                      <Badge variant="outline">Borrador</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    /blog/{p.slug}
                    {p.publishedAt ? ` · publicada el ${formatDate(p.publishedAt)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {p.isPublished && (
                    <Button asChild size="icon" variant="ghost" aria-label="Ver en la web">
                      <a href={`${SITE}/blog/${p.slug}`} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="size-4" />
                      </a>
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Editar"
                    onClick={() => setEditing(p)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Borrar"
                    disabled={!canEdit}
                    onClick={() => void onDelete(p)}
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
        <PostDialog
          key={editing === 'new' ? 'new' : editing.id}
          post={editing === 'new' ? null : editing}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function PostDialog({
  post,
  canEdit,
  onClose,
}: {
  post: PlatformBlogPostDto | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const save = useSavePlatformBlogPost();
  const upload = useUploadPlatformBlogCover();
  const removeCover = useRemovePlatformBlogCover();
  const [form, setForm] = useState<FormState>(post ? toForm(post) : EMPTY);
  const [current, setCurrent] = useState<PlatformBlogPostDto | null>(post);
  const [preview, setPreview] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function onSave() {
    const input: CreatePlatformBlogPostInput = {
      title: form.title.trim(),
      slug: form.slug.trim(),
      excerpt: form.excerpt.trim(),
      contentMarkdown: form.contentMarkdown,
      seoTitle: form.seoTitle.trim(),
      seoDescription: form.seoDescription.trim(),
      coverImageAlt: form.coverImageAlt.trim(),
      isPublished: form.isPublished,
    };
    if (!input.title || !input.contentMarkdown.trim()) {
      toast.error('Pon el título y el texto.');
      return;
    }
    try {
      const saved = await save.mutateAsync({ ...(current ? { id: current.id } : {}), input });
      setCurrent(saved);
      setForm(toForm(saved));
      toast.success(saved.isPublished ? 'Guardada y publicada.' : 'Guardada como borrador.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function onCover(file: File | undefined) {
    if (!file || !current) return;
    try {
      setCurrent(await upload.mutateAsync({ id: current.id, file }));
      toast.success('Portada subida.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir la imagen.');
    }
  }

  const seoTitleLength = (form.seoTitle || `${form.title} | TrasterOS`).length;
  const seoDescLength = (form.seoDescription || form.excerpt).length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{current ? 'Editar entrada' : 'Nueva entrada'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pb-title">Título (H1)</Label>
            <Input
              id="pb-title"
              value={form.title}
              maxLength={200}
              onChange={(e) => set('title', e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pb-slug">Dirección</Label>
              <Input
                id="pb-slug"
                value={form.slug}
                maxLength={120}
                onChange={(e) => set('slug', e.target.value)}
                placeholder="Se genera del título"
              />
              <p className="text-xs text-muted-foreground">trasteros.pro/blog/{form.slug || '…'}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pb-alt">Texto alternativo de la portada</Label>
              <Input
                id="pb-alt"
                value={form.coverImageAlt}
                maxLength={200}
                onChange={(e) => set('coverImageAlt', e.target.value)}
                placeholder="Si no, el título"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pb-excerpt">Entradilla</Label>
            <Textarea
              id="pb-excerpt"
              rows={2}
              value={form.excerpt}
              maxLength={500}
              onChange={(e) => set('excerpt', e.target.value)}
              placeholder="Una o dos frases: salen bajo el título y en el listado"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="pb-content">Texto (Markdown)</Label>
              <Button size="sm" variant="ghost" onClick={() => setPreview((v) => !v)}>
                {preview ? 'Editar' : 'Vista previa'}
              </Button>
            </div>
            {preview ? (
              <div className="max-h-[50vh] overflow-y-auto rounded-md border p-4">
                <ArticleMarkdown content={form.contentMarkdown} />
              </div>
            ) : (
              <Textarea
                id="pb-content"
                rows={16}
                value={form.contentMarkdown}
                maxLength={80_000}
                onChange={(e) => set('contentMarkdown', e.target.value)}
                className="font-mono text-sm"
              />
            )}
            <p className="text-xs text-muted-foreground">
              Usa «## » para los apartados y enlaza otras páginas con su dirección (por ejemplo, [la
              calculadora](/calculadora-rentabilidad-trasteros)).
            </p>
          </div>

          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm font-medium">Google</p>
            <div className="space-y-1.5">
              <Label htmlFor="pb-seo-title">Título para Google</Label>
              <Input
                id="pb-seo-title"
                value={form.seoTitle}
                maxLength={160}
                onChange={(e) => set('seoTitle', e.target.value)}
                placeholder={`${form.title || 'Título'} | TrasterOS`}
              />
              <p
                className={`text-xs ${seoTitleLength > 65 ? 'text-amber-600' : 'text-muted-foreground'}`}
              >
                {seoTitleLength} caracteres (Google muestra unos 60)
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pb-seo-desc">Descripción para Google</Label>
              <Textarea
                id="pb-seo-desc"
                rows={2}
                value={form.seoDescription}
                maxLength={300}
                onChange={(e) => set('seoDescription', e.target.value)}
                placeholder="Si no, la entradilla"
              />
              <p
                className={`text-xs ${seoDescLength > 160 ? 'text-amber-600' : 'text-muted-foreground'}`}
              >
                {seoDescLength} caracteres (Google muestra unos 155)
              </p>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border p-4">
            <p className="text-sm font-medium">Portada</p>
            {!current ? (
              <p className="text-xs text-muted-foreground">
                Guarda la entrada para subir la portada.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {current.coverImageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={current.coverImageUrl}
                    alt=""
                    className="h-20 w-36 rounded-md border object-cover"
                  />
                )}
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-primary">
                  <ImagePlus className="size-4" aria-hidden />
                  {current.coverImageUrl ? 'Cambiar' : 'Subir imagen'} (JPG, PNG o WebP, 5 MB)
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    disabled={!canEdit || upload.isPending}
                    onChange={(e) => void onCover(e.target.files?.[0])}
                  />
                </label>
                {current.coverImageUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canEdit || removeCover.isPending}
                    onClick={() =>
                      void removeCover
                        .mutateAsync(current.id)
                        .then(setCurrent)
                        .catch(() => toast.error('No se pudo quitar.'))
                    }
                  >
                    Quitar
                  </Button>
                )}
                {upload.isPending && <Loader2 className="size-4 animate-spin" />}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={form.isPublished}
              onChange={(e) => set('isPublished', e.target.checked)}
            />
            Publicada (se ve en trasteros.pro/blog y en el mapa del sitio)
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          <Button onClick={() => void onSave()} disabled={!canEdit || save.isPending}>
            {save.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
