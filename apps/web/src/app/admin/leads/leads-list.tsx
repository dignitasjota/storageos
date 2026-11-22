'use client';

import {
  PLATFORM_LEAD_LOST_REASON_LABELS,
  PLATFORM_LEAD_MANUAL_LOST_REASONS,
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_SOURCES,
  PLATFORM_LEAD_STAGE_LABELS,
  PLATFORM_LEAD_STAGES,
  type PlatformLeadBulkInput,
  type PlatformLeadBulkResultDto,
  type PlatformLeadDto,
  type PlatformLeadListQuery,
  type PlatformLeadLostReason,
  type PlatformLeadSource,
  type PlatformLeadStage,
} from '@storageos/shared';
import { ArrowDown, ArrowUp, Download, Loader2, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DiscardLeadDialog } from './lead-extra-dialogs';
import { STAGE_BADGE } from './lead-sheet';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
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
import {
  useDeleteListView,
  useListViews,
  useSaveListView,
} from '@/lib/admin/health-insights-hooks';
import { useAdminSuperAdmins } from '@/lib/admin/hooks';
import {
  downloadSelectedLeadsCsv,
  useAdminLeadList,
  useLeadsBulk,
  type LeadListFilters,
} from '@/lib/admin/leads-hooks';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';
import { formatDate, formatEur, plural } from '@/lib/format';

const ALL = '__all__';
const NONE = '__none__';
type Sort = PlatformLeadListQuery['sort'];
type Dir = PlatformLeadListQuery['dir'];
type ManualLost = Exclude<PlatformLeadLostReason, 'churned' | 'no_conversion'>;

/** Tamaños para filtrar (trasteros que declaró). */
const SIZES: { key: string; label: string; min?: number; max?: number }[] = [
  { key: 'small', label: 'Menos de 50 trasteros', max: 49 },
  { key: 'mid', label: 'De 50 a 200', min: 50, max: 200 },
  { key: 'big', label: 'Más de 200', min: 201 },
];

interface ViewState {
  filters: LeadListFilters;
  sort: Sort;
  dir: Dir;
}

const EMPTY: ViewState = { filters: {}, sort: 'createdAt', dir: 'desc' };

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

function ago(iso: string | null): string {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'hoy';
  return days === 1 ? 'hace 1 día' : `hace ${days} días`;
}

/**
 * Vista de lista de los leads: columnas, orden por columna, filtros, vistas
 * guardadas y acciones en lote sobre los que se marquen.
 */
