'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateFacilityInput,
  CreateFacilitySchema,
  facilityCompleteness,
  type FacilityDto,
  type FacilitySummaryDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import {
  Building2,
  Download,
  LayoutGrid,
  List,
  Loader2,
  MapPin,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DeleteFacilityDialog } from './delete-facility-dialog';
import { DuplicateFacilityDialog } from './duplicate-facility-dialog';

import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { useCreateFacility, useFacilities } from '@/lib/facilities/hooks';
import { useFacilitySummary } from '@/lib/facilities/inventory-hooks';
import { formatDate, formatEur, formatNumber } from '@/lib/format';

function barColor(pct: number): string {
  if (pct >= 85) return '#16a34a';
  if (pct >= 60) return '#2563eb';
  if (pct >= 35) return '#eab308';
  return '#ef4444';
}

type StatusFilter = 'all' | 'active' | 'opening' | 'inactive';
type View = 'cards' | 'table';

const VIEW_KEY = 'storageos.facilities.view';

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: 'Todos',
  active: 'Abiertos',
  opening: 'Por abrir',
  inactive: 'Inactivos',
};

function matchesStatus(f: FacilityDto, status: StatusFilter): boolean {
  if (status === 'inactive') return !f.isActive;
  if (status === 'opening') return f.isActive && f.preOpening;
  if (status === 'active') return f.isActive && !f.preOpening;
  return true;
}

/** Una fila de la comparación. */
interface CompareRow {
  facility: FacilityDto;
  total: number;
  occupied: number;
  pct: number;
  summary: FacilitySummaryDto | null;
}

const money = (value: number | null | undefined) => (value == null ? '—' : formatEur(value));

function compareColumns(showMoney: boolean): ColumnDef<CompareRow>[] {
  return [
    {
      id: 'name',
      header: 'Local',
      accessorFn: (r) => r.facility.name,
      cell: ({ row }) => (
        <span className="min-w-0">
          <span className="block font-medium">{row.original.facility.name}</span>
          {row.original.facility.city && (
            <span className="text-xs text-muted-foreground">{row.original.facility.city}</span>
          )}
        </span>
      ),
    },
    { id: 'total', header: 'Trasteros', accessorFn: (r) => r.total },
    {
      id: 'pct',
      header: 'Ocupación',
      accessorFn: (r) => r.pct,
      cell: ({ row }) => `${row.original.pct}%`,
    },
    ...(showMoney
      ? ([
          {
            id: 'mrr',
            header: 'Cuotas al mes',
            accessorFn: (r) => r.summary?.mrr ?? 0,
            cell: ({ row }) => money(row.original.summary?.mrr),
          },
          {
            id: 'avgPrice',
            header: 'Cuota media',
            accessorFn: (r) => r.summary?.avgPrice ?? 0,
            cell: ({ row }) => money(row.original.summary?.avgPrice),
          },
          {
            id: 'invoiced',
            header: 'Facturado este mes',
            accessorFn: (r) => r.summary?.invoicedMonth ?? 0,
            cell: ({ row }) => money(row.original.summary?.invoicedMonth),
          },
          {
            id: 'overdue',
            header: 'Vencido',
            accessorFn: (r) => r.summary?.overdue ?? 0,
            cell: ({ row }) => money(row.original.summary?.overdue),
          },
        ] satisfies ColumnDef<CompareRow>[])
      : []),
    { id: 'moveIns', header: 'Altas del mes', accessorFn: (r) => r.summary?.moveIns ?? 0 },
    { id: 'moveOuts', header: 'Bajas del mes', accessorFn: (r) => r.summary?.moveOuts ?? 0 },
    {
      id: 'vacant',
      header: 'Más tiempo libre',
      accessorFn: (r) => r.summary?.longestVacantDays ?? 0,
      cell: ({ row }) => {
        const days = row.original.summary?.longestVacantDays;
        return days == null ? '—' : `${days} días`;
      },
    },
  ];
}

