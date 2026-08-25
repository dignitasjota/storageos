'use client';

import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import type { BlogPostDto } from '@storageos/shared';

import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ApiError } from '@/lib/auth/api';
import {
  uploadBlogCover,
  useCreateBlogPost,
  useSetBlogPostCover,
  useUpdateBlogPost,
} from '@/lib/blog/hooks';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Si se pasa, el diálogo edita; si no, crea. */
  post?: BlogPostDto;
}

export function BlogPostDialog({ open, onOpenChange, post }: Props) {
  const isEdit = !!post;
  const create = useCreateBlogPost();
  const update = useUpdateBlogPost();
  const setCover = useSetBlogPostCover();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const [title, setTitle] = useState(post?.title ?? '');
  const [slug, setSlug] = useState(post?.slug ?? '');
  const [excerpt, setExcerpt] = useState(post?.excerpt ?? '');
  const [contentMarkdown, setContentMarkdown] = useState(post?.contentMarkdown ?? '');
  const [seoTitle, setSeoTitle] = useState(post?.seoTitle ?? '');
  const [seoDescription, setSeoDescription] = useState(post?.seoDescription ?? '');
  const [isPublished, setIsPublished] = useState(post?.isPublished ?? false);
  // Tras crear, se guarda aquí para poder subir la portada sin cerrar el diálogo.
  const [createdPost, setCreatedPost] = useState<BlogPostDto | null>(null);

  const current = post ?? createdPost;
  const pending = create.isPending || update.isPending;

  async function submit() {
    const common = {
      title,
      slug,
      excerpt,
      contentMarkdown,
      seoTitle,
      seoDescription,
      isPublished,
    };
    try {
      if (isEdit) {
        await update.mutateAsync({ id: post.id, input: common });
        toast.success('Entrada actualizada.');
        onOpenChange(false);
      } else {
        const created = await create.mutateAsync(common);
        setCreatedPost(created);
        toast.success('Entrada creada. Ya puedes subirle una portada.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function onPickCover(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !current) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Formato no soportado (PNG/JPG/WebP).');
      return;
    }
    setUploading(true);
    try {
      const updated = await uploadBlogCover(current.id, file);
      if (isEdit) {
        // el hook de update no aplica; refrescamos vía cache de setCover manualmente no hace falta,
        // uploadBlogCover ya deja la key confirmada en backend — solo reflejamos en local:
        setCreatedPost(updated);
      } else {
        setCreatedPost(updated);
      }
      toast.success('Portada subida.');
    } catch {
      toast.error('No se pudo subir la portada.');
    } finally {
      setUploading(false);
    }
  }

  async function removeCover() {
    if (!current) return;
    try {
      const updated = await setCover.mutateAsync({ id: current.id, coverImageKey: null });
      setCreatedPost(updated);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setCreatedPost(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar entrada' : 'Nueva entrada'}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Título</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </div>
            <div className="space-y-1">
              <Label>Slug (URL)</Label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="se genera del título si lo dejas vacío"
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <Label>Resumen</Label>
              <Textarea
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="Se muestra en el listado del blog."
              />
            </div>
            <div className="space-y-1">
              <Label>Contenido (Markdown)</Label>
              <Textarea
                value={contentMarkdown}
                onChange={(e) => setContentMarkdown(e.target.value)}
                rows={12}
                maxLength={50_000}
                className="font-mono text-xs"
                placeholder={'## Título\n\nTexto con **negrita**, listas y enlaces.'}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Título SEO (opcional)</Label>
                <Input
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  maxLength={160}
                />
              </div>
              <div className="space-y-1">
                <Label>Meta description (opcional)</Label>
                <Input
                  value={seoDescription}
                  onChange={(e) => setSeoDescription(e.target.value)}
                  maxLength={300}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isPublished} onCheckedChange={(v) => setIsPublished(v === true)} />
              Publicada (visible en la web pública)
            </label>

            {current && (
              <div className="space-y-2 rounded-md border border-dashed p-3">
                <p className="text-sm font-medium">Portada</p>
                {current.coverImageUrl ? (
                  <div className="group relative aspect-video w-full max-w-xs overflow-hidden rounded-md border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={current.coverImageUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={removeCover}
                      disabled={setCover.isPending}
                      className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition group-hover:opacity-100"
                      aria-label="Quitar portada"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Sin portada.</p>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={onPickCover}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="mr-1 h-4 w-4" />
                  )}
                  {current.coverImageUrl ? 'Cambiar' : 'Subir'} portada
                </Button>
              </div>
            )}
            {!current && (
              <p className="text-xs text-muted-foreground">
                Podrás subir una portada en cuanto crees la entrada.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-muted-foreground">Vista previa</Label>
            <div className="max-h-[560px] overflow-y-auto rounded-md border p-4">
              {contentMarkdown.trim() ? (
                <MarkdownView content={contentMarkdown} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Escribe contenido para ver la vista previa.
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {isEdit || !createdPost ? 'Cancelar' : 'Cerrar'}
          </Button>
          {!(createdPost && !isEdit) && (
            <Button onClick={submit} disabled={pending || !title.trim() || !contentMarkdown.trim()}>
              {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {isEdit ? 'Guardar' : 'Crear'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