export function LeadsList({ onOpen }: { onOpen: (id: string) => void }) {
  const ask = useConfirm();
  const admins = useAdminSuperAdmins();
  const views = useListViews('leads');
  const saveView = useSaveListView('leads');
  const removeView = useDeleteListView('leads');
  const bulk = useLeadsBulk();
  const [state, setState] = useState<ViewState>(EMPTY);
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<null | 'lose' | 'discard' | 'followup'>(null);

  // Buscar y ciudad, con un respiro al escribir.
  useEffect(() => {
    const t = setTimeout(
      () =>
        setState((s) => ({
          ...s,
          filters: {
            ...s.filters,
            search: search.trim().length >= 2 ? search.trim() : undefined,
            city: city.trim() || undefined,
          },
        })),
      300,
    );
    return () => clearTimeout(t);
  }, [search, city]);
  // Otro filtro u orden: a la primera página y sin selección.
  useEffect(() => {
    setCursor(null);
    setHistory([]);
    setSelected(new Set());
  }, [state]);

  const list = useAdminLeadList(state.filters, state.sort, state.dir, cursor);
  const items = list.data?.items ?? [];
  const today = localDateString();
  const setFilter = (patch: Partial<LeadListFilters>) =>
    setState((s) => ({ ...s, filters: { ...s.filters, ...patch } }));
  const sortBy = (k: Sort) =>
    setState((s) => ({
      ...s,
      sort: k,
      dir:
        s.sort === k
          ? s.dir === 'asc'
            ? 'desc'
            : 'asc'
          : k === 'name' || k === 'city'
            ? 'asc'
            : 'desc',
    }));
  const sizeKey =
    SIZES.find((x) => x.min === state.filters.sizeMin && x.max === state.filters.sizeMax)?.key ??
    ALL;
  const stageKey = state.filters.status?.length
    ? state.filters.status.length === 4 && !state.filters.status.includes('customer')
      ? 'open'
      : state.filters.status[0]!
    : ALL;
  const allChecked = items.length > 0 && items.every((l) => selected.has(l.id));

  async function run(input: PlatformLeadBulkInput, ok: string) {
    try {
      const res: PlatformLeadBulkResultDto = await bulk.mutateAsync(input);
      if (res.failed.length) {
        toast.warning(`${ok}: ${res.done} hechos y ${res.failed.length} no`, {
          description: res.failed
            .slice(0, 5)
            .map((f) => `${f.name}: ${f.message}`)
            .join(' · '),
        });
      } else {
        toast.success(`${ok}: ${plural(res.done, 'lead', 'leads')}.`);
      }
      setSelected(new Set());
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido hacer.'));
    }
  }

  async function saveCurrentView() {
    const res = await ask({
      title: 'Guardar vista',
      description: 'Se guarda con los filtros y el orden actuales.',
      input: { label: 'Nombre de la vista', placeholder: 'p. ej. Grandes sin actividad' },
      confirmLabel: 'Guardar',
    });
    const name = res ? res.value.trim() : '';
    if (!name) return;
    try {
      await saveView.mutateAsync({ name, filters: state as unknown as Record<string, unknown> });
      toast.success('Vista guardada.');
    } catch {
      toast.error('No se ha podido guardar la vista.');
    }
  }

  const header = (k: Sort, label: string, className = '') => (
    <th className={`px-2 py-2 font-medium ${className}`}>
      <button
        type="button"
        onClick={() => sortBy(k)}
        aria-pressed={state.sort === k}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted ${state.sort === k ? 'text-foreground' : ''}`}
      >
        {label}
        {state.sort === k &&
          (state.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );

  const selectedIds = [...selected];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Buscar"
          placeholder="Buscar por empresa, persona, email o teléfono"
          className="h-9 w-full sm:w-72"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          value={stageKey}
          onValueChange={(v) =>
            setFilter({
              status:
                v === ALL
                  ? undefined
                  : v === 'open'
                    ? ['new', 'contacted', 'interested', 'trial']
                    : [v as PlatformLeadStage],
            })
          }
        >
          <SelectTrigger className="h-9 w-[170px]" aria-label="Fase">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todas las fases</SelectItem>
            <SelectItem value="open">Abiertos</SelectItem>
            {PLATFORM_LEAD_STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                {PLATFORM_LEAD_STAGE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sizeKey}
          onValueChange={(v) => {
            const size = SIZES.find((x) => x.key === v);
            setFilter({ sizeMin: size?.min, sizeMax: size?.max });
          }}
        >
          <SelectTrigger className="h-9 w-[180px]" aria-label="Tamaño">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Cualquier tamaño</SelectItem>
            {SIZES.map((x) => (
              <SelectItem key={x.key} value={x.key}>
                {x.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Ciudad"
          placeholder="Ciudad"
          className="h-9 w-full sm:w-36"
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
        <Select
          value={state.filters.source ?? ALL}
          onValueChange={(v) =>
            setFilter({ source: v === ALL ? undefined : (v as PlatformLeadSource) })
          }
        >
          <SelectTrigger className="h-9 w-[180px]" aria-label="Origen">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los orígenes</SelectItem>
            {PLATFORM_LEAD_SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {PLATFORM_LEAD_SOURCE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={state.filters.assignedTo ?? ALL}
          onValueChange={(v) => setFilter({ assignedTo: v === ALL ? undefined : v })}
        >
          <SelectTrigger className="h-9 w-[170px]" aria-label="Responsable">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todo el equipo</SelectItem>
            <SelectItem value="me">Los míos</SelectItem>
            <SelectItem value="none">Sin responsable</SelectItem>
            {(admins.data ?? [])
              .filter((a) => a.isActive)
              .map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.fullName}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select
          value={state.filters.inactiveDays ? String(state.filters.inactiveDays) : ALL}
          onValueChange={(v) => setFilter({ inactiveDays: v === ALL ? undefined : Number(v) })}
        >
          <SelectTrigger className="h-9 w-[200px]" aria-label="Sin actividad">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Con o sin actividad</SelectItem>
            {[3, 7, 14, 30].map((d) => (
              <SelectItem key={d} value={String(d)}>
                Sin actividad en {d} días
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={!!state.filters.stale}
            onChange={(e) => setFilter({ stale: e.target.checked || undefined })}
          />
          Solo parados
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={!!state.filters.discarded}
            onChange={(e) => setFilter({ discarded: e.target.checked || undefined })}
          />
          Descartados
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(views.data?.length ?? 0) > 0 && (
          <Select
            value=""
            onValueChange={(id) => {
              const v = views.data?.find((x) => x.id === id);
              if (!v) return;
              const saved = v.filters as Partial<ViewState>;
              setState({
                filters: saved.filters ?? {},
                sort: saved.sort ?? 'createdAt',
                dir: saved.dir ?? 'desc',
              });
              setSearch(saved.filters?.search ?? '');
              setCity(saved.filters?.city ?? '');
            }}
          >
            <SelectTrigger className="h-8 w-[180px]">
              <SelectValue placeholder="Vistas guardadas" />
            </SelectTrigger>
            <SelectContent>
              {views.data?.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="outline" size="sm" onClick={() => void saveCurrentView()}>
          <Save className="mr-1.5 size-4" aria-hidden /> Guardar vista
        </Button>
        {(views.data?.length ?? 0) > 0 && (
          <Select
            value=""
            onValueChange={(id) =>
              removeView.mutate(id, { onSuccess: () => toast.success('Vista borrada.') })
            }
          >
            <SelectTrigger className="h-8 w-auto" aria-label="Borrar una vista">
              <Trash2 className="size-4 text-muted-foreground" />
            </SelectTrigger>
            <SelectContent>
              {views.data?.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  Borrar «{v.name}»
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {(Object.values(state.filters).some((v) => v !== undefined) || search || city) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setState(EMPTY);
              setSearch('');
              setCity('');
            }}
          >
            Quitar filtros
          </Button>
        )}
        {list.data && (
          <span className="ml-auto text-sm text-muted-foreground">
            {plural(list.data.total, 'lead', 'leads')}
            {list.data.totalValue > 0 ? ` · ${formatEur(list.data.totalValue)}/mes en juego` : ''}
          </span>
        )}
      </div>

      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Acciones en lote"
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 p-2 text-sm"
        >
          <span className="font-medium">{plural(selected.size, 'marcado', 'marcados')}</span>
          <Select
            value=""
            onValueChange={(v) =>
              void run(
                { action: 'assign', ids: selectedIds, assignedToId: v === NONE ? null : v },
                'Asignados',
              )
            }
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label="Asignar a">
              <SelectValue placeholder="Asignar a…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Nadie</SelectItem>
              {(admins.data ?? [])
                .filter((a) => a.isActive)
                .map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.fullName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Select
            value=""
            onValueChange={(v) =>
              void run(
                {
                  action: 'move',
                  ids: selectedIds,
                  status: v as 'new' | 'contacted' | 'interested',
                },
                'Movidos',
              )
            }
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label="Mover a">
              <SelectValue placeholder="Mover a…" />
            </SelectTrigger>
            <SelectContent>
              {(['new', 'contacted', 'interested'] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {PLATFORM_LEAD_STAGE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={() => setDialog('followup')}>
            Seguimiento…
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('lose')}>
            Perdidos…
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('discard')}>
            No son leads…
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void downloadSelectedLeadsCsv(selectedIds).catch(() =>
                toast.error('No se ha podido descargar.'),
              )
            }
          >
            <Download className="mr-1 size-3.5" aria-hidden /> Exportar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Desmarcar
          </Button>
          {bulk.isPending && <Loader2 className="size-4 animate-spin" />}
        </div>
      )}

      {list.isError ? (
        <AdminError onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">Ningún lead con estos filtros.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[1000px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="w-8 px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label="Marcar todos los de esta página"
                    checked={allChecked}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(items.map((l) => l.id)) : new Set())
                    }
                  />
                </th>
                {header('name', 'Nombre')}
                {header('company', 'Empresa')}
                {header('status', 'Fase')}
                {header('score', 'Puntos', 'text-right')}
                {header('value', 'Cuota prevista', 'text-right')}
                {header('source', 'Origen')}
                {header('city', 'Ciudad')}
                {header('assignee', 'Responsable')}
                {header('lastActivity', 'Última actividad')}
                {header('nextFollowup', 'Seguimiento')}
                {header('createdAt', 'Alta')}
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <Row
                  key={l.id}
                  lead={l}
                  today={today}
                  checked={selected.has(l.id)}
                  onCheck={(c) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (c) next.add(l.id);
                      else next.delete(l.id);
                      return next;
                    })
                  }
                  onOpen={() => onOpen(l.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.data && (history.length > 0 || list.data.nextCursor) && (
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={history.length === 0}
            onClick={() => {
              const prev = history[history.length - 1] ?? null;
              setHistory(history.slice(0, -1));
              setCursor(prev);
            }}
          >
            Anterior
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!list.data.nextCursor}
            onClick={() => {
              setHistory([...history, cursor]);
              setCursor(list.data!.nextCursor);
            }}
          >
            Siguiente
          </Button>
        </div>
      )}

      {dialog === 'discard' && (
        <DiscardLeadDialog
          leadIds={selectedIds}
          name={plural(selectedIds.length, 'lead', 'leads')}
          onClose={() => setDialog(null)}
          submit={async (reasonCode, reason) => {
            await run({ action: 'discard', ids: selectedIds, reasonCode, reason }, 'Descartados');
          }}
        />
      )}
      {dialog === 'lose' && (
        <BulkLoseDialog
          count={selectedIds.length}
          onClose={() => setDialog(null)}
          onSubmit={(reasonCode, reason) =>
            run({ action: 'lose', ids: selectedIds, reasonCode, reason }, 'Perdidos')
          }
        />
      )}
      {dialog === 'followup' && (
        <BulkFollowupDialog
          count={selectedIds.length}
          onClose={() => setDialog(null)}
          onSubmit={(title, dueDate, note) =>
            run({ action: 'followup', ids: selectedIds, title, dueDate, note }, 'Con seguimiento')
          }
        />
      )}
    </div>
  );
}

function Row({
  lead,
  today,
  checked,
  onCheck,
  onOpen,
}: {
  lead: PlatformLeadDto;
  today: string;
  checked: boolean;
  onCheck: (c: boolean) => void;
  onOpen: () => void;
}) {
  const late = lead.nextFollowup && lead.nextFollowup.dueDate <= today;
  return (
    <tr className="border-b last:border-0 hover:bg-muted/40">
      <td className="px-2 py-1.5">
        <input
          type="checkbox"
          aria-label={`Marcar ${lead.displayName}`}
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
        />
      </td>
      <td className="px-2 py-1.5">
        <button type="button" onClick={onOpen} className="text-left font-medium hover:underline">
          {lead.contactName ?? lead.displayName}
        </button>
        {lead.staleDays !== null && (
          <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Parado {lead.staleDays} d
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">{lead.companyName ?? '—'}</td>
      <td className="px-2 py-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${STAGE_BADGE[lead.status] ?? ''}`}>
          {PLATFORM_LEAD_STAGE_LABELS[lead.status]}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">{lead.score}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {lead.estimatedMonthly !== null ? formatEur(lead.estimatedMonthly) : '—'}
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">
        {PLATFORM_LEAD_SOURCE_LABELS[lead.source] ?? lead.source}
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">{lead.city ?? '—'}</td>
      <td className="px-2 py-1.5 text-muted-foreground">{lead.assignedToName ?? 'Nadie'}</td>
      <td className="px-2 py-1.5 text-muted-foreground">{ago(lead.lastActivityAt)}</td>
      <td
        className={`px-2 py-1.5 ${late ? 'font-medium text-destructive' : 'text-muted-foreground'}`}
      >
        {lead.nextFollowup ? formatDate(lead.nextFollowup.dueDate) : '—'}
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">{formatDate(lead.createdAt)}</td>
    </tr>
  );
}

