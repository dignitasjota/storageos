'use client';

import {
  SEO_AI_DRAFT_NOTICE,
  SEO_BRIEF_SOURCE_LABELS,
  SEO_BRIEF_STATUSES,
  SEO_BRIEF_STATUS_LABELS,
  type SeoBriefStatus,
  type SeoMetaProposalDto,
} from '@storageos/shared';
import { Copy, Download, FileText, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PrepareContentButton } from './prepare-content-button';
import { SEO_OPEN_BRIEF_EVENT, useSeoAi } from './seo-ai-context';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { seoErrorMessage } from '@/components/seo/seo-errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import {
  downloadSeoBrief,
  useDeleteSeoBrief,
  useSeoBrief,
  useSeoBriefToDraft,
  useSeoBriefs,
  useUpdateSeoBrief,
} from '@/lib/seo-advanced/assistant-hooks';

const STATUS_TONE: Record<SeoBriefStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  in_progress: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  published: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
};

/**
 * Borradores de contenido (briefs) del proyecto: se generan con IA desde una
 * palabra, una oportunidad, un grupo o una URL («Preparar contenido» en sus
 * fichas, o aquí desde una URL), se editan, se copian, se exportan en
 * Markdown y se pasan a una entrada en borrador del blog y a una tarea.
 */
export function SeoBriefsCard() {
  const ai = useSeoAi();
  if (!ai) return null;
  return <BriefsCard />;
}

