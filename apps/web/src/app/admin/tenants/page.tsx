'use client';

import { Download, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { AdminTenantDto, AdminTenantsListResponseDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminApiFetch } from '@/lib/admin/api';
import { useAdminTenants, useAdminTenantTags } from '@/lib/admin/hooks';
import { tenantStatusLabel } from '@/lib/admin/labels';
import { downloadCsv } from '@/lib/csv';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  trial: 'secondary',
  active: 'default',
  suspended: 'destructive',
  cancelled: 'outline',
};

/**
 * Listado de tenants para el super admin (exportable a CSV).
 *
 * Para ahorrar el setup del DataTable (que es client-side y no acepta
 * `onRowClick` declarativo), renderizamos un grid de tarjetas
 * pinchables. Filtros: status + busqueda, ambos SERVER-SIDE (el endpoint
 * `/admin/tenants?search=&status=` filtra en BD). El término de búsqueda se
 * debounce ~300ms para no lanzar una query por tecla.
 *
 */
export default function AdminTenantsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<string | undefined>();
  const [tag, setTag] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  // Debounce del término de búsqueda antes de mandarlo al backend.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const tags = useAdminTenantTags();
  const tenants = useAdminTenants({
    ...(status ? { status } : {}),
    ...(tag ? { tag } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  });

  if (tenants.isError) {
    return <AdminError onRetry={() => void tenants.refetch()} />;
  }

  const rows = tenants.data?.pages.flatMap((p) => p.items) ?? [];

  // Exporta TODOS los tenants del filtro (no solo las páginas cargadas).
  async function exportCsv() {
    setExporting(true);
    try {
      const all: AdminTenantDto[] = [];
      let cursor: string | null = null;
      do {
        const qs = new URLSearchParams({ limit: '100' });
        if (status) qs.set('status', status);
        if (tag) qs.set('tag', tag);
        if (debouncedSearch) qs.set('search', debouncedSearch);
        if (cursor) qs.set('cursor', cursor);
        const page: AdminTenantsListResponseDto = await adminApiFetch(`/admin/tenants?${qs}`);
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      downloadCsv('tenants.csv', [
        [
          'Nombre',
          'Slug',
          'Estado',
          'Plan',
          'Estado suscripción',
          'Modo de cobro',
          'Exenta',
          'Email facturación',
          'NIF',
          'Usuarios',
          'Locales',
          'Inquilinos',
          'Contratos',
          'Alta',
          'Fin trial',
        ],
        ...all.map((t) => [
          t.name,
          t.slug,
          tenantStatusLabel(t.status),
          t.subscription?.planName ?? t.subscription?.planSlug ?? '',
          t.subscription?.status ?? '',
          t.subscription?.billingMode ?? '',
          t.billingExempt ? 'Sí' : 'No',
          t.billingEmail ?? '',
          t.taxId ?? '',
          t.userCount,
          t.facilityCount,
          t.customerCount,
          t.contractCount,
          new Date(t.createdAt).toLocaleDateString('es-ES'),
          t.trialEndsAt ? new Date(t.trialEndsAt).toLocaleDateString('es-ES') : '',
        ]),
      ]);
    } catch {
      toast.error('No se pudo exportar.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
        <p className="text-sm text-muted-foreground">
          Empresas registradas en la plataforma. Haz click en una para gestionarla.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, slug o email..."
          className="max-w-sm"
        />
        <Select
          value={status ?? 'all'}
          onValueChange={(v) => setStatus(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            <SelectItem value="trial">Trial</SelectItem>
            <SelectItem value="active">Activos</SelectItem>
            <SelectItem value="suspended">Suspendidos</SelectItem>
            <SelectItem value="cancelled">Cancelados</SelectItem>
          </SelectContent>
        </Select>
        {(tags.data?.length ?? 0) > 0 && (
          <Select value={tag ?? 'all'} onValueChange={(v) => setTag(v === 'all' ? undefined : v)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Etiqueta" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las etiquetas</SelectItem>
              {(tags.data ?? []).map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {tenants.isFetching && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {rows.length} {rows.length === 1 ? 'tenant' : 'tenants'}
        </span>
        <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
          <Download className="mr-1.5 size-4" /> {exporting ? 'Exportando…' : 'Exportar CSV'}
        </Button>
      </div>

      {tenants.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          No hay tenants que coincidan con el filtro.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {rows.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => router.push(`/admin/tenants/${t.id}`)}
              className="rounded-md border bg-card p-3 text-left text-sm shadow-sm transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{t.name}</span>
                <Badge variant={STATUS_VARIANT[t.status] ?? 'secondary'}>
                  {tenantStatusLabel(t.status)}
                </Badge>
              </div>
              <div className="truncate text-xs text-muted-foreground">{t.slug}</div>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-muted-foreground">
                <span>Usuarios: {t.userCount}</span>
                <span>Inquilinos: {t.customerCount}</span>
                <span>Contratos: {t.contractCount}</span>
                <span>Plan: {t.subscription?.planName ?? t.subscription?.planSlug ?? '—'}</span>
              </div>
              {t.trialEndsAt && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Fin trial: {new Date(t.trialEndsAt).toLocaleDateString('es-ES')}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {tenants.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void tenants.fetchNextPage()}
            disabled={tenants.isFetchingNextPage}
          >
            {tenants.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
          </Button>
        </div>
      )}
    </div>
  );
}
