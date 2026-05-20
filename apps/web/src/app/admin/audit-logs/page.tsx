'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminAuditLogs } from '@/lib/admin/hooks';

/**
 * Acciones de super admin que conocemos hoy + etiqueta humana + color.
 * Si en el futuro aparecen nuevas (p.ej. admin.security_alert.sent) la lista
 * sigue funcionando: si no esta en el mapa caemos en `default`.
 */
const ACTION_LABELS: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  'admin.login.success': { label: 'Login OK', variant: 'default' },
  'admin.login.failed': { label: 'Login fallido', variant: 'destructive' },
  'admin.login.requires_2fa': { label: 'Login requiere 2FA', variant: 'outline' },
  'admin.2fa.enabled': { label: '2FA activado', variant: 'default' },
  'admin.2fa.disabled': { label: '2FA desactivado', variant: 'destructive' },
  'admin.2fa.recovery_codes_regenerated': { label: '2FA codes regen', variant: 'outline' },
  'admin.2fa.challenge.success': { label: '2FA challenge OK', variant: 'default' },
  'admin.2fa.challenge.failed': { label: '2FA challenge fallido', variant: 'destructive' },
  'admin.tenant.impersonate': { label: 'Impersonate', variant: 'secondary' },
  'admin.tenant.suspended': { label: 'Tenant suspendido', variant: 'destructive' },
  'admin.tenant.reactivated': { label: 'Tenant reactivado', variant: 'default' },
  'admin.tenant.trial_extended': { label: 'Trial extendido', variant: 'outline' },
};

const KNOWN_ACTIONS = Object.keys(ACTION_LABELS);

/**
 * Panel super admin: tabla read-only de audit logs globales del super admin
 * (Fase 12A.3). Acciones: login (success/failed/requires_2fa), 2FA
 * (enable/disable/regenerate/challenge), tenants (suspend/reactivate/
 * trial_extended/impersonate). Filtros por action, super admin, tenant
 * target y rango de fechas. Paginacion cursor (50 por defecto).
 */
export default function AdminAuditLogsPage() {
  const [action, setAction] = useState<string | undefined>();
  const [superAdminId, setSuperAdminId] = useState('');
  const [targetTenantId, setTargetTenantId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);

  const filters = {
    ...(action ? { action } : {}),
    ...(superAdminId.trim() ? { superAdminId: superAdminId.trim() } : {}),
    ...(targetTenantId.trim() ? { targetTenantId: targetTenantId.trim() } : {}),
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

  return (
    <div className="space-y-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit logs</h1>
        <p className="text-sm text-muted-foreground">
          Acciones globales del super admin: login, 2FA, impersonations y acciones sobre tenants.
        </p>
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
              {KNOWN_ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {ACTION_LABELS[a]?.label ?? a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Super admin ID</Label>
          <Input
            value={superAdminId}
            onChange={(e) => setSuperAdminId(e.target.value)}
            onBlur={resetCursor}
            placeholder="UUID"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Tenant target ID</Label>
          <Input
            value={targetTenantId}
            onChange={(e) => setTargetTenantId(e.target.value)}
            onBlur={resetCursor}
            placeholder="UUID"
          />
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
                  const meta = ACTION_LABELS[log.action];
                  return (
                    <tr key={log.id} className="hover:bg-accent/30">
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                        {new Date(log.occurredAt).toLocaleString('es-ES')}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={meta?.variant ?? 'secondary'}>
                          {meta?.label ?? log.action}
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
                        {log.changes ? (
                          <code className="block truncate" title={JSON.stringify(log.changes)}>
                            {JSON.stringify(log.changes)}
                          </code>
                        ) : (
                          '—'
                        )}
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
