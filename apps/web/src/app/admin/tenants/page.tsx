'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminTenants } from '@/lib/admin/hooks';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  trial: 'secondary',
  active: 'default',
  suspended: 'destructive',
  cancelled: 'outline',
};

/**
 * Listado de tenants para el super admin.
 *
 * Para ahorrar el setup del DataTable (que es client-side y no acepta
 * `onRowClick` declarativo), renderizamos un grid de tarjetas
 * pinchables. Filtros: status + busqueda (client-side).
 */
export default function AdminTenantsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<string | undefined>();
  const [search, setSearch] = useState('');

  const tenants = useAdminTenants({ ...(status ? { status } : {}) });

  if (tenants.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const term = search.trim().toLowerCase();
  const filtered = (tenants.data ?? []).filter((t) => {
    if (!term) return true;
    return (
      t.name.toLowerCase().includes(term) ||
      t.slug.toLowerCase().includes(term) ||
      (t.billingEmail ?? '').toLowerCase().includes(term)
    );
  });

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
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? 'tenant' : 'tenants'}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          No hay tenants que coincidan con el filtro.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => router.push(`/admin/tenants/${t.id}`)}
              className="rounded-md border bg-card p-3 text-left text-sm shadow-sm transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{t.name}</span>
                <Badge variant={STATUS_VARIANT[t.status] ?? 'secondary'}>{t.status}</Badge>
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
    </div>
  );
}