function BriefsCard() {
  const { scope, canGenerate } = useSeoAi()!;
  const briefs = useSeoBriefs(scope);
  const [openId, setOpenId] = useState<string | null>(null);
  const [url, setUrl] = useState('');

  // Un brief que se pide abrir desde otra pestaña («Abrir» tras prepararlo).
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('brief');
    if (fromUrl) {
      setOpenId(fromUrl);
      const u = new URL(window.location.href);
      u.searchParams.delete('brief');
      window.history.replaceState(window.history.state, '', u.toString());
    }
    const onOpen = (e: Event) => setOpenId((e as CustomEvent<string>).detail);
    window.addEventListener(SEO_OPEN_BRIEF_EVENT, onOpen);
    return () => window.removeEventListener(SEO_OPEN_BRIEF_EVENT, onOpen);
  }, []);

  const list = briefs.data ?? [];
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="size-4 text-primary" aria-hidden /> Borradores de contenido
        </CardTitle>
        <CardDescription>
          Briefs para escribir o mejorar una página: lo que busca la gente, la estructura, los
          enlaces internos y tres propuestas de título y descripción. Prepáralos con «Preparar
          contenido» en una palabra, una oportunidad o un grupo, o aquí desde una URL. Los hace una
          IA: revísalos siempre.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canGenerate && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor="seo-brief-url">Desde una URL de tu web</Label>
              <Input
                id="seo-brief-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="/precios o https://…"
                maxLength={2000}
              />
            </div>
            {url.trim() && <PrepareContentButton source={{ source: 'url', url: url.trim() }} />}
          </div>
        )}
        {briefs.isError ? (
          <SectionError onRetry={() => void briefs.refetch()} />
        ) : briefs.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay borradores de contenido.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {list.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(b.id)}
                  className="flex w-full flex-col gap-1 px-3 py-2 text-left transition hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{b.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {SEO_BRIEF_SOURCE_LABELS[b.source]} · {formatDateTime(b.updatedAt)}
                    </span>
                  </span>
                  <span
                    className={`w-fit shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[b.status]}`}
                  >
                    {SEO_BRIEF_STATUS_LABELS[b.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <BriefSheet id={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}

function lengthTone(status: SeoMetaProposalDto['titleStatus']): string {
  return status === 'ok'
    ? 'text-emerald-700 dark:text-emerald-400'
    : 'text-amber-700 dark:text-amber-300';
}

function BriefSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { scope, canWrite } = useSeoAi()!;
  const ask = useConfirm();
  const brief = useSeoBrief(scope, id);
  const update = useUpdateSeoBrief(scope);
  const remove = useDeleteSeoBrief(scope);
  const toDraft = useSeoBriefToDraft(scope);
  const [text, setText] = useState('');
  const [blog, setBlog] = useState(true);
  const [task, setTask] = useState(true);
  const b = brief.data;

  useEffect(() => {
    if (b) setText(b.contentMarkdown);
  }, [b]);

  const dirty = !!b && text !== b.contentMarkdown;
  const hasBlog = !!(b?.blogPostId || b?.platformBlogPostId);
  const save = async () => {
    if (!b) return;
    try {
      await update.mutateAsync({ id: b.id, contentMarkdown: text });
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const setStatus = async (status: SeoBriefStatus) => {
    if (!b) return;
    try {
      await update.mutateAsync({ id: b.id, status });
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copiado');
    } catch {
      toast.error('No se pudo copiar.');
    }
  };
  const exportMd = async () => {
    if (!b) return;
    try {
      await downloadSeoBrief(scope, b.id, b.title);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const draft = async () => {
    if (!b || (!(blog && !hasBlog) && !(task && !b.taskId))) return;
    try {
      const res = await toDraft.mutateAsync({
        id: b.id,
        blog: blog && !hasBlog,
        task: task && !b.taskId,
      });
      toast.success(
        res.blogLink
          ? 'Entrada creada en el blog, sin publicar. Revísala antes de publicarla.'
          : 'Tarea creada.',
        res.blogLink
          ? { action: { label: 'Abrir', onClick: () => window.open(res.blogLink!, '_self') } }
          : undefined,
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const del = async () => {
    if (!b || !(await ask({ title: '¿Borrar este brief?', destructive: true }))) return;
    try {
      await remove.mutateAsync(b.id);
      onClose();
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="pr-6">{b?.title ?? 'Borrador de contenido'}</SheetTitle>
        </SheetHeader>
        {brief.isError ? (
          <SectionError onRetry={() => void brief.refetch()} />
        ) : !b ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {SEO_AI_DRAFT_NOTICE}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{SEO_BRIEF_SOURCE_LABELS[b.source]}</Badge>
              <span className="break-all">{b.sourceLabel}</span>
              {b.targetUrl && <span className="break-all">· {b.targetUrl}</span>}
            </div>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Propuestas de título y descripción</h3>
              <ol className="space-y-2">
                {b.structure.metaProposals.map((m, i) => (
                  <li key={i} className="rounded-md border p-2 text-sm">
                    <p className="font-medium break-words">{m.title}</p>
                    <p className={`text-xs ${lengthTone(m.titleStatus)}`}>
                      {m.titleLength} caracteres
                      {m.titleStatus === 'ok'
                        ? ''
                        : m.titleStatus === 'short'
                          ? ' (corto)'
                          : ' (largo: Google lo cortará)'}
                    </p>
                    <p className="mt-1 break-words text-muted-foreground">{m.description}</p>
                    <p className={`text-xs ${lengthTone(m.descriptionStatus)}`}>
                      {m.descriptionLength} caracteres
                      {m.descriptionStatus === 'ok'
                        ? ''
                        : m.descriptionStatus === 'short'
                          ? ' (corta)'
                          : ' (larga: Google la cortará)'}
                    </p>
                  </li>
                ))}
              </ol>
            </section>

            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Brief</h3>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void copy()}>
                    <Copy className="mr-1 size-4" aria-hidden /> Copiar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void exportMd()}>
                    <Download className="mr-1 size-4" aria-hidden /> Markdown
                  </Button>
                </div>
              </div>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                readOnly={!canWrite}
                rows={18}
                className="font-mono text-xs"
                aria-label="Texto del brief"
              />
              {canWrite && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => void save()}
                    disabled={!dirty || update.isPending}
                  >
                    Guardar
                  </Button>
                  <Select
                    value={b.status}
                    onValueChange={(v) => void setStatus(v as SeoBriefStatus)}
                  >
                    <SelectTrigger className="h-9 w-40" aria-label="Estado">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SEO_BRIEF_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {SEO_BRIEF_STATUS_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </section>

            {canWrite && (
              <section className="space-y-2 rounded-lg border p-3">
                <h3 className="text-sm font-medium">Pasar a borrador</h3>
                <p className="text-xs text-muted-foreground">
                  Crea una entrada del blog sin publicar con este esquema (para que la escribas y la
                  revises) y una tarea de contenido enlazada. Nunca se publica sola.
                </p>
                <div className="flex flex-col gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={blog && !hasBlog}
                      disabled={hasBlog}
                      onCheckedChange={(v) => setBlog(v === true)}
                    />
                    {hasBlog ? 'Ya tiene su entrada en el blog' : 'Entrada en el blog (borrador)'}
                  </label>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={task && !b.taskId}
                      disabled={!!b.taskId}
                      onCheckedChange={(v) => setTask(v === true)}
                    />
                    {b.taskId ? 'Ya tiene su tarea' : 'Tarea SEO de contenido'}
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void draft()}
                    disabled={toDraft.isPending || !((blog && !hasBlog) || (task && !b.taskId))}
                  >
                    {toDraft.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                    Crear
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void del()}>
                    <Trash2 className="mr-1 size-4" aria-hidden /> Borrar el brief
                  </Button>
                </div>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
