'use client';

import {
  SEO_KEYWORD_INTENT_LABELS,
  SEO_KEYWORD_PRIORITY_LABELS,
  type SeoKeywordIntent,
  type SeoProjectKeywordDto,
  type UpdateSeoProjectKeywordInput,
} from '@storageos/shared';
import { Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { SeoOrigin } from './seo-origin';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { formatCount, formatEur } from '@/lib/format';
import {
  type SistrixScope,
  useAddKeywords,
  useRemoveKeyword,
  useSistrixKeywords,
  useSistrixSerp,
  useUpdateKeyword,
} from '@/lib/seo-advanced/sistrix-hooks';
import { cn } from '@/lib/utils';

const NO_INTENT = 'none';

function SerpDialog({
  scope,
  keyword,
  onClose,
}: {
  scope: SistrixScope;
  keyword: SeoProjectKeywordDto | null;
  onClose: () => void;
}) {
  const serp = useSistrixSerp(scope, keyword?.id ?? null);
  return (
    <Dialog open={!!keyword} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Google para «{keyword?.keyword}»</DialogTitle>
          <DialogDescription>
            Primeros resultados según SISTRIX (posiciones nacionales, no de una ciudad concreta).
          </DialogDescription>
        </DialogHeader>
        {serp.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : serp.isError ? (
          <SectionError onRetry={() => void serp.refetch()} />
        ) : !serp.data?.origin ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay resultados de esta palabra. Sincroniza «Resultados de Google de tus
            palabras».
          </p>
        ) : (
          <div className="space-y-2">
            <SeoOrigin origin={serp.data.origin} />
            <ol className="divide-y text-sm">
              {serp.data.results.map((r) => (
                <li
                  key={r.position}
                  className={cn(
                    'flex gap-3 py-2',
                    r.own && 'rounded bg-emerald-50 px-2 dark:bg-emerald-950/40',
                    r.competitor && 'rounded bg-amber-50 px-2 dark:bg-amber-950/40',
                  )}
                >
                  <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
                    {r.position}
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {r.domain}
                      {r.own && <Badge variant="secondary">Tú</Badge>}
                      {r.competitor && <Badge variant="outline">Competidor</Badge>}
                    </span>
                    <span className="block break-all text-xs text-muted-foreground">{r.url}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditKeywordDialog({
  keyword,
  onClose,
  onSave,
}: {
  keyword: SeoProjectKeywordDto | null;
  onClose: () => void;
  onSave: (input: UpdateSeoProjectKeywordInput) => Promise<unknown>;
}) {
  const [group, setGroup] = useState('');
  const [intent, setIntent] = useState<string>(NO_INTENT);
  const [url, setUrl] = useState('');
  const [priority, setPriority] = useState('2');
  const [notes, setNotes] = useState('');
  const [locked, setLocked] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (keyword && loadedFor !== keyword.id) {
    setLoadedFor(keyword.id);
    setGroup(keyword.groupName ?? '');
    setIntent(keyword.intent ?? NO_INTENT);
    setUrl(keyword.targetUrl ?? '');
    setPriority(String(keyword.priority));
    setNotes(keyword.notes ?? '');
    setLocked(keyword.strategyLocked);
  }
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onSave({
        groupName: group.trim() || null,
        intent: intent === NO_INTENT ? null : (intent as SeoKeywordIntent),
        targetUrl: url.trim() || null,
        priority: Number(priority),
        notes: notes.trim() || null,
        strategyLocked: locked,
      });
      toast.success('Palabra guardada');
      onClose();
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <Dialog open={!!keyword} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>«{keyword?.keyword}»</DialogTitle>
          <DialogDescription>Lo que decides tú sobre esta palabra.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void save(e)} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="kw-group">Grupo</Label>
              <Input
                id="kw-group"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="Trasteros Valencia"
              />
            </div>
            <div className="space-y-1">
              <Label>Prioridad</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger aria-label="Prioridad">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3].map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      {SEO_KEYWORD_PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label>Intención</Label>
            <Select value={intent} onValueChange={setIntent}>
              <SelectTrigger aria-label="Intención">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_INTENT}>Sin decidir</SelectItem>
                {(Object.keys(SEO_KEYWORD_INTENT_LABELS) as SeoKeywordIntent[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SEO_KEYWORD_INTENT_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="kw-url">Página que debería salir</Label>
            <Input
              id="kw-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="kw-notes">Notas</Label>
            <Textarea
              id="kw-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={locked} onCheckedChange={(v) => setLocked(v === true)} />
            <span>
              Decisión fijada
              <span className="block text-xs text-muted-foreground">
                Una importación posterior no cambiará lo que has decidido aquí.
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit">Guardar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Palabras del proyecto: grupo, intención, página, prioridad, métricas y resultados de Google. */
export function KeywordsPanel({
  scope,
  canEdit,
  limit,
}: {
  scope: SistrixScope;
  canEdit: boolean;
  limit: number;
}) {
  const confirm = useConfirm();
  const keywords = useSistrixKeywords(scope);
  const add = useAddKeywords(scope);
  const update = useUpdateKeyword(scope);
  const remove = useRemoveKeyword(scope);
  const [text, setText] = useState('');
  const [serpOf, setSerpOf] = useState<SeoProjectKeywordDto | null>(null);
  const [editing, setEditing] = useState<SeoProjectKeywordDto | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const list = text
      .split(/[\n,;]/)
      .map((k) => k.trim())
      .filter((k) => k.length >= 2);
    if (list.length === 0) return;
    try {
      await add.mutateAsync({ keywords: list });
      setText('');
      toast.success(list.length === 1 ? 'Palabra añadida' : `${list.length} palabras añadidas`);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const del = async (k: SeoProjectKeywordDto) => {
    const yes = await confirm({
      title: `¿Quitar «${k.keyword}»?`,
      description: 'Se pierden el grupo, la página y las notas que le hayas puesto.',
      confirmLabel: 'Quitar',
      destructive: true,
    });
    if (!yes) return;
    try {
      await remove.mutateAsync(k.id);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const rows = keywords.data ?? [];
  return (
    <div className="space-y-4">
      {canEdit && (
        <form onSubmit={(e) => void submit(e)} className="space-y-2">
          <Label htmlFor="kw-new">Añadir palabras (una por línea)</Label>
          <Textarea
            id="kw-new"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder={'trasteros valencia\nguardamuebles mislata'}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {rows.length} de {formatCount(limit)} palabras
            </span>
            <Button type="submit" size="sm" disabled={add.isPending || !text.trim()}>
              <Plus className="mr-1 size-4" aria-hidden /> Añadir
            </Button>
          </div>
        </form>
      )}
      {keywords.isError ? (
        <SectionError onRetry={() => void keywords.refetch()} />
      ) : keywords.isLoading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aún no hay palabras. Añádelas a mano o desde las ideas y oportunidades de SISTRIX.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((k) => (
            <li key={k.id} className={cn('space-y-1 p-3', !k.isActive && 'opacity-60')}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{k.keyword}</span>
                    <Badge variant="outline">{SEO_KEYWORD_PRIORITY_LABELS[k.priority]}</Badge>
                    {k.groupName && <Badge variant="secondary">{k.groupName}</Badge>}
                    {k.intent && (
                      <span className="text-xs text-muted-foreground">
                        {SEO_KEYWORD_INTENT_LABELS[k.intent]}
                      </span>
                    )}
                    {k.strategyLocked && (
                      <Lock
                        className="size-3.5 text-muted-foreground"
                        aria-label="Decisión fijada"
                      />
                    )}
                  </div>
                  {k.targetUrl && (
                    <span className="block break-all text-xs text-muted-foreground">
                      {k.targetUrl}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="outline" size="sm" onClick={() => setSerpOf(k)}>
                    Ver Google
                  </Button>
                  {canEdit && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Editar ${k.keyword}`}
                        onClick={() => setEditing(k)}
                      >
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Quitar ${k.keyword}`}
                        onClick={() => void del(k)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {k.metrics ? (
                  <>
                    <span>Búsquedas {formatCount(k.metrics.traffic)}</span>
                    <span>CPC {k.metrics.cpc !== null ? formatEur(k.metrics.cpc) : '—'}</span>
                    <span>Competencia {k.metrics.competition ?? '—'}/100</span>
                    {k.metrics.intent.do !== null && (
                      <span>
                        Contratar {k.metrics.intent.do} % · Ir {k.metrics.intent.visit ?? 0} %
                      </span>
                    )}
                    <SeoOrigin origin={k.metrics} />
                  </>
                ) : (
                  <span className="text-muted-foreground">Sin métricas de SISTRIX aún.</span>
                )}
              </div>
              {k.serp && (
                <div className="flex flex-wrap gap-x-4 text-xs">
                  <span>
                    Tu posición: {k.serp.ownPosition ?? 'no sale en los 10 primeros'}
                    {k.serp.competitors > 0 ? ` · ${k.serp.competitors} competidor(es) arriba` : ''}
                  </span>
                  <SeoOrigin origin={k.serp} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <SerpDialog scope={scope} keyword={serpOf} onClose={() => setSerpOf(null)} />
      <EditKeywordDialog
        keyword={editing}
        onClose={() => setEditing(null)}
        onSave={(input) => update.mutateAsync({ id: editing!.id, ...input })}
      />
    </div>
  );
}
