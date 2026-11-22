'use client';

import { ArrowDown, ArrowUp, Save, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type ListViewPage,
  useDeleteListView,
  useListViews,
  useSaveListView,
} from '@/lib/admin/health-insights-hooks';
import { tenantStatusLabel } from '@/lib/admin/labels';

/** Filtros comunes de Salud, Adopción y Uso (más los propios de cada página). */
export interface ListFilters {
  q: string;
  plan: string;
  status: string;
  rep: string;
  [extra: string]: string | boolean;
}

export const EMPTY_LIST_FILTERS: ListFilters = { q: '', plan: '', status: '', rep: '' };

/** Lo mínimo de cada fila para sacar las opciones de los filtros. */
export interface FilterableRow {
  name: string;
  slug: string;
  planSlug: string | null;
  planName: string | null;
  status: string;
  salesRepId: string | null;
  salesRepName: string | null;
  tags?: string[];
}

const ALL = '__all__';
const NO_REP = '__none__';

/** ¿Pasa la fila los filtros comunes? */
export function matchesListFilters(r: FilterableRow, f: ListFilters): boolean {
  const q = f.q.trim().toLowerCase();
  if (
    q &&
    !r.name.toLowerCase().includes(q) &&
    !r.slug.toLowerCase().includes(q) &&
    !(r.tags ?? []).some((t) => t.toLowerCase().includes(q))
  ) {
    return false;
  }
  if (f.plan && r.planSlug !== f.plan) return false;
  if (f.status && r.status !== f.status) return false;
  if (f.rep === NO_REP && r.salesRepId) return false;
  if (f.rep && f.rep !== NO_REP && r.salesRepId !== f.rep) return false;
  return true;
}

/**
 * Buscador, filtros por plan, estado y comercial y vistas guardadas (en el
 * servidor, por super admin). `children` añade los filtros propios de la página.
 */
export function ListControls({
  page,
  rows,
  filters,
  onChange,
  children,
}: {
  page: ListViewPage;
  rows: FilterableRow[];
  filters: ListFilters;
  onChange: (f: ListFilters) => void;
  children?: React.ReactNode;
}) {
  const ask = useConfirm();
  const views = useListViews(page);
  const save = useSaveListView(page);
  const remove = useDeleteListView(page);

  const plans = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.planSlug) m.set(r.planSlug, r.planName ?? r.planSlug);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const statuses = useMemo(() => [...new Set(rows.map((r) => r.status))].sort(), [rows]);
  const reps = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.salesRepId) m.set(r.salesRepId, r.salesRepName ?? 'Comercial');
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const set = (k: string, v: string | boolean) => onChange({ ...filters, [k]: v });
  // El orden (`sortKey`, `sortDir`) se guarda en la vista, pero no es un filtro.
  const active = Object.entries(filters).some(
    ([k, v]) => !k.startsWith('sort') && v !== '' && v !== false,
  );

  async function saveView() {
    const res = await ask({
      title: 'Guardar vista',
      description: 'Se guarda con los filtros y el orden actuales.',
      input: { label: 'Nombre de la vista', placeholder: 'p. ej. Clientes grandes en riesgo' },
      confirmLabel: 'Guardar',
    });
    const name = res ? res.value.trim() : '';
    if (!name) return;
    try {
      await save.mutateAsync({ name, filters: filters as Record<string, unknown> });
      toast.success('Vista guardada.');
    } catch {
      toast.error('No se pudo guardar la vista.');
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Input
        placeholder="Buscar por nombre, identificador o etiqueta…"
        value={filters.q}
        onChange={(e) => set('q', e.target.value)}
        className="h-9 w-full sm:w-64"
      />
      <FilterSelect
        value={filters.plan}
        onChange={(v) => set('plan', v)}
        allLabel="Todos los planes"
        options={plans}
      />
      <FilterSelect
        value={filters.status}
        onChange={(v) => set('status', v)}
        allLabel="Todos los estados"
        options={statuses.map((s) => [s, tenantStatusLabel(s)])}
      />
      {reps.length > 0 && (
        <FilterSelect
          value={filters.rep}
          onChange={(v) => set('rep', v)}
          allLabel="Todos los comerciales"
          options={[[NO_REP, 'Sin comercial'], ...reps]}
        />
      )}
      {children}
      {(views.data?.length ?? 0) > 0 && (
        <Select
          value=""
          onValueChange={(id) => {
            const v = views.data?.find((x) => x.id === id);
            if (v)
              onChange({
                ...EMPTY_LIST_FILTERS,
                ...(v.filters as Partial<ListFilters>),
              } as ListFilters);
          }}
        >
          <SelectTrigger className="h-9 w-full sm:w-[170px]">
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
      <Button variant="outline" size="sm" onClick={() => void saveView()}>
        <Save className="mr-1.5 size-4" /> Guardar vista
      </Button>
      {(views.data?.length ?? 0) > 0 && (
        <Select
          value=""
          onValueChange={(id) => {
            remove.mutate(id, { onSuccess: () => toast.success('Vista borrada.') });
          }}
        >
          <SelectTrigger className="h-9 w-auto" aria-label="Borrar una vista">
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
      {active && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({
              ...EMPTY_LIST_FILTERS,
              ...Object.fromEntries(Object.entries(filters).filter(([k]) => k.startsWith('sort'))),
            })
          }
        >
          Quitar filtros
        </Button>
      )}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  allLabel: string;
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger className="h-9 w-full sm:w-[170px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Orden por columna: `key` y sentido (1 ascendente, −1 descendente). */
export interface SortState<K extends string> {
  key: K;
  dir: 1 | -1;
}

/** Cambia el orden: misma columna → invierte; otra → descendente (o ascendente si es texto). */
export function nextSort<K extends string>(
  s: SortState<K>,
  key: K,
  textKeys: K[] = [],
): SortState<K> {
  if (s.key === key) return { key, dir: s.dir === 1 ? -1 : 1 };
  return { key, dir: textKeys.includes(key) ? 1 : -1 };
}

/** Ordena por el valor que devuelve `value` para la columna elegida. */
export function sortRows<T, K extends string>(
  rows: T[],
  sort: SortState<K>,
  value: (row: T, key: K) => number | string,
): T[] {
  return [...rows].sort((a, b) => {
    const va = value(a, sort.key);
    const vb = value(b, sort.key);
    if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * sort.dir;
    return ((va as number) - (vb as number)) * sort.dir;
  });
}

/** Botón de cabecera para ordenar por una columna. */
export function SortButton<K extends string>({
  label,
  k,
  sort,
  onSort,
}: {
  label: string;
  k: K;
  sort: SortState<K>;
  onSort: (k: K) => void;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted ${
        active ? 'font-medium text-foreground' : 'text-muted-foreground'
      }`}
      aria-pressed={active}
    >
      {label}
      {active &&
        (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
}
