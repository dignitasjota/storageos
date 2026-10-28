'use client';

import { auditActionLabel, type AuditLogDto, type AuditLogFilters } from '@storageos/shared';
import { ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';

import { SettingsHeader } from '../settings-header';

import type { AuditLogListDto } from '@storageos/shared';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
];

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-base sm:text-sm';

export default function AuditPage() {
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const users = useUsers();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useAuditLog(filters);
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
      // Hasta 5.000 filas con los filtros actuales.
      for (let i = 0; i < 10; i++) {
        const page = await apiFetch<AuditLogListDto>(auditQuery(filters, cursor, 500));
        rows.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
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
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="audit-user">Usuario</Label>
            <select
              id="audit-user"
              className={selectClass}
              value={filters.userId ?? ''}
              onChange={(e) => set('userId', e.target.value || undefined)}
            >
              <option value="">Todos</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="audit-action">Tipo de acción</Label>
            <select
              id="audit-action"
              className={selectClass}
              value={filters.action ?? ''}
              onChange={(e) => set('action', e.target.value || undefined)}
            >
              <option value="">Todas</option>
              {ACTION_GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Desde</Label>
            <DateSelect value={filters.from} onChange={(v) => set('from', v)} />
          </div>
          <div className="space-y-1">
            <Label>Hasta</Label>
            <DateSelect value={filters.to} onChange={(v) => set('to', v)} />
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6" />
                <TableHead>Fecha</TableHead>
                <TableHead>Usuario</TableHead>
                <TableHead>Acción</TableHead>
                <TableHead className="hidden md:table-cell">Código</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    Cargando…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    {active ? 'Nada con estos filtros.' : 'Sin actividad registrada.'}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((a) => {
                  const expanded = open === a.id;
                  const hasDetail = a.changes != null || a.ipAddress != null || a.entityId != null;
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
                        <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                          {a.action}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow>
                          <TableCell />
                          <TableCell colSpan={4} className="space-y-1 text-xs">
                            <p className="text-muted-foreground">
                              {a.entityType}
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

          {hasNextPage && (
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