export default function FacilitiesPage() {
  const facilities = useFacilities();
  const summaries = useFacilitySummary();
  const summaryOf = useMemo(
    () => new Map((summaries.data ?? []).map((x) => [x.facilityId, x])),
    [summaries.data],
  );
  const hasOwners = useHasFeature('multi_owner');
  const canManage = useHasPermission('facilities:manage');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [view, setView] = useState<View>('cards');
  const [deleting, setDeleting] = useState<FacilityDto | null>(null);
  const [duplicating, setDuplicating] = useState<FacilityDto | null>(null);
  const router = useRouter();
  const create = useCreateFacility();

  const form = useForm<CreateFacilityInput>({
    resolver: zodResolver(CreateFacilitySchema),
    defaultValues: { name: '', city: '', country: 'ES', timezone: 'Europe/Madrid' },
  });

  const all = useMemo(() => facilities.data ?? [], [facilities.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter(
      (f) =>
        matchesStatus(f, status) &&
        (!q || f.name.toLowerCase().includes(q) || (f.city ?? '').toLowerCase().includes(q)),
    );
  }, [all, search, status]);

  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === 'table') setView('table');
    } catch {
      // Sin almacenamiento se queda en tarjetas.
    }
  }, []);

  function changeView(next: View) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Sin almacenamiento solo se pierde para la próxima visita.
    }
  }

  const rows = useMemo<CompareRow[]>(
    () =>
      filtered.map((f) => {
        const summary = summaryOf.get(f.id) ?? null;
        const total = summary?.totalUnits ?? f.unitsTotal;
        const occupied = summary?.occupiedUnits ?? f.unitsOccupied;
        return {
          facility: f,
          total,
          occupied,
          pct: total > 0 ? Math.round((occupied / total) * 100) : 0,
          summary,
        };
      }),
    [filtered, summaryOf],
  );
  // El API manda null sin permiso para ver el dinero.
  const showMoney = (summaries.data ?? []).some((x) => x.mrr !== null);
  const columns = useMemo(() => compareColumns(showMoney), [showMoney]);

  function exportCsv() {
    const moneyHeader = showMoney
      ? ['Cuotas al mes', 'Cuota media', 'Facturado este mes', 'Vencido']
      : [];
    downloadCsv('locales.csv', [
      [
        'Local',
        'Ciudad',
        'Trasteros',
        'Ocupados',
        'Ocupación %',
        ...moneyHeader,
        'Altas del mes',
        'Bajas del mes',
        'Más tiempo libre (días)',
      ],
      ...rows.map((r) => [
        r.facility.name,
        r.facility.city ?? '',
        r.total,
        r.occupied,
        r.pct,
        ...(showMoney
          ? [
              r.summary?.mrr ?? 0,
              r.summary?.avgPrice ?? 0,
              r.summary?.invoicedMonth ?? 0,
              r.summary?.overdue ?? 0,
            ]
          : []),
        r.summary?.moveIns ?? 0,
        r.summary?.moveOuts ?? 0,
        r.summary?.longestVacantDays ?? '',
      ]),
    ]);
  }

  const totals = useMemo(() => {
    const units = all.reduce((s, f) => s + (summaryOf.get(f.id)?.totalUnits ?? f.unitsTotal), 0);
    const occupied = all.reduce(
      (s, f) => s + (summaryOf.get(f.id)?.occupiedUnits ?? f.unitsOccupied),
      0,
    );
    return {
      facilities: all.length,
      units,
      occupied,
      pct: units > 0 ? Math.round((occupied / units) * 100) : 0,
    };
  }, [all, summaryOf]);

  async function onSubmit(values: CreateFacilityInput) {
    try {
      const created = await create.mutateAsync(values);
      toast.success('Local creado. Completa su horario y sus datos en la ficha.');
      form.reset();
      setOpen(false);
      router.push(`/facilities/${created.id}?tab=settings`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear.');
    }
  }

  return (
    <div className="space-y-5 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Locales</h1>
          <p className="text-sm text-muted-foreground">
            Cada local tiene sus plantas y sus trasteros.
          </p>
        </div>
        {canManage && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-1 h-4 w-4" /> Nuevo local
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Nuevo local</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nombre</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="city"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ciudad</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="address"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Dirección</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="contactPhone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Teléfono de contacto</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                      Cancelar
                    </Button>
                    <Button type="submit" disabled={form.formState.isSubmitting}>
                      {form.formState.isSubmitting ? 'Creando...' : 'Crear'}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {all.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile label="Locales" value={String(totals.facilities)} />
          <SummaryTile label="Trasteros" value={String(totals.units)} />
          <SummaryTile label="Ocupados" value={String(totals.occupied)} />
          <SummaryTile label="Ocupación media" value={`${totals.pct}%`} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Buscar local por nombre o ciudad…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-36" aria-label="Estado del local">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((key) => (
              <SelectItem key={key} value={key}>
                {STATUS_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex rounded-md border p-0.5">
          <Button
            variant={view === 'cards' ? 'secondary' : 'ghost'}
            size="icon"
            className="size-8"
            aria-label="Ver en tarjetas"
            aria-pressed={view === 'cards'}
            onClick={() => changeView('cards')}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={view === 'table' ? 'secondary' : 'ghost'}
            size="icon"
            className="size-8"
            aria-label="Comparar en tabla"
            aria-pressed={view === 'table'}
            onClick={() => changeView('table')}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="sm:ml-auto"
        >
          <Download className="mr-1 h-4 w-4" /> CSV
        </Button>
        {canManage && (
          <Button variant="ghost" size="sm" asChild>
            <Link href="/facilities/deleted">
              <Trash2 className="mr-1 h-4 w-4" /> Borrados
            </Link>
          </Button>
        )}
      </div>

      {facilities.isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : facilities.isError ? (
        <SectionError onRetry={() => void facilities.refetch()} />
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {all.length === 0
              ? 'Aún no has creado ningún local. Crea el primero para empezar a añadir trasteros.'
              : 'Ningún local coincide con la búsqueda.'}
          </CardContent>
        </Card>
      ) : view === 'table' ? (
        <DataTable
          columns={columns}
          data={rows}
          rowHref={(r) => `/facilities/${r.facility.id}`}
          pageSize={50}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((f) => (
            <FacilityCard
              key={f.id}
              facility={f}
              summary={summaryOf.get(f.id) ?? null}
              showOwner={hasOwners}
              canManage={canManage}
              onDelete={() => setDeleting(f)}
              onDuplicate={() => setDuplicating(f)}
            />
          ))}
        </div>
      )}
      <DeleteFacilityDialog facility={deleting} onClose={() => setDeleting(null)} />
      <DuplicateFacilityDialog facility={duplicating} onClose={() => setDuplicating(null)} />
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function FacilityCard({
  facility: f,
  summary,
  showOwner,
  canManage,
  onDelete,
  onDuplicate,
}: {
  facility: FacilityDto;
  summary: FacilitySummaryDto | null;
  showOwner: boolean;
  canManage: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const completeness = facilityCompleteness(f);
  const cover = f.images[0]?.url ?? null;
  const total = summary?.totalUnits ?? f.unitsTotal;
  const occupied = summary?.occupiedUnits ?? f.unitsOccupied;
  const pct = total > 0 ? Math.round((occupied / total) * 100) : 0;

  return (
    <Card className="group overflow-hidden transition-shadow hover:shadow-soft">
      <Link href={`/facilities/${f.id}`} className="block">
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt={f.name}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/10 to-primary/5">
              <Building2 className="size-10 text-primary/40" />
            </div>
          )}
          <div className="absolute left-2 top-2 flex flex-wrap gap-1">
            {!f.isActive && <Badge variant="secondary">Inactivo</Badge>}
            {f.preOpening && (
              <Badge variant="secondary">
                {f.openingDate ? `Abre el ${formatDate(f.openingDate)}` : 'Próxima apertura'}
              </Badge>
            )}
            {showOwner && !f.ownerId && <Badge variant="secondary">Sin propietario</Badge>}
          </div>
        </div>
      </Link>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`/facilities/${f.id}`}
              className="block truncate font-medium hover:underline"
            >
              {f.name}
            </Link>
            {f.city && (
              <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                <MapPin className="size-3 shrink-0" /> {f.city}
              </p>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="-mr-2 -mt-1 size-8 shrink-0"
                aria-label="Acciones"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/facilities/${f.id}`}>Abrir</Link>
              </DropdownMenuItem>
              {canManage && <DropdownMenuItem onClick={onDuplicate}>Duplicar</DropdownMenuItem>}
              {canManage && (
                <DropdownMenuItem className="text-destructive" onClick={onDelete}>
                  Borrar
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {total > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Ocupación</span>
              <span className="font-medium tabular-nums">
                {pct}% · {occupied}/{total}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: barColor(pct) }}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Sin trasteros todavía</p>
        )}
        {summary && total > 0 && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {summary.mrr !== null && (
              <>
                <dt className="text-muted-foreground">Cuotas al mes</dt>
                <dd className="text-right font-medium tabular-nums">{formatEur(summary.mrr)}</dd>
                <dt className="text-muted-foreground">Cuota media</dt>
                <dd className="text-right tabular-nums">
                  {summary.avgPrice === null ? '—' : formatEur(summary.avgPrice)}
                </dd>
                <dt className="text-muted-foreground">Facturado este mes</dt>
                <dd className="text-right tabular-nums">{formatEur(summary.invoicedMonth ?? 0)}</dd>
                {(summary.overdue ?? 0) > 0 && (
                  <>
                    <dt className="text-muted-foreground">Vencido</dt>
                    <dd className="text-right tabular-nums text-red-600 dark:text-red-400">
                      {formatEur(summary.overdue ?? 0)}
                    </dd>
                  </>
                )}
              </>
            )}
            <dt className="text-muted-foreground">m² alquilados</dt>
            <dd className="text-right tabular-nums">
              {formatNumber(summary.occupiedM2)} / {formatNumber(summary.totalM2)}
            </dd>
            {summary.longestVacantDays !== null && (
              <>
                <dt className="text-muted-foreground">Más tiempo libre</dt>
                <dd className="text-right tabular-nums">{summary.longestVacantDays} días</dd>
              </>
            )}
            {summary.outOfService > 0 && (
              <>
                <dt className="text-muted-foreground">Fuera de servicio</dt>
                <dd className="text-right tabular-nums">{summary.outOfService}</dd>
              </>
            )}
          </dl>
        )}
        {completeness.percent < 100 && (
          <p className="text-xs text-muted-foreground">Ficha al {completeness.percent}%</p>
        )}
      </CardContent>
    </Card>
  );
}
