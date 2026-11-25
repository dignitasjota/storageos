'use client';

import {
  SEO_KEYWORD_INTENT_LABELS,
  SEO_KEYWORD_PRIORITY_LABELS,
  SEO_TRACKED_PERIODS,
  type SeoKeywordIntent,
} from '@storageos/shared';
import { Loader2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

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
import { formatCount, formatDate, formatNumber } from '@/lib/format';
import {
  type CandidateFilters,
  type DiagnosticScope,
  useKeywordCandidates,
} from '@/lib/seo-advanced/diagnostic-hooks';
import { useAddKeywords } from '@/lib/seo-advanced/sistrix-hooks';

const AUTO = 'auto';
const ANY = 'any';

/**
 * Alta de palabras desde las búsquedas reales de Search Console del periodo:
 * con impresiones mínimas, posición máxima, sin la marca y sin las ya
 * seguidas; se eligen varias y se añaden con su grupo, prioridad e intención.
 */
export function KeywordCandidatesDialog({
  scope,
  open,
  onOpenChange,
  domainId,
}: {
  scope: DiagnosticScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domainId: string | null;
}) {
  const [filters, setFilters] = useState<CandidateFilters>({
    days: 28,
    domainId,
    minImpressions: 10,
    maxPosition: null,
    excludeBrand: true,
    excludeTracked: true,
    search: '',
  });
  const [minText, setMinText] = useState('10');
  const [searchText, setSearchText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState('');
  const [priority, setPriority] = useState('2');
  const [intent, setIntent] = useState(AUTO);
  const candidates = useKeywordCandidates(scope, filters, open);
  const add = useAddKeywords(scope);

  useEffect(() => setFilters((f) => ({ ...f, domainId })), [domainId]);
  // El buscador y el mínimo esperan a que dejes de escribir.
  useEffect(() => {
    const t = setTimeout(
      () =>
        setFilters((f) => ({
          ...f,
          search: searchText,
          minImpressions: Math.max(0, Number(minText) || 0),
        })),
      350,
    );
    return () => clearTimeout(t);
  }, [searchText, minText]);

  const items = candidates.data?.items ?? [];
  const selectable = items.filter((c) => !c.tracked);
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.query));
  const toggle = (q: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      return next;
    });

  const submit = async () => {
    if (selected.size === 0) return;
    try {
      await add.mutateAsync({
        keywords: [...selected],
        source: 'search_console',
        groupName: group.trim() || null,
        priority: Number(priority),
        intent: intent === AUTO ? null : (intent as SeoKeywordIntent),
      });
      toast.success(
        selected.size === 1 ? 'Palabra añadida' : `${formatCount(selected.size)} palabras añadidas`,
      );
      setSelected(new Set());
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Añadir desde Search Console</DialogTitle>
          <DialogDescription>
            Búsquedas reales por las que ha salido tu web
            {candidates.data
              ? ` del ${formatDate(candidates.data.from)} al ${formatDate(candidates.data.to)}`
              : ''}
            . Elige las que quieres seguir.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-4">
          <Select
            value={String(filters.days)}
            onValueChange={(v) => setFilters((f) => ({ ...f, days: Number(v) }))}
          >
            <SelectTrigger aria-label="Periodo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEO_TRACKED_PERIODS.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  Últimos {p} días
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            inputMode="numeric"
            value={minText}
            onChange={(e) => setMinText(e.target.value.replace(/\D/g, ''))}
            aria-label="Impresiones mínimas"
            placeholder="Impresiones mínimas"
          />
          <Select
            value={filters.maxPosition === null ? ANY : String(filters.maxPosition)}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, maxPosition: v === ANY ? null : Number(v) }))
            }
          >
            <SelectTrigger aria-label="Posición máxima">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Cualquier posición</SelectItem>
              <SelectItem value="10">Hasta la 10</SelectItem>
              <SelectItem value="20">Hasta la 20</SelectItem>
              <SelectItem value="50">Hasta la 50</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            aria-label="Buscar"
            placeholder="Buscar"
          />
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={filters.excludeBrand}
              onCheckedChange={(v) => setFilters((f) => ({ ...f, excludeBrand: v === true }))}
            />
            Sin las de tu marca
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={filters.excludeTracked}
              onCheckedChange={(v) => setFilters((f) => ({ ...f, excludeTracked: v === true }))}
            />
            Sin las que ya sigues
          </label>
        </div>

        {candidates.isError ? (
          <SectionError onRetry={() => void candidates.refetch()} />
        ) : candidates.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No hay búsquedas con estos filtros.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(v) =>
                    setSelected(v === true ? new Set(selectable.map((c) => c.query)) : new Set())
                  }
                />
                Elegir todas las que se ven
              </label>
              <span>
                {formatCount(items.length)} de {formatCount(candidates.data?.total ?? 0)} ·{' '}
                {formatCount(selected.size)} elegidas
              </span>
            </div>
            <ul className="max-h-[40vh] divide-y overflow-y-auto rounded-md border">
              {items.map((c) => (
                <li key={c.query}>
                  <label className="flex cursor-pointer items-start gap-3 p-2.5">
                    <Checkbox
                      className="mt-0.5"
                      disabled={c.tracked}
                      checked={selected.has(c.query)}
                      onCheckedChange={() => toggle(c.query)}
                    />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="break-words font-medium">{c.query}</span>
                        {c.brand && <Badge variant="outline">Marca</Badge>}
                        {c.tracked && <Badge variant="secondary">Ya la sigues</Badge>}
                        {c.intent && (
                          <span className="text-xs text-muted-foreground">
                            {SEO_KEYWORD_INTENT_LABELS[c.intent]}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        {formatCount(c.impressions)} impresiones · {formatCount(c.clicks)} clics ·
                        posición {c.position === null ? '—' : formatNumber(c.position, 1)}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="cand-group">Grupo</Label>
            <Input
              id="cand-group"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="Opcional"
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
          <div className="space-y-1">
            <Label>Intención</Label>
            <Select value={intent} onValueChange={setIntent}>
              <SelectTrigger aria-label="Intención">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>La que se deduzca</SelectItem>
                {(Object.keys(SEO_KEYWORD_INTENT_LABELS) as SeoKeywordIntent[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {SEO_KEYWORD_INTENT_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={selected.size === 0 || add.isPending}>
            {add.isPending ? (
              <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="mr-1 size-4" aria-hidden />
            )}
            Añadir {selected.size > 0 ? formatCount(selected.size) : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
