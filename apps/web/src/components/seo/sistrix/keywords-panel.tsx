'use client';

import {
  SEO_KEYWORD_INTENT_LABELS,
  SEO_KEYWORD_PRIORITY_LABELS,
  type SeoKeywordIntent,
  type SeoProjectKeywordDto,
  type UpdateSeoProjectKeywordInput,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { SeoOrigin } from './seo-origin';

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
import { type SistrixScope, useSistrixSerp } from '@/lib/seo-advanced/sistrix-hooks';
import { cn } from '@/lib/utils';

const NO_INTENT = 'none';

/** Los resultados de Google de una palabra según SISTRIX. */
export function SerpDialog({
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

/** Lo que se decide a mano de una palabra (grupo, intención, URL objetivo, prioridad, notas). */
export function EditKeywordDialog({
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
