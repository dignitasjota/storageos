'use client';

import {
  LEAD_LOST_REASON_LABELS,
  LEAD_STATUS_LABELS,
  LEAD_TRANSITIONS,
  LeadLostReasonEnum,
  type LeadDto,
  type LeadLostReason,
  type LeadStatusValue,
  leadSourceLabel,
} from '@storageos/shared';
import {
  BarChart3,
  Copy,
  Download,
  Gauge,
  LayoutGrid,
  List,
  Loader2,
  MessageSquareReply,
  Pencil,
  Plus,
  Search,
  Timer,
  Trash2,
  Upload,
  User,
  UserPlus,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { LeadActivity } from './lead-activity';
import { LeadConversation } from './lead-conversation';
import { LeadNextStep } from './lead-next-step';
import { LeadQuote } from './lead-quote';
import { LeadTimeline } from './lead-timeline';
import { LeadVisits } from './lead-visits';

import { useConfirm } from '@/components/confirm-provider';
import { EmailTypoHint } from '@/components/email-typo-hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { apiFetch } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useConvertLead,
  useCreateLead,
  useLeadSources,
  useSetLeadMarketing,
  useTransitionLead,
  useUpdateLead,
} from '@/lib/communications/hooks';
import { downloadCsv } from '@/lib/csv';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import {
  leadFilterQuery,
  useDeleteLead,
  useLeadSummary,
  type LeadBoardFilters,
} from '@/lib/leads/hooks';
import { useDebouncedSearch, usePagedList } from '@/lib/pagination';
import { useUsers } from '@/lib/users/hooks';

const COLUMNS: { status: LeadStatusValue; label: string }[] = [
  { status: 'new', label: 'Nuevos' },
  { status: 'contacted', label: 'Contactados' },
  { status: 'qualified', label: 'Cualificados' },
  { status: 'won', label: 'Ganados' },
  { status: 'lost', label: 'Perdidos' },
];

export default function LeadsPage() {
  return (
    <Suspense fallback={null}>
      <LeadsBoard />
    </Suspense>
  );
}

