'use client';

import { ArrowDown, ArrowUp, Columns3, Download, Loader2, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { TenantsBulkBar } from './tenants-bulk-bar';

import type { AdminTenantOverviewDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminTenantsOverview } from '@/lib/admin/hooks';
import { tenantStatusLabel } from '@/lib/admin/labels';
import { downloadCsv } from '@/lib/csv';

type Row = AdminTenantOverviewDto;

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  trial: 'secondary',
  active: 'default',
  suspended: 'destructive',
  cancelled: 'outline',
};

const MODE_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  sepa: 'SEPA',
  manual: 'Manual',
};

const HEALTH: Record<string, { label: string; className: string }> = {
  healthy: {
    label: 'Sana',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  warm: {
    label: 'Tibia',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  at_risk: {
    label: 'En riesgo',
    className: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  },
  dormant: {
    label: 'Dormida',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
};

/** Columnas opcionales (las fijas son tenant y estado). */
const COLUMNS = [
  { key: 'plan', label: 'Plan y cobro' },
  { key: 'monthly', label: 'Aporta/mes' },
  { key: 'addons', label: 'Extras' },
  { key: 'nextCharge', label: 'Próximo cobro / deuda' },
  { key: 'health', label: 'Salud' },
  { key: 'lastLogin', label: 'Último acceso' },
  { key: 'followup', label: 'Seguimiento' },
  { key: 'usage', label: 'Uso' },
  { key: 'owner', label: 'Propietario' },
  { key: 'created', label: 'Alta' },
] as const;
type ColumnKey = (typeof COLUMNS)[number]['key'];
const DEFAULT_COLUMNS: ColumnKey[] = [
  'plan',
  'monthly',
  'addons',
  'nextCharge',
  'health',
  'lastLogin',
  'followup',
];

type SortKey = 'name' | 'monthly' | 'nextCharge' | 'health' | 'lastLogin' | 'followup' | 'created';

interface Filters {
  search: string;
  status: string;
  plan: string;
  mode: string;
  addon: string;
  addonHas: 'has' | 'lacks';
  health: string;
  tag: string;
  overdue: boolean;
  trialSoon: boolean;
  noAddons: boolean;
}

const EMPTY: Filters = {
  search: '',
  status: 'all',
  plan: 'all',
  mode: 'all',
  addon: 'all',
  addonHas: 'has',
  health: 'all',
  tag: 'all',
  overdue: false,
  trialSoon: false,
  noAddons: false,
};

interface View {
  name: string;
  filters: Filters;
}

const PRESET_VIEWS: View[] = [
  { name: 'Con deuda', filters: { ...EMPTY, overdue: true } },
  { name: 'Pruebas que acaban esta semana', filters: { ...EMPTY, trialSoon: true } },
  { name: 'Pagan por SEPA', filters: { ...EMPTY, mode: 'sepa' } },
  { name: 'Activos sin extras', filters: { ...EMPTY, status: 'active', noAddons: true } },
  { name: 'En riesgo o dormidos', filters: { ...EMPTY, health: 'risk' } },
];

const VIEWS_KEY = 'storageos.admin.tenantViews';
const COLUMNS_KEY = 'storageos.admin.tenantColumns';
const DAY = 86_400_000;

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento: no se guarda */
  }
}

const eur = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES') : '—');
function daysAgo(iso: string | null): number | null {
  return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null;
}

function matches(t: Row, f: Filters): boolean {
  const q = f.search.trim().toLowerCase();
  if (
    q &&
    ![t.name, t.slug, t.ownerEmail ?? '', t.ownerPhone ?? '', ...t.tags].some((v) =>
      v.toLowerCase().includes(q),
    )
  ) {
    return false;
  }
  if (f.status !== 'all' && t.status !== f.status) return false;
  if (f.plan !== 'all' && t.planSlug !== f.plan) return false;
  if (f.mode !== 'all') {
    if (f.mode === 'exempt' ? !t.billingExempt : t.billingMode !== f.mode || t.billingExempt) {
      return false;
    }
  }
  if (f.addon !== 'all') {
    const has = t.addons.some((a) => a.slug === f.addon && !a.suspended);
    if (f.addonHas === 'has' ? !has : has) return false;
  }
  if (f.health !== 'all') {
    if (f.health === 'risk') {
      if (t.healthLevel !== 'at_risk' && t.healthLevel !== 'dormant') return false;
    } else if (t.healthLevel !== f.health) return false;
  }
  if (f.tag !== 'all' && !t.tags.includes(f.tag)) return false;
  if (f.overdue && !t.overdueSince) return false;
  if (f.trialSoon) {
    if (t.status !== 'trial' || !t.trialEndsAt) return false;
    const left = new Date(t.trialEndsAt).getTime() - Date.now();
    if (left > 7 * DAY) return false;
  }
  if (f.noAddons && t.addons.some((a) => !a.suspended)) return false;
  return true;
}

function sortValue(t: Row, key: SortKey): number | string {
  switch (key) {
    case 'name':
      return t.name.toLowerCase();
    case 'monthly':
      return t.monthly;
    case 'nextCharge':
      return t.overdueSince
        ? new Date(t.overdueSince).getTime() - 1e13
        : t.nextChargeAt
          ? new Date(t.nextChargeAt).getTime()
          : Number.MAX_SAFE_INTEGER;
    case 'health':
      return t.healthScore ?? 999;
    case 'lastLogin':
      return t.lastTeamLoginAt ? new Date(t.lastTeamLoginAt).getTime() : 0;
    case 'followup':
      return t.nextFollowup ? new Date(t.nextFollowup.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    case 'created':
      return new Date(t.createdAt).getTime();
  }
}

/**
 * Tenants del panel super admin: una fila por tenant con lo que aporta, sus
 * extras, el próximo cobro o la deuda, la salud, el último acceso del equipo y
 * el siguiente seguimiento. Filtros, orden y columnas en el navegador; vistas
 * guardadas en este navegador.
 */
export default function AdminTenantsPage() {
  const overview = useAdminTenantsOverview();
  const ask = useConfirm();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'created', dir: -1 });
  const [columns, setColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [views, setViews] = useState<View[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setViews(readStorage<View[]>(VIEWS_KEY, []));
    setColumns(readStorage<ColumnKey[]>(COLUMNS_KEY, DEFAULT_COLUMNS));
  }, []);

  const all = useMemo(() => overview.data ?? [], [overview.data]);
  const planOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of all) if (t.planSlug) m.set(t.planSlug, t.planName ?? t.planSlug);
    return [...m.entries()];
  }, [all]);
  const addonOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of all) for (const a of t.addons) m.set(a.slug, a.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const tagOptions = useMemo(() => [...new Set(all.flatMap((t) => t.tags))].sort(), [all]);

  const rows = useMemo(() => {
    const list = all.filter((t) => matches(t, filters));
    return list.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [all, filters, sort]);

  // Al cambiar el filtro, la selección anterior deja de tener sentido.
  useEffect(() => setSelected(new Set()), [filters]);

  if (overview.isError) return <AdminError onRetry={() => void overview.refetch()} />;

  const totals = {
    // Solo lo que se cobra de verdad: tenants activos (no pruebas ni suspendidos).
    monthly: rows.filter((t) => t.status === 'active').reduce((s, t) => s + t.monthly, 0),
    overdue: rows.filter((t) => t.overdueSince).length,
  };
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));
  const show = (k: ColumnKey) => columns.includes(k);
  const allSelected = rows.length > 0 && rows.every((t) => selected.has(t.id));
  const activeFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 },
    );
  }
  function toggleColumn(k: ColumnKey) {
    const next = show(k) ? columns.filter((c) => c !== k) : [...columns, k];
    setColumns(next);
    writeStorage(COLUMNS_KEY, next);
  }
  async function saveView() {
    const res = await ask({
      title: 'Guardar vista',
      description: 'Se guarda en este navegador con los filtros actuales.',
      input: { label: 'Nombre de la vista', placeholder: 'p. ej. Candidatos a WhatsApp' },
      confirmLabel: 'Guardar',
    });
    const name = res ? res.value : '';
    if (!name?.trim()) return;
    const next = [...views.filter((v) => v.name !== name.trim()), { name: name.trim(), filters }];
    setViews(next);
    writeStorage(VIEWS_KEY, next);
    toast.success('Vista guardada en este navegador.');
  }
  function deleteView(name: string) {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    writeStorage(VIEWS_KEY, next);
  }
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function exportCsv() {
    downloadCsv('tenants.csv', [
      [
        'Nombre',
        'Slug',
        'Estado',
        'Plan',
        'Modo de cobro',
        'Exenta',
        'Aporta/mes',
        'Extras',
        'Próximo cobro',
        'Debe desde',
        'Salud',
        'Último acceso',
        'Seguimiento',
        'Locales',
        'Trasteros',
        'Contratos activos',
        'Email propietario',
        'Teléfono propietario',
        'Alta',
        'Fin prueba',
        'Etiquetas',
      ],
      ...rows.map((t) => [
        t.name,
        t.slug,
        tenantStatusLabel(t.status),
        t.planName ?? '',
        t.billingMode ? (MODE_LABEL[t.billingMode] ?? t.billingMode) : '',
        t.billingExempt ? 'Sí' : 'No',
        t.monthly.toFixed(2).replace('.', ','),
        t.addons.map((a) => (a.suspended ? `${a.name} (suspendido)` : a.name)).join(', '),
        day(t.nextChargeAt),
        t.overdueSince ? day(t.overdueSince) : '',
        t.healthScore ?? '',
        day(t.lastTeamLoginAt),
        t.nextFollowup ? `${day(t.nextFollowup.dueDate)} ${t.nextFollowup.title}` : '',
        t.facilities,
        t.units,
        t.activeContracts,
        t.ownerEmail ?? '',
        t.ownerPhone ?? '',
        day(t.createdAt),
        day(t.trialEndsAt),
        t.tags.join(', '),
      ]),
    ]);
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} {rows.length === 1 ? 'tenant' : 'tenants'} · los activos aportan{' '}
            <span className="font-medium text-foreground">{eur(totals.monthly)}/mes</span>
            {totals.overdue > 0 && (
              <>
                {' '}
                · <span className="font-medium text-destructive">{totals.overdue} con deuda</span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Vistas
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Vistas rápidas</DropdownMenuLabel>
              {PRESET_VIEWS.map((v) => (
                <DropdownMenuItem key={v.name} onSelect={() => setFilters(v.filters)}>
                  {v.name}
                </DropdownMenuItem>
              ))}
              {views.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Mis vistas</DropdownMenuLabel>
                  {views.map((v) => (
                    <DropdownMenuItem
                      key={v.name}
                      onSelect={() => setFilters({ ...EMPTY, ...v.filters })}
                      className="justify-between"
                    >
                      <span className="truncate">{v.name}</span>
                      <button
                        type="button"
                        aria-label={`Borrar la vista ${v.name}`}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteView(v.name);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void saveView()} disabled={!activeFilters}>
                <Save className="mr-2 size-4" /> Guardar los filtros actuales
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 className="mr-1.5 size-4" /> Columnas
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {COLUMNS.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={show(c.key)}
                  onCheckedChange={() => toggleColumn(c.key)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="mr-1.5 size-4" /> CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filters.search}
          onChange={(e) => set('search', e.target.value)}
          placeholder="Buscar por nombre, slug, email, teléfono o etiqueta…"
          className="w-full sm:max-w-xs"
        />
        <FilterSelect
          value={filters.status}
          onChange={(v) => set('status', v)}
          options={[
            ['all', 'Todos los estados'],
            ['trial', 'Prueba'],
            ['active', 'Activos'],
            ['suspended', 'Suspendidos'],
            ['cancelled', 'Cancelados'],
          ]}
        />
        <FilterSelect
          value={filters.plan}
          onChange={(v) => set('plan', v)}
          options={[['all', 'Todos los planes'], ...planOptions]}
        />
        <FilterSelect
          value={filters.mode}
          onChange={(v) => set('mode', v)}
          options={[
            ['all', 'Cualquier cobro'],
            ['stripe', 'Stripe'],
            ['sepa', 'SEPA'],
            ['manual', 'Manual'],
            ['exempt', 'Exentas'],
          ]}
        />
        {addonOptions.length > 0 && (
          <div className="flex items-center gap-1">
            <FilterSelect
              value={filters.addonHas}
              onChange={(v) => set('addonHas', v as 'has' | 'lacks')}
              options={[
                ['has', 'Con el extra'],
                ['lacks', 'Sin el extra'],
              ]}
              width="w-[140px]"
            />
            <FilterSelect
              value={filters.addon}
              onChange={(v) => set('addon', v)}
              options={[['all', 'Cualquier extra'], ...addonOptions]}
            />
          </div>
        )}
        <FilterSelect
          value={filters.health}
          onChange={(v) => set('health', v)}
          options={[
            ['all', 'Cualquier salud'],
            ['healthy', 'Sanas'],
            ['warm', 'Tibias'],
            ['risk', 'En riesgo o dormidas'],
          ]}
        />
        {tagOptions.length > 0 && (
          <FilterSelect
            value={filters.tag}
            onChange={(v) => set('tag', v)}
            options={[
              ['all', 'Todas las etiquetas'],
              ...tagOptions.map((t) => [t, t] as [string, string]),
            ]}
          />
        )}
        <Toggle checked={filters.overdue} onChange={(v) => set('overdue', v)} label="Con deuda" />
        <Toggle
          checked={filters.trialSoon}
          onChange={(v) => set('trialSoon', v)}
          label="Prueba acaba ≤ 7 días"
        />
        <Toggle
          checked={filters.noAddons}
          onChange={(v) => set('noAddons', v)}
          label="Sin extras"
        />
        {activeFilters && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY)}>
            Quitar filtros
          </Button>
        )}
      </div>

      <TenantsBulkBar
        selected={[...selected]}
        trialCount={rows.filter((t) => selected.has(t.id) && t.status === 'trial').length}
        onClear={() => setSelected(new Set())}
      />

      {overview.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          No hay tenants que coincidan con el filtro.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-3 py-2">
                  <Checkbox
                    aria-label="Seleccionar todos"
                    checked={allSelected ? true : selected.size > 0 ? 'indeterminate' : false}
                    onCheckedChange={() =>
                      setSelected(allSelected ? new Set() : new Set(rows.map((t) => t.id)))
                    }
                  />
                </th>
                <SortHead label="Tenant" k="name" sort={sort} onSort={toggleSort} />
                <th className="px-3 py-2 font-medium">Estado</th>
                {show('plan') && <th className="px-3 py-2 font-medium">Plan y cobro</th>}
                {show('monthly') && (
                  <SortHead label="Aporta/mes" k="monthly" sort={sort} onSort={toggleSort} right />
                )}
                {show('addons') && <th className="px-3 py-2 font-medium">Extras</th>}
                {show('nextCharge') && (
                  <SortHead label="Próximo cobro" k="nextCharge" sort={sort} onSort={toggleSort} />
                )}
                {show('health') && (
                  <SortHead label="Salud" k="health" sort={sort} onSort={toggleSort} />
                )}
                {show('lastLogin') && (
                  <SortHead label="Último acceso" k="lastLogin" sort={sort} onSort={toggleSort} />
                )}
                {show('followup') && (
                  <SortHead label="Seguimiento" k="followup" sort={sort} onSort={toggleSort} />
                )}
                {show('usage') && <th className="px-3 py-2 font-medium">Uso</th>}
                {show('owner') && <th className="px-3 py-2 font-medium">Propietario</th>}
                {show('created') && (
                  <SortHead label="Alta" k="created" sort={sort} onSort={toggleSort} />
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <TenantRow
                  key={t.id}
                  t={t}
                  show={show}
                  selected={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TenantRow({
  t,
  show,
  selected,
  onToggle,
}: {
  t: Row;
  show: (k: ColumnKey) => boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const login = daysAgo(t.lastTeamLoginAt);
  const followDue = t.nextFollowup
    ? new Date(t.nextFollowup.dueDate).getTime() <= Date.now()
    : false;
  const trialLeft = t.trialEndsAt
    ? Math.ceil((new Date(t.trialEndsAt).getTime() - Date.now()) / DAY)
    : null;
  return (
    <tr className={`border-b last:border-0 hover:bg-muted/30 ${selected ? 'bg-primary/5' : ''}`}>
      <td className="px-3 py-2 align-top">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Seleccionar ${t.name}`}
        />
      </td>
      <td className="px-3 py-2 align-top">
        <Link href={`/admin/tenants/${t.id}`} className="font-medium hover:underline">
          {t.name}
        </Link>
        <div className="text-xs text-muted-foreground">{t.slug}</div>
        {t.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {t.tags.map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                {tag}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <Badge variant={STATUS_VARIANT[t.status] ?? 'secondary'}>
          {tenantStatusLabel(t.status)}
        </Badge>
        {t.status === 'trial' && trialLeft !== null && (
          <div
            className={`mt-1 text-xs ${trialLeft <= 3 ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {trialLeft > 0 ? `Quedan ${trialLeft} d` : 'Vencida'}
          </div>
        )}
      </td>
      {show('plan') && (
        <td className="px-3 py-2 align-top">
          <div>{t.planName ?? '—'}</div>
          <div className="text-xs text-muted-foreground">
            {t.billingExempt
              ? 'Exenta'
              : t.billingMode
                ? (MODE_LABEL[t.billingMode] ?? t.billingMode)
                : '—'}
          </div>
        </td>
      )}
      {show('monthly') && (
        <td
          className={`px-3 py-2 text-right align-top tabular-nums ${
            t.status === 'active' ? 'font-medium' : 'text-muted-foreground'
          }`}
          title={
            t.status === 'active' ? undefined : 'No cobra todavía (prueba, suspendida o cancelada)'
          }
        >
          {t.billingExempt ? '—' : eur(t.monthly)}
        </td>
      )}
      {show('addons') && (
        <td className="max-w-[220px] px-3 py-2 align-top">
          {t.addons.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {t.addons.map((a) => (
                <span
                  key={a.slug}
                  title={a.suspended ? 'Suspendido por impago' : undefined}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    a.suspended
                      ? 'bg-red-100 text-red-800 line-through dark:bg-red-950 dark:text-red-300'
                      : 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
                  }`}
                >
                  {a.name}
                </span>
              ))}
            </div>
          )}
        </td>
      )}
      {show('nextCharge') && (
        <td className="whitespace-nowrap px-3 py-2 align-top">
          {t.overdueSince ? (
            <span className="font-medium text-destructive">Debe desde {day(t.overdueSince)}</span>
          ) : (
            day(t.nextChargeAt)
          )}
        </td>
      )}
      {show('health') && (
        <td className="px-3 py-2 align-top">
          {t.healthLevel ? (
            <span
              className={`rounded px-1.5 py-0.5 text-xs ${HEALTH[t.healthLevel]?.className ?? ''}`}
            >
              {t.healthScore} · {HEALTH[t.healthLevel]?.label}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>
      )}
      {show('lastLogin') && (
        <td
          className={`whitespace-nowrap px-3 py-2 align-top text-xs ${
            login === null || login > 14 ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          {login === null ? 'Nunca' : login === 0 ? 'Hoy' : `Hace ${login} d`}
        </td>
      )}
      {show('followup') && (
        <td className="max-w-[200px] px-3 py-2 align-top text-xs">
          {t.nextFollowup ? (
            <>
              <div className={followDue ? 'font-medium text-destructive' : ''}>
                {day(t.nextFollowup.dueDate)}
              </div>
              <div className="truncate text-muted-foreground">{t.nextFollowup.title}</div>
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
      )}
      {show('usage') && (
        <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-muted-foreground">
          {t.facilities} loc. · {t.units} trast. · {t.activeContracts} contr.
        </td>
      )}
      {show('owner') && (
        <td className="px-3 py-2 align-top text-xs">
          <div className="truncate">{t.ownerEmail ?? '—'}</div>
          {t.ownerPhone && (
            <a href={`tel:${t.ownerPhone}`} className="text-muted-foreground hover:underline">
              {t.ownerPhone}
            </a>
          )}
        </td>
      )}
      {show('created') && (
        <td className="whitespace-nowrap px-3 py-2 align-top text-xs text-muted-foreground">
          {day(t.createdAt)}
        </td>
      )}
    </tr>
  );
}

function SortHead({
  label,
  k,
  sort,
  onSort,
  right,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
  right?: boolean;
}) {
  const active = sort.key === k;
  return (
    <th className={`px-3 py-2 font-medium ${right ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        {label}
        {active &&
          (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  width = 'w-[170px]',
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  width?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={`h-9 ${width}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`h-9 rounded-md border px-3 text-sm transition-colors ${
        checked
          ? 'border-primary bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-accent'
      }`}
      aria-pressed={checked}
    >
      {label}
    </button>
  );
}
