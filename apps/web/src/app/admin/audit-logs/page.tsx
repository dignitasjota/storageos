'use client';

import {
  SUPER_ADMIN_AUDIT_GROUPS,
  superAdminAuditLabel,
  superAdminAuditTone,
  type SuperAdminAuditLogDto,
} from '@storageos/shared';
import { Download, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminFetchAllPages, EXPORT_MAX_ROWS } from '@/lib/admin/api';
import { useAdminAuditLogs, useAdminSearch, useAdminSuperAdmins } from '@/lib/admin/hooks';
import { downloadCsv } from '@/lib/csv';
import { useDebouncedSearch } from '@/lib/pagination';

/** Una línea por dato, en vez del JSON en bruto. */
function ChangesDetail({ changes }: { changes: unknown }) {
  if (!changes || typeof changes !== 'object') return <>—</>;
  const entries = Object.entries(changes as Record<string, unknown>);
  if (entries.length === 0) return <>—</>;
  const show = (v: unknown): string =>
    Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return (
    <details>
      <summary className="cursor-pointer">
        {entries.length === 1 ? '1 dato' : `${entries.length} datos`}
      </summary>
      <dl className="mt-1 space-y-0.5">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="shrink-0 font-medium">{key}:</dt>
            <dd className="break-all">{show(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * Registro de acciones del super admin, con filtros por acción, super admin,
 * tenant y fechas. Paginación por cursor (50 por defecto).
 */
export default function AdminAuditLogsPage() {
  const [action, setAction] = useState<string | undefined>();
  const [superAdminId, setSuperAdminId] = useState<string | undefined>();
  const [tenant, setTenant] = useState<{ id: string; name: string } | null>(null);
  const [tenantInput, tenantQuery, setTenantInput] = useDebouncedSearch();
  const tenantResults = useAdminSearch(tenant ? '' : tenantQuery);
  const superAdmins = useAdminSuperAdmins();
  const [exporting, setExporting] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);

  const filters = {
    ...(action ? { action } : {}),
    ...(superAdminId ? { superAdminId } : {}),
    ...(tenant ? { targetTenantId: tenant.id } : {}),
    ...(fromDate ? { fromDate: new Date(fromDate).toISOString() } : {}),
    ...(toDate ? { toDate: new Date(toDate).toISOString() } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  };

  const logs = useAdminAuditLogs(filters);

  function resetCursor() {
    setCursor(undefined);
    setCursorStack([undefined]);
  }

  function onNextPage() {
    if (!logs.data?.nextCursor) return;
    setCursorStack((s) => [...s, logs.data!.nextCursor!]);
    setCursor(logs.data.nextCursor);
  }

  function onPrevPage() {
    setCursorStack((s) => {
      if (s.length <= 1) return s;
      const next = s.slice(0, -1);
      const top = next[next.length - 1];
      setCursor(top);
      return next;
    });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (key !== 'cursor' && key !== 'limit') params.set(key, String(value));
      }
      const { items, truncated } = await adminFetchAllPages<SuperAdminAuditLogDto>(
        '/admin/audit-logs',
        params,
      );
      writeCsv(items);
      if (truncated) toast.warning(`Exportadas solo las ${EXPORT_MAX_ROWS} filas más recientes.`);
    } catch {
      toast.error('No se ha podido exportar.');
    } finally {
      setExporting(false);
    }
  }

  function writeCsv(items: SuperAdminAuditLogDto[]) {
    const rows: (string | number)[][] = [['Fecha', 'Acción', 'Admin', 'Email', 'Tenant', 'IP']];
    for (const l of items) {
      rows.push([
        new Date(l.occurredAt).toLocaleString('es-ES'),
        superAdminAuditLabel(l.action),
        l.superAdminFullName ?? '',
        l.superAdminEmail ?? '',
        l.targetTenantId ?? '',
        l.ipAddress ?? '',
      ]);
    }
    downloadCsv('registro-de-acciones.csv', rows);
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Registro de acciones</h1>
          <p className="text-sm text-muted-foreground">
            Lo que han hecho los super admins: accesos, tenants, cobros, catálogo y plataforma.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}>
          <Download className="mr-1 size-4" /> Exportar CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-md border bg-card p-4 md:grid-cols-5">
        <div className="space-y-1">
          <Label className="text-xs">Acción</Label>
          <Select
            value={action ?? 'all'}
            onValueChange={(v) => {
              setAction(v === 'all' ? undefined : v);
              resetCursor();
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Todas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              {Object.entries(SUPER_ADMIN_AUDIT_GROUPS).map(([group, actions]) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {Object.entries(actions).map(([key, info]) => (
                    <SelectItem key={key} value={key}>
                      {info.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Super admin</Label>
          <Select
            value={superAdminId ?? 'all'}
            onValueChange={(v) => {
              setSuperAdminId(v === 'all' ? undefined : v);
              resetCursor();
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {(superAdmins.data ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="relative space-y-1">
          <Label className="text-xs">Tenant</Label>
          {tenant ? (
            <div className="flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm">
              <span className="truncate">{tenant.name}</span>
              <button
                type="button"
                aria-label="Quitar el tenant"
                onClick={() => {
                  setTenant(null);
                  setTenantInput('');
                  resetCursor();
                }}
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <Input
              value={tenantInput}
              onChange={(e) => setTenantInput(e.target.value)}
              placeholder="Buscar por nombre"
            />
          )}
          {!tenant && (tenantResults.data?.tenants.length ?? 0) > 0 && (
            <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
              {tenantResults.data?.tenants.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setTenant({ id: t.id, name: t.name });
                    resetCursor();
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Desde</Label>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              resetCursor();
            }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Hasta</Label>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              resetCursor();
            }}
          />
        </div>
      </div>

      {logs.isLoading ? (
        <div className="flex h-[40vh] items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : logs.data && logs.data.items.length === 0 ? (
        <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          No hay entradas con los filtros seleccionados.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Fecha</th>
                  <th className="px-3 py-2 text-left font-medium">Acción</th>
                  <th className="px-3 py-2 text-left font-medium">Super admin</th>
                  <th className="px-3 py-2 text-left font-medium">Tenant target</th>
                  <th className="px-3 py-2 text-left font-medium">IP</th>
                  <th className="px-3 py-2 text-left font-medium">Detalles</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {logs.data?.items.map((log) => {
                  return (
                    <tr key={log.id} className="hover:bg-accent/30">
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                        {new Date(log.occurredAt).toLocaleString('es-ES')}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={superAdminAuditTone(log.action)}>
                          {superAdminAuditLabel(log.action)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        {log.superAdminFullName ? (
                          <div className="flex flex-col">
                            <span>{log.superAdminFullName}</span>
                            <span className="text-xs text-muted-foreground">
                              {log.superAdminEmail}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {log.targetTenantId ? (
                          <Link
                            href={`/admin/tenants/${log.targetTenantId}`}
                            className="font-mono text-primary underline-offset-2 hover:underline"
                          >
                            {log.targetTenantId.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{log.ipAddress ?? '—'}</td>
                      <td className="max-w-[420px] px-3 py-2 text-xs text-muted-foreground">
                        <ChangesDetail changes={log.changes} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t bg-muted/20 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              {logs.data?.items.length ?? 0} entradas en esta página
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onPrevPage}
                disabled={cursorStack.length <= 1}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onNextPage}
                disabled={!logs.data?.nextCursor}
              >
                Siguiente
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