function BulkLoseDialog({
  count,
  onClose,
  onSubmit,
}: {
  count: number;
  onClose: () => void;
  onSubmit: (reasonCode: ManualLost, reason: string) => Promise<void>;
}) {
  const [reasonCode, setReasonCode] = useState<ManualLost>('no_response');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar perdidos ({count})</DialogTitle>
          <DialogDescription>
            El motivo sale en «Resultados». Los que ya son clientes no se tocan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={reasonCode} onValueChange={(v) => setReasonCode(v as ManualLost)}>
            <SelectTrigger aria-label="Motivo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLATFORM_LEAD_MANUAL_LOST_REASONS.filter((r) => r !== 'no_conversion').map((r) => (
                <SelectItem key={r} value={r}>
                  {PLATFORM_LEAD_LOST_REASON_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            aria-label="Detalle"
            placeholder="Detalle (opcional)"
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(reasonCode, reason);
              setBusy(false);
              onClose();
            }}
          >
            {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Marcar perdidos
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkFollowupDialog({
  count,
  onClose,
  onSubmit,
}: {
  count: number;
  onClose: () => void;
  onSubmit: (title: string, dueDate: string, note: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('Llamar');
  const [note, setNote] = useState('');
  const [due, setDue] = useState<string | undefined>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return localDateString(d);
  });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Añadir un seguimiento a {plural(count, 'lead', 'leads')}</DialogTitle>
          <DialogDescription>Cada uno lo lleva quien lleva el lead.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="bulk-fu-title" className="text-xs">
              Qué hay que hacer
            </Label>
            <Input
              id="bulk-fu-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <DateSelect value={due} onChange={setDue} future />
          <Textarea
            aria-label="Nota"
            placeholder="Nota (opcional)"
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy || title.trim().length < 2 || !due}
            onClick={async () => {
              if (!due) return;
              setBusy(true);
              await onSubmit(title, due, note);
              setBusy(false);
              onClose();
            }}
          >
            {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Añadir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