function LeadsBoard() {
  const ask = useConfirm();
  const transition = useTransitionLead();
  const convert = useConvertLead();
  const router = useRouter();
  const canWrite = useHasPermission('leads:write');
  const canImport = useHasPermission('imports:manage');
  const [mine, setMine] = useState(false);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [searchInput, search, setSearch] = useDebouncedSearch();
  const [extra, setExtra] = useState<Omit<LeadBoardFilters, 'mine' | 'search'>>({});
  const filters: LeadBoardFilters = { mine, search, ...extra };
  const summary = useLeadSummary(filters);
  const [dragging, setDragging] = useState<LeadDto | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<LeadDto | null>(null);
  // Pasar a «Perdidos» pide el motivo (dato para precios e informes).
  const [losing, setLosing] = useState<string | null>(null);
  // `/leads?lead=<id>` (desde «Hoy» y los avisos) abre la ficha del contacto.
  const params = useSearchParams();
  const openId = params.get('lead');
  useEffect(() => {
    if (!openId) return;
    let cancelled = false;
    apiFetch<LeadDto>(`/leads/${openId}`)
      .then((lead) => {
        if (!cancelled) setEditing(lead);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [openId]);

  async function onConvert(lead: LeadDto) {
    if (
      !(await ask({
        title: '¿Seguro?',
        description: `¿Convertir a «${lead.displayName}» en cliente? Si ya hay un inquilino con su email se enlaza con él; si no, se crea uno con sus datos. El contacto pasará a «Ganados».`,
      }))
    ) {
      return;
    }
    try {
      const result = await convert.mutateAsync({ id: lead.id, input: {} });
      toast.success('Lead convertido en cliente.');
      if (result.convertedCustomerId) router.push(`/customers/${result.convertedCustomerId}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo convertir el lead');
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Personas interesadas en alquilar. Arrastra la tarjeta a otra fase (en escritorio) o
            cámbiala desde «Editar».
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={mine ? 'default' : 'outline'} onClick={() => setMine((v) => !v)}>
            <User className="mr-1 h-4 w-4" /> {mine ? 'Solo los míos' : 'Todos'}
          </Button>
          <Button variant="outline" asChild>
            <Link href="/leads/report">
              <BarChart3 className="mr-1 h-4 w-4" /> Informe
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/leads/response">
              <Timer className="mr-1 h-4 w-4" /> Atención
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/leads/duplicates">
              <Copy className="mr-1 h-4 w-4" /> Duplicados
            </Link>
          </Button>
          {canImport && canWrite && (
            <Button variant="outline" asChild>
              <Link href="/leads/import">
                <Upload className="mr-1 h-4 w-4" /> Importar
              </Link>
            </Button>
          )}
          {canWrite && (
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Nuevo lead
            </Button>
          )}
        </div>
      </div>

      <LeadFilterBar
        search={searchInput}
        onSearch={setSearch}
        value={extra}
        onChange={setExtra}
        view={view}
        onView={setView}
        onExport={() => void exportCsv(filters)}
      />

      {newOpen && <LeadFormDialog onClose={() => setNewOpen(false)} />}
      {editing && <LeadFormDialog lead={editing} onClose={() => setEditing(null)} />}
      {losing && <LostReasonDialog leadId={losing} onClose={() => setLosing(null)} />}

      {view === 'list' ? (
        <LeadsList filters={filters} onEdit={setEditing} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
          {COLUMNS.map((col) => (
            <LeadsColumn
              key={col.status}
              status={col.status}
              label={col.label}
              filters={filters}
              summary={summary.data?.byStatus[col.status] ?? null}
              canWrite={canWrite}
              onDrop={() => {
                if (!dragging) return;
                const lead = dragging;
                if (lead.status === col.status) {
                  // Soltado en su misma columna.
                } else if (
                  col.status !== 'won' &&
                  !LEAD_TRANSITIONS[lead.status].includes(col.status)
                ) {
                  toast.error(
                    `No se puede pasar de «${LEAD_STATUS_LABELS[lead.status]}» a «${LEAD_STATUS_LABELS[col.status]}».`,
                  );
                } else if (col.status === 'lost') {
                  setLosing(lead.id);
                } else if (col.status === 'won') {
                  // «Ganado» = convertido en cliente.
                  if (!lead.convertedCustomerId) void onConvert(lead);
                } else {
                  transition.mutate(
                    { id: lead.id, input: { status: col.status } },
                    {
                      onError: (err) =>
                        toast.error(
                          err instanceof ApiError ? err.body.message : 'No se pudo mover el lead',
                        ),
                    },
                  );
                }
                setDragging(null);
              }}
              onDragStart={setDragging}
              onEdit={setEditing}
              onConvert={(lead) => void onConvert(lead)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const NONE_FILTER = '__all';
/** Dos por fila en el móvil; anchos fijos en escritorio. */
const FILTER_W = 'w-[calc(50%-0.25rem)] sm:w-44';

/** Origen, local, responsable y fechas de llegada; vista de tablero o lista. */
function LeadFilterBar({
  search,
  onSearch,
  value,
  onChange,
  view,
  onView,
  onExport,
}: {
  search: string;
  onSearch: (v: string) => void;
  value: Omit<LeadBoardFilters, 'mine' | 'search'>;
  onChange: (v: Omit<LeadBoardFilters, 'mine' | 'search'>) => void;
  view: 'board' | 'list';
  onView: (v: 'board' | 'list') => void;
  onExport: () => void;
}) {
  const sources = useLeadSources();
  const facilities = useFacilities();
  const users = useUsers();
  const set = (patch: Partial<typeof value>) => {
    const next = { ...value, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (!next[k]) delete next[k];
    onChange(next);
  };
  const active = Object.keys(value).length > 0 || !!search;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-56">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Buscar contacto…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="Buscar contactos"
        />
      </div>
      <Select
        value={value.source ?? ''}
        onValueChange={(v) => set({ source: v === NONE_FILTER ? undefined : v })}
      >
        <SelectTrigger className={FILTER_W} aria-label="Origen">
          <SelectValue placeholder="Origen" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_FILTER}>Todos los orígenes</SelectItem>
          {(sources.data ?? []).map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(facilities.data?.length ?? 0) > 1 && (
        <Select
          value={value.facilityId ?? ''}
          onValueChange={(v) => set({ facilityId: v === NONE_FILTER ? undefined : v })}
        >
          <SelectTrigger className={FILTER_W} aria-label="Local">
            <SelectValue placeholder="Local" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_FILTER}>Todos los locales</SelectItem>
            {(facilities.data ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
            <SelectItem value="none">Sin local</SelectItem>
          </SelectContent>
        </Select>
      )}
      <Select
        value={value.assignedToUserId ?? ''}
        onValueChange={(v) => set({ assignedToUserId: v === NONE_FILTER ? undefined : v })}
      >
        <SelectTrigger className={FILTER_W} aria-label="Responsable">
          <SelectValue placeholder="Responsable" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_FILTER}>Todo el equipo</SelectItem>
          <SelectItem value="none">Sin responsable</SelectItem>
          {(users.data ?? [])
            .filter((u) => u.isActive)
            .map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.fullName}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <Select
        value={value.from ? periodKey(value.from) : ''}
        onValueChange={(v) => set(periodRange(v))}
      >
        <SelectTrigger className={FILTER_W} aria-label="Llegaron">
          <SelectValue placeholder="Fecha de llegada" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_FILTER}>Cuando sea</SelectItem>
          <SelectItem value="7">Últimos 7 días</SelectItem>
          <SelectItem value="30">Últimos 30 días</SelectItem>
          <SelectItem value="90">Últimos 90 días</SelectItem>
          <SelectItem value="365">Último año</SelectItem>
        </SelectContent>
      </Select>
      {active && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSearch('');
            onChange({});
          }}
        >
          <X className="mr-1 size-4" /> Quitar filtros
        </Button>
      )}
      <div className="ml-auto flex gap-1">
        <Button
          variant={view === 'board' ? 'secondary' : 'ghost'}
          size="icon"
          aria-label="Tablero"
          title="Tablero"
          onClick={() => onView('board')}
        >
          <LayoutGrid className="size-4" />
        </Button>
        <Button
          variant={view === 'list' ? 'secondary' : 'ghost'}
          size="icon"
          aria-label="Lista"
          title="Lista"
          onClick={() => onView('list')}
        >
          <List className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Descargar CSV"
          title="Descargar CSV"
          onClick={onExport}
        >
          <Download className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Periodo elegido a partir de la fecha «desde» guardada. */
function periodKey(from: string): string {
  for (const d of [7, 30, 90, 365]) if (isoDaysAgo(d) === from) return String(d);
  return NONE_FILTER;
}

function periodRange(v: string): { from?: string; to?: string } {
  if (v === NONE_FILTER) return { from: undefined, to: undefined };
  return { from: isoDaysAgo(Number(v)), to: undefined };
}

async function exportCsv(filters: LeadBoardFilters) {
  try {
    const qs = new URLSearchParams(leadFilterQuery(filters)).toString();
    const rows = await apiFetch<LeadDto[]>(`/leads${qs ? `?${qs}` : ''}`);
    downloadCsv(`contactos-${new Date().toISOString().slice(0, 10)}.csv`, [
      [
        'Nombre',
        'Email',
        'Teléfono',
        'Fase',
        'Origen',
        'Local',
        'Tamaño',
        'Responsable',
        'Presupuesto/mes',
        'Llegó',
        'Motivo de pérdida',
      ],
      ...rows.map((l) => [
        l.displayName,
        l.email ?? '',
        l.phone ?? '',
        LEAD_STATUS_LABELS[l.status],
        leadSourceLabel(l.source),
        l.preferredFacilityName ?? '',
        l.preferredUnitTypeName ?? '',
        l.assignedToName ?? '',
        l.budgetMonthly ?? '',
        new Date(l.createdAt).toLocaleDateString('es-ES'),
        l.lostReasonCode ? LEAD_LOST_REASON_LABELS[l.lostReasonCode] : '',
      ]),
    ]);
  } catch {
    toast.error('No se ha podido descargar');
  }
}

/** Vista de lista: todas las fases juntas, por fecha de última actividad. */
function LeadsList({
  filters,
  onEdit,
}: {
  filters: LeadBoardFilters;
  onEdit: (lead: LeadDto) => void;
}) {
  const leads = usePagedList<LeadDto>('leads', '/leads', leadFilterQuery(filters));
  return (
    <Card>
      <CardContent className="p-0">
        {leads.isLoading ? (
          <div className="p-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : leads.rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No hay contactos con estos filtros.
          </p>
        ) : (
          <ul className="divide-y">
            {leads.rows.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => onEdit(l)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{l.displayName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[l.email, l.phone].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </span>
                  <Badge variant="secondary">{LEAD_STATUS_LABELS[l.status]}</Badge>
                  <span className="w-28 truncate text-xs text-muted-foreground">
                    {leadSourceLabel(l.source)}
                  </span>
                  <span className="w-32 truncate text-xs text-muted-foreground">
                    {l.assignedToName ?? 'Sin responsable'}
                  </span>
                  <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">
                    {new Date(l.createdAt).toLocaleDateString('es-ES', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {leads.loadMore.hasMore && (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={leads.loadMore.loading}
              onClick={leads.loadMore.onLoadMore}
            >
              {leads.loadMore.loading ? 'Cargando…' : 'Cargar más'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Columna del pipeline: carga sus contactos por páginas (los ganados y perdidos
 * se acumulan sin límite con el tiempo).
 */
function LeadsColumn({
  status,
  label,
  filters,
  summary,
  canWrite,
  onDrop,
  onDragStart,
  onEdit,
  onConvert,
}: {
  status: LeadStatusValue;
  label: string;
  filters: LeadBoardFilters;
  summary: { count: number; value: number } | null;
  canWrite: boolean;
  onDrop: () => void;
  onDragStart: (lead: LeadDto) => void;
  onEdit: (lead: LeadDto) => void;
  onConvert: (lead: LeadDto) => void;
}) {
  const leads = usePagedList<LeadDto>('leads', '/leads', {
    status,
    ...leadFilterQuery(filters),
  });
  // Los abiertos, de más a menos probables de alquilar.
  const items =
    status === 'won' || status === 'lost'
      ? leads.rows
      : [...leads.rows].sort((a, b) => b.score - a.score);
  return (
    <Card
      className="min-h-[320px]"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-normal text-muted-foreground">
          <span>{label}</span>
          <Badge variant="secondary">
            {summary ? summary.count : `${items.length}${leads.loadMore.hasMore ? '+' : ''}`}
          </Badge>
        </CardTitle>
        {summary && summary.value > 0 && status !== 'lost' && (
          <p
            className="text-xs text-muted-foreground"
            title="Lo que sumarían al mes (su presupuesto o el precio del tamaño que buscan)"
          >
            ≈{' '}
            {summary.value.toLocaleString('es-ES', {
              style: 'currency',
              currency: 'EUR',
              maximumFractionDigits: 0,
            })}
            /mes
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {leads.isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {items.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                canWrite={canWrite}
                onDragStart={() => onDragStart(lead)}
                onEdit={() => onEdit(lead)}
                onConvert={() => onConvert(lead)}
              />
            ))}
            {items.length === 0 && <p className="text-xs text-muted-foreground">— Sin leads —</p>}
            {leads.loadMore.hasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={leads.loadMore.loading}
                onClick={leads.loadMore.onLoadMore}
              >
                {leads.loadMore.loading ? 'Cargando…' : 'Cargar más'}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LeadCard({
  lead,
  canWrite,
  onDragStart,
  onEdit,
  onConvert,
}: {
  lead: LeadDto;
  canWrite: boolean;
  onDragStart: () => void;
  onEdit: () => void;
  onConvert: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="rounded-md border bg-card p-3 text-sm shadow-sm hover:shadow-md md:cursor-grab"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{lead.displayName}</span>
        {lead.status !== 'won' && lead.status !== 'lost' && (
          <span
            title={
              lead.scoreReasons.length
                ? `Probabilidad de alquilar: ${lead.scoreReasons.join(' · ')}`
                : 'Probabilidad de alquilar'
            }
            className={`inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-semibold ${
              lead.score >= 60
                ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
                : lead.score >= 35
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            <Gauge className="h-3 w-3" aria-hidden /> {lead.score}
          </span>
        )}
      </div>
      {lead.returnedAt && lead.status !== 'won' && lead.status !== 'lost' && (
        <div className="mt-1 inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
          <MessageSquareReply className="h-3 w-3" aria-hidden /> Ha vuelto a escribir
        </div>
      )}
      {lead.bookedAt && lead.status !== 'won' && lead.convertedCustomerId && (
        <div className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
          Reserva online sin terminar
        </div>
      )}
      {lead.email && <div className="truncate text-xs text-muted-foreground">{lead.email}</div>}
      {/* Contacto + origen en una sola línea para ocupar menos. El local asignado
          no se muestra aquí (se ve/edita en «Editar»). */}
      {(lead.phone || lead.source) && (
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {lead.phone && <span>{lead.phone}</span>}
          {lead.source && (
            <span className="text-[10px] uppercase tracking-wide">
              {leadSourceLabel(lead.source)}
            </span>
          )}
        </div>
      )}
      {lead.assignedToName && (
        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <User className="h-3 w-3" aria-hidden /> {lead.assignedToName}
        </div>
      )}
      {lead.budgetMonthly !== null && (
        <div className="mt-1 text-xs">
          {lead.budgetMonthly.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
          /mes
        </div>
      )}
      {lead.status === 'lost' && lead.lostReasonCode && (
        <div className="mt-1 text-xs text-muted-foreground">
          Motivo: {LEAD_LOST_REASON_LABELS[lead.lostReasonCode]}
        </div>
      )}
      {lead.convertedCustomerId && lead.status === 'won' && (
        <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-green-600 dark:text-green-400">
          Convertido en cliente
        </div>
      )}
      {/* La fase se cambia arrastrando (escritorio) o desde «Editar» (también en
          móvil), así que no hace falta el desplegable en la tarjeta. */}
      {/* En columnas estrechas los botones bajan de línea en vez de salirse. */}
      {canWrite && (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 min-w-[5.5rem] flex-1 px-2 text-xs"
            onClick={onEdit}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" /> Editar
          </Button>
          {!lead.convertedCustomerId && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 min-w-[5.5rem] flex-1 px-2 text-xs"
              onClick={onConvert}
            >
              <UserPlus className="mr-1 h-3.5 w-3.5" /> A cliente
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Alta manual de lead (Idealista, llamada, visita…) — origen propio al vuelo
// ============================================================================

const CUSTOM_SOURCE = '__custom__';

const NONE = '__none__';

function LeadFormDialog({ lead, onClose }: { lead?: LeadDto; onClose: () => void }) {
  const isEdit = Boolean(lead);
  const ask = useConfirm();
  const canManage = useHasPermission('leads:manage');
  const canSeeUsers = useHasPermission('users:read');
  const users = useUsers();
  const remove = useDeleteLead();
  const create = useCreateLead();
  const update = useUpdateLead(lead?.id ?? '');
  const transition = useTransitionLead();
  const setMarketing = useSetLeadMarketing();
  const sources = useLeadSources();
  const facilities = useFacilities();

  const [status, setStatus] = useState<LeadStatusValue>(lead?.status ?? 'new');
  const [source, setSource] = useState(lead?.source ?? 'portal_inmobiliario');
  const [customSource, setCustomSource] = useState('');
  const [firstName, setFirstName] = useState(lead?.firstName ?? '');
  const [lastName, setLastName] = useState(lead?.lastName ?? '');
  const [companyName, setCompanyName] = useState(lead?.companyName ?? '');
  const [email, setEmail] = useState(lead?.email ?? '');
  const [phone, setPhone] = useState(lead?.phone ?? '');
  const [message, setMessage] = useState(lead?.message ?? '');
  const [facilityId, setFacilityId] = useState<string>(lead?.preferredFacilityId ?? NONE);
  const [unitTypeId, setUnitTypeId] = useState<string>(lead?.preferredUnitTypeId ?? NONE);
  const [assignedTo, setAssignedTo] = useState<string>(lead?.assignedToUserId ?? NONE);
  const [lostReasonCode, setLostReasonCode] = useState<LeadLostReason | ''>(
    lead?.lostReasonCode ?? '',
  );
  const [lostReason, setLostReason] = useState(lead?.lostReason ?? '');
  const unitTypes = useUnitTypes();
  const [budget, setBudget] = useState(
    lead?.budgetMonthly != null ? String(lead.budgetMonthly) : '',
  );
  // Recibe comunicaciones comerciales: consentimiento dado y sin baja posterior.
  const initialMarketing = Boolean(lead?.marketingConsentAt && !lead.marketingOptOutAt);
  const [marketing, setMarketingConsent] = useState(initialMarketing);

  const resolvedSource = source === CUSTOM_SOURCE ? customSource.trim() : source;
  const hasName = Boolean(firstName.trim() || lastName.trim() || companyName.trim());
  const pending =
    create.isPending || update.isPending || transition.isPending || setMarketing.isPending;
  const needsLostReason = isEdit && status === 'lost' && lead?.status !== 'lost';
  const canSubmit =
    Boolean(resolvedSource) && hasName && !pending && (!needsLostReason || !!lostReasonCode);

  async function submit() {
    if (!canSubmit) return;
    const pick = (v: string) => (v === NONE ? null : v);
    const budgetValue = budget && Number(budget) > 0 ? Number(budget) : null;
    try {
      if (isEdit && lead) {
        // Al editar se envía todo: lo que se ha vaciado se borra.
        await update.mutateAsync({
          source: resolvedSource,
          firstName: firstName.trim() || null,
          lastName: lastName.trim() || null,
          companyName: companyName.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          message: message.trim() || null,
          preferredFacilityId: pick(facilityId),
          preferredUnitTypeId: pick(unitTypeId),
          budgetMonthly: budgetValue,
          ...(canSeeUsers ? { assignedToUserId: pick(assignedTo) } : {}),
        });
        // La fase se cambia por su propio endpoint (transition), no por el update.
        if (status !== lead.status) {
          await transition.mutateAsync({
            id: lead.id,
            input: {
              status,
              ...(status === 'lost' && lostReasonCode ? { lostReasonCode } : {}),
              ...(status === 'lost' && lostReason.trim() ? { reason: lostReason.trim() } : {}),
            },
          });
        }
        if (marketing !== initialMarketing) {
          await setMarketing.mutateAsync({ id: lead.id, consent: marketing });
        }
        toast.success('Lead actualizado.');
      } else {
        await create.mutateAsync({
          source: resolvedSource,
          metadata: {},
          marketingConsent: marketing,
          ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
          ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
          ...(companyName.trim() ? { companyName: companyName.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
          ...(pick(facilityId) ? { preferredFacilityId: facilityId } : {}),
          ...(pick(unitTypeId) ? { preferredUnitTypeId: unitTypeId } : {}),
          ...(budgetValue ? { budgetMonthly: budgetValue } : {}),
          ...(canSeeUsers && pick(assignedTo) ? { assignedToUserId: assignedTo } : {}),
        });
        toast.success('Lead creado. Está en «Nuevos» para hacerle seguimiento.');
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar el lead');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar lead' : 'Nuevo lead'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Origen</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger>
                <SelectValue placeholder="¿De dónde viene?" />
              </SelectTrigger>
              <SelectContent>
                {(sources.data ?? []).map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_SOURCE}>➕ Añadir origen…</SelectItem>
              </SelectContent>
            </Select>
            {source === CUSTOM_SOURCE && (
              <Input
                autoFocus
                value={customSource}
                onChange={(e) => setCustomSource(e.target.value)}
                placeholder="Nombre del origen (p. ej. Habitaclia)"
                className="text-base sm:text-sm"
              />
            )}
          </div>

          {isEdit && (
            <div className="space-y-1.5">
              <Label>Fase</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as LeadStatusValue)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Solo la fase actual y las que se pueden elegir a mano. */}
                  {COLUMNS.filter(
                    (c) =>
                      c.status === lead?.status ||
                      (lead && LEAD_TRANSITIONS[lead.status].includes(c.status)),
                  ).map((c) => (
                    <SelectItem key={c.status} value={c.status}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {needsLostReason && (
            <LostReasonFields
              code={lostReasonCode}
              detail={lostReason}
              onCode={setLostReasonCode}
              onDetail={setLostReason}
            />
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="lead-first-name">Nombre</Label>
              <Input
                id="lead-first-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-last-name">Apellidos</Label>
              <Input
                id="lead-last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-company">Empresa (opcional)</Label>
            <Input
              id="lead-company"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="lead-email">Email</Label>
              <Input
                id="lead-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="text-base sm:text-sm"
              />
              <EmailTypoHint value={email} onAccept={setEmail} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-phone">Teléfono</Label>
              <Input
                id="lead-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Local de interés (opcional)</Label>
              <Select value={facilityId} onValueChange={setFacilityId}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin local</SelectItem>
                  {(facilities.data ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tamaño que busca (opcional)</Label>
              <Select value={unitTypeId} onValueChange={setUnitTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin tamaño</SelectItem>
                  {(unitTypes.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-budget">Presupuesto €/mes (opcional)</Label>
              <Input
                id="lead-budget"
                type="number"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            {canSeeUsers && (
              <div className="space-y-1.5">
                <Label>Responsable</Label>
                <Select value={assignedTo} onValueChange={setAssignedTo}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Sin responsable</SelectItem>
                    {(users.data ?? [])
                      .filter((u) => u.isActive || u.id === lead?.assignedToUserId)
                      .map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.fullName}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lead-message">Notas / lo que busca</Label>
            <Textarea
              id="lead-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="Ej.: busca un trastero de ~5 m² para agosto"
            />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="lead-marketing"
              checked={marketing}
              onCheckedChange={(v) => setMarketingConsent(v === true)}
              className="mt-0.5"
            />
            <Label htmlFor="lead-marketing" className="text-sm font-normal leading-snug">
              Ha aceptado recibir ofertas y novedades
              <span className="block text-xs text-muted-foreground">
                Sin esto no recibirá campañas: aún no es cliente y la ley exige su permiso.
              </span>
            </Label>
          </div>
          {!hasName && (
            <p className="text-xs text-muted-foreground">
              Indica al menos un nombre, apellidos o empresa.
            </p>
          )}
        </div>
        {isEdit && lead && <LeadNextStep lead={lead} onDone={onClose} />}
        {isEdit && lead && <LeadQuote lead={lead} />}
        {isEdit && lead && <LeadVisits lead={lead} />}
        {isEdit && lead && <LeadActivity lead={lead} />}
        {isEdit && lead && <LeadConversation lead={lead} />}
        {isEdit && lead && <LeadTimeline lead={lead} />}
        <DialogFooter className="gap-2">
          {isEdit && lead && canManage && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive sm:mr-auto"
              disabled={remove.isPending}
              onClick={async () => {
                if (
                  !(await ask({
                    title: `¿Borrar a «${lead.displayName}»?`,
                    description:
                      'Se borran sus datos: nombre, email, teléfono, mensajes, notas, seguimientos y conversaciones. No se puede deshacer.',
                    confirmLabel: 'Borrar',
                    destructive: true,
                  }))
                ) {
                  return;
                }
                try {
                  await remove.mutateAsync(lead.id);
                  toast.success('Contacto borrado.');
                  onClose();
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.body.message : 'No se pudo borrar');
                }
              }}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Borrar
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            {pending ? 'Guardando…' : isEdit ? 'Guardar' : 'Crear lead'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LostReasonFields({
  code,
  detail,
  onCode,
  onDetail,
}: {
  code: LeadLostReason | '';
  detail: string;
  onCode: (c: LeadLostReason) => void;
  onDetail: (d: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="space-y-1.5">
        <Label>¿Por qué se ha perdido?</Label>
        <Select value={code} onValueChange={(v) => onCode(v as LeadLostReason)}>
          <SelectTrigger>
            <SelectValue placeholder="Elige el motivo" />
          </SelectTrigger>
          <SelectContent>
            {LeadLostReasonEnum.options.map((r) => (
              <SelectItem key={r} value={r}>
                {LEAD_LOST_REASON_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Si muchos se pierden porque les parece caro, la sugerencia de precio de ese tamaño lo
          tiene en cuenta.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label>Detalle (opcional)</Label>
        <Input
          value={detail}
          onChange={(e) => onDetail(e.target.value)}
          className="text-base sm:text-sm"
        />
      </div>
    </div>
  );
}

/** Motivo al arrastrar un contacto a «Perdidos». */
function LostReasonDialog({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const transition = useTransitionLead();
  const [code, setCode] = useState<LeadLostReason | ''>('');
  const [detail, setDetail] = useState('');

  async function confirmLost() {
    if (!code) return;
    try {
      await transition.mutateAsync({
        id: leadId,
        input: {
          status: 'lost',
          lostReasonCode: code,
          ...(detail.trim() ? { reason: detail.trim() } : {}),
        },
      });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo mover el lead');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Marcar como perdido</DialogTitle>
        </DialogHeader>
        <LostReasonFields code={code} detail={detail} onCode={setCode} onDetail={setDetail} />
        <DialogFooter>
          <Button onClick={() => void confirmLost()} disabled={!code || transition.isPending}>
            Marcar como perdido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
