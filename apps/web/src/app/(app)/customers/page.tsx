'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateCustomerInput,
  CreateCustomerSchema,
  type CustomerOverviewDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Columns3, MoreHorizontal, Plus, Save, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCreateCustomer,
  useCustomersOverview,
  useCustomerUnreadSummary,
  useDeleteCustomer,
  useSendPortalAccessEmail,
} from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

type Row = CustomerOverviewDto;

const PAY_VIA: Record<string, string> = {
  card: 'Tarjeta',
  sepa_debit: 'Adeudo',
  sepa_mandate: 'Remesa SEPA',
};

const COLUMN_LABELS = [
  ['units', 'Trastero'],
  ['monthly', 'Cuota/mes'],
  ['payVia', 'Cobro'],
  ['debt', 'Deuda'],
  ['contract', 'Contrato'],
  ['insurance', 'Seguro'],
  ['portal', 'Portal'],
  ['lastContact', 'Último contacto'],
  ['followup', 'Seguimiento'],
  ['kyc', 'KYC'],
] as const;
type ColumnKey = (typeof COLUMN_LABELS)[number][0];
const DEFAULT_COLUMNS: ColumnKey[] = [
  'units',
  'monthly',
  'payVia',
  'debt',
  'contract',
  'insurance',
  'portal',
  'followup',
];

interface Filters {
  facilityId: string;
  overdue: boolean;
  noPayVia: boolean;
  noInsurance: boolean;
  endingSoon: boolean;
  ending: boolean;
  noKyc: boolean;
  noContract: boolean;
  noPortal: boolean;
}
const EMPTY: Filters = {
  facilityId: 'all',
  overdue: false,
  noPayVia: false,
  noInsurance: false,
  endingSoon: false,
  ending: false,
  noKyc: false,
  noContract: false,
  noPortal: false,
};
const TOGGLES: { key: Exclude<keyof Filters, 'facilityId'>; label: string }[] = [
  { key: 'overdue', label: 'Con deuda' },
  { key: 'noPayVia', label: 'Sin método de pago' },
  { key: 'noInsurance', label: 'Sin seguro' },
  { key: 'endingSoon', label: 'Vence en 30 días' },
  { key: 'ending', label: 'En baja' },
  { key: 'noKyc', label: 'Sin KYC' },
  { key: 'noContract', label: 'Sin contrato' },
  { key: 'noPortal', label: 'No usa el portal' },
];
interface View {
  name: string;
  filters: Filters;
}
const PRESET_VIEWS: View[] = [
  { name: 'Morosos', filters: { ...EMPTY, overdue: true } },
  { name: 'Activos sin seguro', filters: { ...EMPTY, noInsurance: true } },
  { name: 'Sin método de pago', filters: { ...EMPTY, noPayVia: true } },
  { name: 'Contratos que vencen pronto', filters: { ...EMPTY, endingSoon: true } },
  { name: 'Ex inquilinos y contactos', filters: { ...EMPTY, noContract: true } },
  { name: 'Con deuda y sin portal', filters: { ...EMPTY, overdue: true, noPortal: true } },
];
const VIEWS_KEY = 'storageos.customers.views';
const COLUMNS_KEY = 'storageos.customers.columns';

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
    /* sin almacenamiento */
  }
}

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES') : '—');
function daysUntil(isoDate: string): number {
  return Math.ceil((new Date(isoDate).getTime() - Date.now()) / 86_400_000);
}

function matches(c: Row, f: Filters): boolean {
  const live = c.contractStatus !== 'none';
  if (f.facilityId !== 'all' && !c.facilityIds.includes(f.facilityId)) return false;
  if (f.overdue && c.overdue <= 0) return false;
  if (f.noPayVia && (c.payVia || !live)) return false;
  if (f.noInsurance && (c.contractStatus !== 'active' || c.insurance.length > 0)) return false;
  if (f.endingSoon && (!c.endsOn || daysUntil(c.endsOn) > 30)) return false;
  if (f.ending && c.contractStatus !== 'ending') return false;
  if (f.noKyc && c.kycVerified) return false;
  if (f.noContract && live) return false;
  // Inquilinos activos que nunca han entrado o no entran desde hace 90 días.
  if (f.noPortal && (!live || (c.portalLastSeenAt && -daysUntil(c.portalLastSeenAt) < 90)))
    return false;
  return true;
}

