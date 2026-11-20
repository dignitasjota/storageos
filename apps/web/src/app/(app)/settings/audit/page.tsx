'use client';

import { auditActionLabel, type AuditLogDto, type AuditLogFilters } from '@storageos/shared';
import { ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';

import { SettingsHeader } from '../settings-header';

import type { AuditLogListDto } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { auditQuery, useAuditLog } from '@/lib/audit/hooks';
import { apiFetch } from '@/lib/auth/api';
import { downloadCsv } from '@/lib/csv';
import { formatDateTime } from '@/lib/format';
import { useUsers } from '@/lib/users/hooks';

/** Grupos de acciones para filtrar (prefijo del código). */
const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: 'auth.', label: 'Accesos y contraseña' },
  { value: 'user.', label: 'Usuarios del equipo' },
  { value: 'tenant.', label: 'Ajustes del negocio' },
  { value: 'invoice.', label: 'Facturas' },
  { value: 'payment', label: 'Cobros' },
  { value: 'contract.', label: 'Contratos' },
  { value: 'customer.', label: 'Inquilinos' },
  { value: 'rgpd.', label: 'Protección de datos' },
  { value: 'access', label: 'Accesos al local' },
  { value: 'integration.', label: 'Integraciones' },
];

/** Valor del desplegable para «sin filtro» (Radix no admite el valor vacío). */
const ALL = '__all__';
/** Tope de filas del CSV (10 páginas de 500). */
const CSV_MAX_ROWS = 5000;

export default function AuditPage() {
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const users = useUsers();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, refetch } =
    useAuditLog(filters);
  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const active = Object.values(filters).some(Boolean);

  function set<K extends keyof AuditLogFilters>(key: K, value: AuditLogFilters[K] | undefined) {
    setFilters((f) => {
      const next = { ...f };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const rows: AuditLogDto[] = [];
      let cursor: string | undefined;
      let truncated = false;
      // Hasta 5.000 filas con los filtros actuales.
      for (let i = 0; i < CSV_MAX_ROWS / 500; i++) {
        const page = await apiFetch<AuditLogListDto>(auditQuery(filters, cursor, 500));
        rows.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        if (i === CSV_MAX_ROWS / 500 - 1) truncated = true;
      }
      downloadCsv('registro-de-actividad.csv', [
        ['Fecha', 'Usuario', 'Acción', 'Código', 'Elemento', 'IP', 'Cambios'],
        ...rows.map((a) => [
          formatDateTime(a.createdAt),
          a.userName ?? 'Sistema',
          auditActionLabel(a.action),
          a.action,
          a.entityType + (a.entityId ? ` ${a.entityId}` : ''),
          a.ipAddress ?? '',
          a.changes ? JSON.stringify(a.changes) : '',
        ]),
      ]);
      if (truncated) {
        toast.warning(
          `El CSV lleva las ${CSV_MAX_ROWS.toLocaleString('es-ES')} acciones más recientes. Acota las fechas para descargar el resto.`,
        );
      }
    } catch {
      toast.error('No se pudo exportar.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Registro de actividad"
        description="Las acciones importantes de tu equipo: quién hizo qué y cuándo."
      />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-x-4 gap-y-3 pt-6">
          <div className="w-full space-y-1 sm:w-48">
            <Label htmlFor="audit-user">Usuario</Label>
            <Select
              value={filters.userId ?? ALL}
              onValueChange={(v) => set('userId', v === ALL ? undefined : v)}
            >
              <SelectTrigger id="audit-user" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos</SelectItem>
                {(users.data ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full space-y-1 sm:w-48">
            <Label htmlFor="audit-action">Tipo de acción</Label>
            <Select
              value={filters.action ?? ALL}
              onValueChange={(v) => set('action', v === ALL ? undefined : v)}
            >
              <SelectTrigger id="audit-action" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas</SelectItem>
                {ACTION_GROUPS.map((g) => (
                  <SelectItem key={g.value} value={g.value}>
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Desde</Label>
            <DateSelect value={filters.from} onChange={(v) => set('from', v)} />
          </div>
          <div className="space-y-1">
            <Label>Hasta</Label>
            <DateSelect value={filters.to} onChange={(v) => set('to', v)} />
          </div>
          <div className="flex w-full flex-wrap gap-2">
            {active && (
              <Button size="sm" variant="outline" onClick={() => setFilters({})}>
                Quitar los filtros
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void exportCsv()}
              disabled={exporting}
            >
              {exporting ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Download className="mr-1 size-4" />
              )}
              Descargar CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {isError ? (
            <SectionError onRetry={() => void refetch()} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>Fecha</TableHead>
                  <TableHead>Usuario</TableHead>
                  <TableHead>Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                      Cargando…
                    </TableCell>
                  </TableRow>
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                      {active ? 'Nada con estos filtros.' : 'Sin actividad registrada.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((a) => {
                    const expanded = open === a.id;
                    const hasDetail =
                      a.changes != null || a.ipAddress != null || a.entityId != null;
                    return (
                      <Fragment key={a.id}>
                        <TableRow
                          className={hasDetail ? 'cursor-pointer' : undefined}
                          onClick={() => hasDetail && setOpen(expanded ? null : a.id)}
                        >
                          <TableCell className="text-muted-foreground">
                            {hasDetail &&
                              (expanded ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              ))}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {formatDateTime(a.createdAt)}
                          </TableCell>
                          <TableCell className="text-sm">{a.userName ?? 'Sistema'}</TableCell>
                          <TableCell className="text-sm" title={a.action}>
                            {auditActionLabel(a.action)}
                          </TableCell>
                        </TableRow>
                        {expanded && (
                          <TableRow>
                            <TableCell />
                            <TableCell colSpan={3} className="space-y-1 text-xs">
                              <p className="text-muted-foreground">
                                <span className="font-mono">{a.action}</span> · {a.entityType}
                                {a.entityId ? ` · ${a.entityId}` : ''}
                                {a.ipAddress ? ` · IP ${a.ipAddress}` : ''}
                              </p>
                              {a.changes != null && (
                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">
                                  {JSON.stringify(a.changes, null, 2)}
                                </pre>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}

          {!isError && hasNextPage && (
            <div className="mt-3 text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
