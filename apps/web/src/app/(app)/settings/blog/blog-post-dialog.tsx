'use client';

import {
  BLOG_WIDGETS,
  BLOG_WIDGET_LABELS,
  blogImageFileName,
  buttonBlock,
  widgetBlock,
  type BlogPostDto,
  type BlogWidget,
} from '@storageos/shared';
import { ImagePlus, Link2, Loader2, MousePointerClick, Puzzle, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { InsertTargetDialog } from './blog-insert-dialogs';

import { BlogContent } from '@/app/(public)/s/[slug]/blog/blog-content';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import {
  useBlogPosts,
  useCreateBlogPost,
  useSetBlogPostCover,
  useUpdateBlogPost,
  useUploadBlogCover,
} from '@/lib/blog/hooks';

const MAX_RELATED = 3;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Si se pasa, el diálogo edita; si no, crea. Montar con `key` para empezar de cero. */
  post?: BlogPostDto;
}

export function BlogPostDialog({ open, onOpenChange, post }: Props) {
  const me = useMe();
  const allPosts = useBlogPosts();
  const create = useCreateBlogPost();
  const update = useUpdateBlogPost();
  const setCover = useSetBlogPostCover();
  const uploadCover = useUploadBlogCover();
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const [title, setTitle] = useState(post?.title ?? '');
  const [slug, setSlug] = useState(post?.slug ?? '');
  const [excerpt, setExcerpt] = useState(post?.excerpt ?? '');
  const [contentMarkdown, setContentMarkdown] = useState(post?.contentMarkdown ?? '');
  const [seoTitle, setSeoTitle] = useState(post?.seoTitle ?? '');
  const [seoDescription, setSeoDescription] = useState(post?.seoDescription ?? '');
  const [coverImageAlt, setCoverImageAlt] = useState(post?.coverImageAlt ?? '');
  const [coverFileName, setCoverFileName] = useState('');
  const [relatedPostIds, setRelatedPostIds] = useState<string[]>(post?.relatedPostIds ?? []);
  const [isPublished, setIsPublished] = useState(post?.isPublished ?? false);
  // Tras crear, la entrada recién creada: el diálogo sigue abierto para la portada.
  const [saved, setSaved] = useState<BlogPostDto | null>(null);
  const [insert, setInsert] = useState<{ kind: 'link' | 'button'; text: string } | null>(null);

  const current = saved ?? post ?? null;
  const pending = create.isPending || update.isPending;
  const others = (allPosts.data ?? []).filter((p) => p.id !== current?.id);

  async function submit() {
    const input = {
      title,
      slug,
      excerpt,
      contentMarkdown,
      seoTitle,
      seoDescription,
      coverImageAlt,
      relatedPostIds,
      isPublished,
    };
    try {
      if (current) {
        await update.mutateAsync({ id: current.id, input });
        toast.success('Entrada guardada.');
        onOpenChange(false);
      } else {
        const created = await create.mutateAsync(input);
        setSaved(created);
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
    // Sin nombre escrito, el del fichero (o el título).
    const name =
      blogImageFileName(coverFileName) || blogImageFileName(file.name) || blogImageFileName(title);
    setCoverFileName(name);
    try {
      setSaved(await uploadCover.mutateAsync({ id: current.id, file, fileName: name }));
      toast.success('Portada subida.');
    } catch {
      toast.error('No se pudo subir la portada.');
    }
  }

  async function removeCover() {
    if (!current) return;
    try {
      setSaved(await setCover.mutateAsync({ id: current.id, coverImageKey: null }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  /** Inserta en el cursor: un enlace en la línea, un bloque en una línea propia. */
  function insertText(text: string, asBlock: boolean) {
    const el = editorRef.current;
    const start = el?.selectionStart ?? contentMarkdown.length;
    const end = el?.selectionEnd ?? contentMarkdown.length;
    const before = contentMarkdown.slice(0, start);
    const after = contentMarkdown.slice(end);
    const chunk = asBlock
      ? `${before && !before.endsWith('\n') ? '\n' : ''}${text}\n${after.startsWith('\n') ? '' : '\n'}`
      : text;
    const next = before + chunk + after;
    setContentMarkdown(next);
    const caret = before.length + chunk.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  function selectedText(): string {
    const el = editorRef.current;
    if (!el) return '';
    return contentMarkdown.slice(el.selectionStart, el.selectionEnd);
  }

  function toggleRelated(id: string) {
    setRelatedPostIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(0, MAX_RELATED),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{current ? 'Editar entrada' : 'Nueva entrada'}</DialogTitle>
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
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setInsert({ kind: 'link', text: selectedText() })}
                >
                  <Link2 className="mr-1 h-4 w-4" /> Enlace
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setInsert({ kind: 'button', text: selectedText() })}
                >
                  <MousePointerClick className="mr-1 h-4 w-4" /> Botón
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm">
                      <Puzzle className="mr-1 h-4 w-4" /> Widget
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {BLOG_WIDGETS.map((w: BlogWidget) => (
                      <DropdownMenuItem key={w} onSelect={() => insertText(widgetBlock(w), true)}>
                        {BLOG_WIDGET_LABELS[w]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Textarea
                ref={editorRef}
                value={contentMarkdown}
                onChange={(e) => setContentMarkdown(e.target.value)}
                rows={14}
                maxLength={50_000}
                className="font-mono text-xs"
                placeholder={'## Título\n\nTexto con **negrita**, listas y enlaces.'}
              />
              <p className="text-xs text-muted-foreground">
                Los botones y widgets van en una línea propia. Puedes moverlos o borrarlos como
                cualquier texto.
              </p>
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

            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-sm font-medium">Portada</p>
              {!current ? (
                <p className="text-xs text-muted-foreground">
                  Podrás subir una portada en cuanto crees la entrada.
                </p>
              ) : (
                <>
                  {current.coverImageUrl ? (
                    <div className="group relative aspect-video w-full max-w-xs overflow-hidden rounded-md border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={current.coverImageUrl}
                        alt={coverImageAlt || title}
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
                  {current.coverImageUrl && (
                    <p className="break-all text-xs text-muted-foreground">
                      Fichero: {current.coverImageUrl.split('/').pop()}
                    </p>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs">Nombre del archivo al subir</Label>
                    <Input
                      value={coverFileName}
                      onChange={(e) => setCoverFileName(e.target.value)}
                      onBlur={() => setCoverFileName((v) => blogImageFileName(v))}
                      placeholder="si lo dejas vacío, el del fichero que subas"
                      maxLength={80}
                    />
                  </div>
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
                    disabled={uploadCover.isPending}
                  >
                    {uploadCover.isPending ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <ImagePlus className="mr-1 h-4 w-4" />
                    )}
                    {current.coverImageUrl ? 'Cambiar' : 'Subir'} portada
                  </Button>
                </>
              )}
              <div className="space-y-1">
                <Label className="text-xs">Texto alternativo (lo lee Google)</Label>
                <Input
                  value={coverImageAlt}
                  onChange={(e) => setCoverImageAlt(e.target.value)}
                  maxLength={200}
                  placeholder={title ? `Si lo dejas vacío: «${title}»` : 'Describe la imagen'}
                />
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-sm font-medium">Entradas relacionadas</p>
              <p className="text-xs text-muted-foreground">
                Salen al final como «Te puede interesar» (hasta {MAX_RELATED}). Si no eliges
                ninguna, salen las últimas publicadas.
              </p>
              {others.length === 0 ? (
                <p className="text-xs text-muted-foreground">No hay otras entradas todavía.</p>
              ) : (
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {others.map((p) => {
                    const checked = relatedPostIds.includes(p.id);
                    return (
                      <li key={p.id}>
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={checked}
                            disabled={!checked && relatedPostIds.length >= MAX_RELATED}
                            onCheckedChange={() => toggleRelated(p.id)}
                          />
                          <span className="truncate">{p.title}</span>
                          {!p.isPublished && (
                            <span className="text-xs text-muted-foreground">(borrador)</span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isPublished} onCheckedChange={(v) => setIsPublished(v === true)} />
              Publicada (visible en la web pública)
            </label>
          </div>

          <div className="space-y-1">
            <Label className="text-muted-foreground">Vista previa</Label>
            <div className="max-h-[720px] overflow-y-auto rounded-md border p-4">
              {contentMarkdown.trim() ? (
                <BlogContent
                  markdown={contentMarkdown}
                  ctx={{
                    tenantSlug: me.data?.tenant.slug ?? '',
                    locale: 'es',
                    customDomain: null,
                    webTemplate: 'default',
                  }}
                  brandColor={me.data?.tenant.brandColor ?? null}
                  landing={null}
                />
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
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending || !title.trim() || !contentMarkdown.trim()}>
            {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {current ? 'Guardar' : 'Crear'}
          </Button>
        </DialogFooter>

        {insert && (
          <InsertTargetDialog
            kind={insert.kind}
            open
            onOpenChange={(o) => !o && setInsert(null)}
            initialText={insert.text}
            currentPostId={current?.id}
            onInsert={(text, href) =>
              insert.kind === 'link'
                ? insertText(`[${text.replace(/[[\]]/g, '')}](${href})`, false)
                : insertText(buttonBlock(text, href), true)
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