/**
 * Inquilinos: una fila por inquilino con su trastero, lo que paga, cómo, si
 * debe algo, el seguro, el contrato y el último contacto. Filtros, columnas y
 * vistas en el navegador; la búsqueda filtra todas las columnas.
 */
export default function CustomersPage() {
  const ask = useConfirm();
  const overview = useCustomersOverview();
  const facilities = useFacilities();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [columnsOn, setColumnsOn] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [views, setViews] = useState<View[]>([]);
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('f');
    if (fromUrl) {
      const keys = fromUrl
        .split(',')
        .filter((k): k is (typeof TOGGLES)[number]['key'] => TOGGLES.some((t) => t.key === k));
      if (keys.length) setFilters({ ...EMPTY, ...Object.fromEntries(keys.map((k) => [k, true])) });
    }
    setViews(readStorage<View[]>(VIEWS_KEY, []));
    setColumnsOn(readStorage<ColumnKey[]>(COLUMNS_KEY, DEFAULT_COLUMNS));
  }, []);
  const rows = useMemo(
    () => (overview.data ?? []).filter((c) => matches(c, filters)),
    [overview.data, filters],
  );
  const unreadByCustomer = useCustomerUnreadSummary().data?.byCustomer ?? {};
  const create = useCreateCustomer();
  const remove = useDeleteCustomer();
  const sendAccess = useSendPortalAccessEmail();
  const [sendingAll, setSendingAll] = useState(false);
  /** Envía por email el enlace de acceso a todos los inquilinos filtrados que tienen email. */
  async function sendAccessToAll() {
    const target = rows.filter((r) => r.email);
    const ok = await ask({
      title: `¿Enviar el acceso al portal a ${target.length} inquilinos?`,
      description:
        'Cada uno recibirá por email un enlace para entrar en su área de clientes (válido 7 días).',
      confirmLabel: 'Enviar',
    });
    if (!ok) return;
    setSendingAll(true);
    let sent = 0;
    for (const r of target) {
      try {
        await sendAccess.mutateAsync(r.id);
        sent += 1;
      } catch {
        /* sigue con los demás */
      }
    }
    setSendingAll(false);
    toast.success(`Enviado a ${sent} de ${target.length}.`);
  }
  // Marcada por defecto: al crear, el inquilino recibe por email su acceso al portal.
  const [sendAccessEmail, setSendAccessEmail] = useState(true);
  // RBAC v2 (PR1): borrar inquilinos es owner-only (`customers:delete`).
  const canDelete = useHasPermission('customers:delete');
  const canWrite = useHasPermission('customers:write');
  const canImport = useHasPermission('imports:manage');
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'individual' | 'business'>('individual');

  const form = useForm<CreateCustomerInput>({
    resolver: zodResolver(CreateCustomerSchema),
    defaultValues: {
      customerType: 'individual',
      country: 'ES',
      firstName: '',
      lastName: '',
      companyName: '',
      email: '',
      phone: '',
      documentType: 'DNI',
      documentNumber: '',
    },
  });

  async function onSubmit(values: CreateCustomerInput) {
    try {
      const created = await create.mutateAsync({ ...values, customerType: type });
      toast.success('Inquilino creado.');
      form.reset();
      setOpen(false);
      if (sendAccessEmail && created.email) {
        try {
          const res = await sendAccess.mutateAsync(created.id);
          toast.success(`Acceso al portal enviado a ${res.sentTo}.`);
        } catch (err) {
          toast.error(
            `No se pudo enviar el acceso al portal: ${err instanceof ApiError ? err.body.message : 'error'}. Puedes reenviarlo desde su ficha.`,
          );
        }
      }
      setSendAccessEmail(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function handleDelete(id: string) {
    if (
      !(await ask({
        title: '¿Borrar este inquilino? Es un soft delete: el histórico se mantiene.',
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync(id);
      toast.success('Inquilino borrado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const show = (k: ColumnKey) => columnsOn.includes(k);
  const allColumns: (ColumnDef<CustomerOverviewDto> & { key?: ColumnKey })[] = [
    {
      id: 'name',
      accessorFn: (c) => c.displayName,
      header: 'Inquilino',
      cell: ({ row }) => {
        const c = row.original;
        const unread = unreadByCustomer[c.id] ?? 0;
        return (
          <div className="min-w-0">
            <span className="flex items-center gap-2">
              <Link href={`/customers/${c.id}`} className="font-medium hover:underline">
                {c.displayName}
              </Link>
              {unread > 0 && (
                <span
                  title={`${unread} mensaje(s) sin leer`}
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1.5 text-xs font-medium text-white"
                >
                  {unread}
                </span>
              )}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {c.email ?? c.phone ?? (c.customerType === 'business' ? 'Empresa' : 'Particular')}
            </span>
          </div>
        );
      },
    },
    {
      key: 'units',
      id: 'units',
      accessorFn: (c) => c.units.map((u) => u.code).join(', '),
      header: 'Trastero',
      cell: ({ row }) =>
        row.original.units.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="text-xs">
            {row.original.units.map((u) => u.code).join(', ')}
            <span className="block text-muted-foreground">
              {[...new Set(row.original.units.map((u) => u.facilityName))].join(', ')}
            </span>
          </span>
        ),
    },
    {
      key: 'monthly',
      id: 'monthly',
      accessorFn: (c) => c.monthly,
      header: 'Cuota/mes',
      cell: ({ row }) =>
        row.original.monthly > 0 ? (
          <span className="tabular-nums">{eur(row.original.monthly)}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: 'payVia',
      id: 'payVia',
      accessorFn: (c) => c.payVia ?? '',
      header: 'Cobro',
      cell: ({ row }) => {
        const c = row.original;
        if (c.payVia) return <span className="text-xs">{PAY_VIA[c.payVia]}</span>;
        return c.contractStatus === 'none' ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="text-xs text-amber-600 dark:text-amber-400">Sin método</span>
        );
      },
    },
    {
      key: 'debt',
      id: 'debt',
      accessorFn: (c) => c.overdue,
      header: 'Deuda',
      cell: ({ row }) => {
        const c = row.original;
        if (c.overdue > 0) {
          return (
            <span className="text-xs font-medium text-destructive">
              {eur(c.overdue)}
              <span className="block font-normal">desde {day(c.overdueSince)}</span>
            </span>
          );
        }
        return c.pendingNotDue > 0 ? (
          <span className="text-xs text-muted-foreground">{eur(c.pendingNotDue)} por vencer</span>
        ) : (
          <span className="text-xs text-muted-foreground">Al día</span>
        );
      },
    },
    {
      key: 'contract',
      id: 'contract',
      accessorFn: (c) => c.endsOn ?? (c.contractStatus === 'none' ? 'zzzz' : 'zzz'),
      header: 'Contrato',
      cell: ({ row }) => {
        const c = row.original;
        if (c.contractStatus === 'none') {
          return <span className="text-xs text-muted-foreground">Sin contrato</span>;
        }
        const days = c.endsOn ? daysUntil(c.endsOn) : null;
        return (
          <span className="text-xs">
            {c.contractStatus === 'ending' ? (
              <Badge
                variant="outline"
                className="border-amber-400 text-amber-700 dark:text-amber-400"
              >
                En baja
              </Badge>
            ) : (
              'Activo'
            )}
            {c.endsOn && (
              <span
                className={`block ${days !== null && days <= 30 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
              >
                hasta {day(c.endsOn)}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'insurance',
      id: 'insurance',
      accessorFn: (c) => c.insurance.join(', '),
      header: 'Seguro',
      cell: ({ row }) =>
        row.original.insurance.length ? (
          <span className="text-xs">{row.original.insurance.join(', ')}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: 'portal',
      id: 'portal',
      accessorFn: (c) => c.portalLastSeenAt ?? '',
      header: 'Portal',
      cell: ({ row }) => {
        const seen = row.original.portalLastSeenAt;
        const days = seen ? Math.max(0, -daysUntil(seen)) : null;
        return (
          <span className="text-xs">
            {days === null ? (
              <span className="text-amber-700 dark:text-amber-400">Nunca ha entrado</span>
            ) : days === 0 ? (
              'Hoy'
            ) : (
              `Hace ${days} ${days === 1 ? 'día' : 'días'}`
            )}
            {row.original.portalAccessEnabled && (
              <span className="block text-muted-foreground">con contraseña</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'lastContact',
      id: 'lastContact',
      accessorFn: (c) => c.lastContactAt ?? '',
      header: 'Último contacto',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.lastContactAt ? day(row.original.lastContactAt) : 'Nunca'}
        </span>
      ),
    },
    {
      key: 'followup',
      id: 'followup',
      accessorFn: (c) => c.nextFollowup?.dueDate ?? 'zzzz',
      header: 'Seguimiento',
      cell: ({ row }) => {
        const f = row.original.nextFollowup;
        if (!f) return <span className="text-xs text-muted-foreground">—</span>;
        const due = daysUntil(f.dueDate) <= 0;
        return (
          <span className="text-xs">
            <span className={due ? 'font-medium text-destructive' : ''}>{day(f.dueDate)}</span>
            <span className="block max-w-[160px] truncate text-muted-foreground">{f.title}</span>
          </span>
        );
      },
    },
    {
      key: 'kyc',
      id: 'kyc',
      accessorFn: (c) => (c.kycVerified ? 1 : 0),
      header: 'KYC',
      cell: ({ row }) => (
        <Badge variant={row.original.kycVerified ? 'default' : 'outline'}>
          {row.original.kycVerified ? 'Verificado' : 'Pendiente'}
        </Badge>
      ),
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      meta: { mobileHidden: !canDelete },
      cell: ({ row }) =>
        canDelete ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Acciones">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => handleDelete(row.original.id)}
              >
                Borrar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];
  const columns = allColumns.filter((c) => !c.key || show(c.key));
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));
  const activeFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY);
  const debtTotal = rows.reduce((sum, c) => sum + c.overdue, 0);
  const monthlyTotal = rows.reduce((sum, c) => sum + c.monthly, 0);

  function toggleColumn(k: ColumnKey) {
    const next = show(k) ? columnsOn.filter((c) => c !== k) : [...columnsOn, k];
    setColumnsOn(next);
    writeStorage(COLUMNS_KEY, next);
  }
  async function saveView() {
    const res = await ask({
      title: 'Guardar vista',
      description: 'Se guarda en este navegador con los filtros actuales.',
      input: { label: 'Nombre de la vista', placeholder: 'p. ej. Morosos del local Norte' },
      confirmLabel: 'Guardar',
    });
    const name = res ? res.value.trim() : '';
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, filters }];
    setViews(next);
    writeStorage(VIEWS_KEY, next);
    toast.success('Vista guardada en este navegador.');
  }
  function deleteView(name: string) {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    writeStorage(VIEWS_KEY, next);
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Inquilinos</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'inquilino' : 'inquilinos'} · cuotas{' '}
          <span className="font-medium text-foreground">{eur(monthlyTotal)}/mes</span>
          {debtTotal > 0 && (
            <>
              {' '}
              · deben <span className="font-medium text-destructive">{eur(debtTotal)}</span>
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(facilities.data?.length ?? 0) > 1 && (
          <Select value={filters.facilityId} onValueChange={(v) => set('facilityId', v)}>
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los locales</SelectItem>
              {(facilities.data ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => set(t.key, !filters[t.key])}
            aria-pressed={filters[t.key]}
            className={`h-9 rounded-md border px-3 text-sm transition-colors ${
              filters[t.key]
                ? 'border-primary bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            {t.label}
          </button>
        ))}
        {activeFilters && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY)}>
            Quitar filtros
          </Button>
        )}
        {filters.noPortal && rows.some((r) => r.email) && (
          <Can permission="customers:write">
            <Button
              variant="outline"
              size="sm"
              disabled={sendingAll}
              onClick={() => void sendAccessToAll()}
            >
              Enviar el acceso al portal a los {rows.filter((r) => r.email).length}
            </Button>
          </Can>
        )}
      </div>

      <DataTable
        rowHref={(c) => `/customers/${c.id}`}
        columns={columns}
        data={rows}
        isLoading={overview.isLoading}
        searchPlaceholder="Buscar por nombre, email, teléfono, trastero o etiqueta…"
        pageSize={50}
        toolbarRight={
          <>
            <Button variant="outline" asChild>
              <Link href="/customers/extras">Extras</Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Vistas</Button>
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
                <Button variant="outline" aria-label="Columnas">
                  <Columns3 className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {COLUMN_LABELS.map(([k, label]) => (
                  <DropdownMenuCheckboxItem
                    key={k}
                    checked={show(k)}
                    onCheckedChange={() => toggleColumn(k)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {canImport && (
              <Button asChild variant="outline">
                <Link href="/customers/import">
                  <Upload className="mr-1 h-4 w-4" /> Importar
                </Link>
              </Button>
            )}
            <Dialog open={open && canWrite} onOpenChange={setOpen}>
              {canWrite && (
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="mr-1 h-4 w-4" /> Nuevo inquilino
                  </Button>
                </DialogTrigger>
              )}
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Nuevo inquilino</DialogTitle>
                </DialogHeader>
                <Tabs value={type} onValueChange={(v) => setType(v as 'individual' | 'business')}>
                  <TabsList className="w-full">
                    <TabsTrigger value="individual" className="flex-1">
                      Particular
                    </TabsTrigger>
                    <TabsTrigger value="business" className="flex-1">
                      Empresa
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Form {...form}>
                  <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
                    {type === 'individual' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <FormField
                          control={form.control}
                          name="firstName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Nombre</FormLabel>
                              <FormControl>
                                <Input {...field} value={field.value ?? ''} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="lastName"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Apellidos</FormLabel>
                              <FormControl>
                                <Input {...field} value={field.value ?? ''} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    ) : (
                      <FormField
                        control={form.control}
                        name="companyName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Empresa</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value ?? ''} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="documentType"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Tipo doc.</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value ?? 'DNI'}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="DNI">DNI</SelectItem>
                                <SelectItem value="NIE">NIE</SelectItem>
                                <SelectItem value="CIF">CIF</SelectItem>
                                <SelectItem value="Pasaporte">Pasaporte</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="documentNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Número</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value ?? ''} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value ?? ''} type="email" />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="phone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Teléfono</FormLabel>
                            <FormControl>
                              <Input {...field} value={field.value ?? ''} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={form.control}
                      name="referralCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Código de referido (opcional)</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="Si llega recomendado por otro inquilino"
                              {...field}
                              value={field.value ?? ''}
                              onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {form.watch('email') && (
                      <div className="flex items-start gap-2">
                        <Checkbox
                          id="send-access-email"
                          checked={sendAccessEmail}
                          onCheckedChange={(v) => setSendAccessEmail(v === true)}
                        />
                        <Label htmlFor="send-access-email" className="font-normal leading-snug">
                          Enviar al inquilino su acceso al portal por email
                        </Label>
                      </div>
                    )}
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
          </>
        }
        emptyText={
          activeFilters
            ? 'Ningún inquilino cumple estos filtros.'
            : 'No hay inquilinos todavía. Crea el primero para empezar a firmar contratos.'
        }
      />
    </div>
  );
}
