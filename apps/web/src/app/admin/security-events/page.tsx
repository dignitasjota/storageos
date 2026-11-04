'use client';

import { type SecurityEventTypeValue } from '@storageos/shared';
import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { SecurityEventDto } from '@storageos/shared';

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
import { adminFetchAllPages, EXPORT_MAX_ROWS } from '@/lib/admin/api';
import { useAdminSecurityEvents } from '@/lib/admin/hooks';
import { downloadCsv } from '@/lib/csv';
import { useDebouncedSearch } from '@/lib/pagination';

const EVENT_TYPE_LABELS: Record<
  SecurityEventTypeValue,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  login_failed_email_not_found: { label: 'Email no encontrado', variant: 'secondary' },
  login_failed_tenant_not_found: { label: 'Empresa no encontrada', variant: 'destructive' },
  login_failed_wrong_password: { label: 'Contraseña incorrecta', variant: 'secondary' },
  login_failed_throttled: { label: 'Demasiados intentos de entrar', variant: 'outline' },
  register_throttled: { label: 'Demasiados registros', variant: 'outline' },
  password_reset_throttled: { label: 'Demasiadas recuperaciones', variant: 'outline' },
  invitation_token_invalid: { label: 'Invitación no válida', variant: 'destructive' },
  refresh_token_reuse: { label: 'Sesión reutilizada', variant: 'destructive' },
  admin_login_failed: { label: 'Panel admin: entrada fallida', variant: 'destructive' },
  admin_two_factor_failed: { label: 'Panel admin: 2FA fallida', variant: 'destructive' },
};

const EVENT_TYPES = Object.keys(EVENT_TYPE_LABELS) as SecurityEventTypeValue[];

/** Solo se filtra con una IP completa: el API compara la dirección exacta. */
function isIp(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || (value.includes(':') && value.length > 2);
}

/**
 * Panel super admin: tabla read-only de eventos de seguridad globales
 * (Fase 11A.1). Filtros por tipo, email y rango de fechas. Paginacion
 * cursor (50 por defecto).
 */
export default function AdminSecurityEventsPage() {
  const [eventType, setEventType] = useState<SecurityEventTypeValue | undefined>();
  const [emailInput, emailAttempted, setEmailInput] = useDebouncedSearch();
  const [ipInput, ipAddress, setIpInput] = useDebouncedSearch();
  const [exporting, setExporting] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);

  const filters = {
    ...(eventType ? { eventType } : {}),
    ...(emailAttempted ? { emailAttempted } : {}),
    ...(isIp(ipAddress) ? { ipAddress } : {}),
    ...(fromDate ? { fromDate: new Date(fromDate).toISOString() } : {}),
    ...(toDate ? { toDate: new Date(toDate).toISOString() } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  };

  const events = useAdminSecurityEvents(filters);

  function resetCursor() {
    setCursor(undefined);
    setCursorStack([undefined]);
  }

  function onNextPage() {
    if (!events.data?.nextCursor) return;
    setCursorStack((s) => [...s, events.data!.nextCursor!]);
    setCursor(events.data.nextCursor);
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
      const { items, truncated } = await adminFetchAllPages<SecurityEventDto>(
        '/admin/security-events',
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

  function writeCsv(items: SecurityEventDto[]) {
    const rows: (string | number)[][] = [['Fecha', 'Tipo', 'Email', 'Tenant', 'IP', 'Motivo']];
    for (const ev of items) {
      rows.push([
        new Date(ev.occurredAt).toLocaleString('es-ES'),
        EVENT_TYPE_LABELS[ev.eventType]?.label ?? ev.eventType,
        ev.emailAttempted ?? '',
        ev.tenantSlugAttempted ?? '',
        ev.ipAddress ?? '',
        ev.reason ?? '',
      ]);
    }
    downloadCsv('eventos-seguridad.csv', rows);
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Eventos de seguridad</h1>
          <p className="text-sm text-muted-foreground">
            Intentos de entrar fallidos, también al panel admin, límites de peticiones y sesiones
            reutilizadas.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}>
          <Download className="mr-1 size-4" /> Exportar CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-md border bg-card p-4 md:grid-cols-5">
        <div className="space-y-1">
          <Label className="text-xs">Tipo de evento</Label>
          <Select
            value={eventType ?? 'all'}
            onValueChange={(v) => {
              setEventType(v === 'all' ? undefined : (v as SecurityEventTypeValue));
              resetCursor();
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {EVENT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {EVENT_TYPE_LABELS[t].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Email intentado</Label>
          <Input
            value={emailInput}
            onChange={(e) => {
              setEmailInput(e.target.value);
              resetCursor();
            }}
            placeholder="Parte del email"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">IP exacta</Label>
          <Input
            value={ipInput}
            onChange={(e) => {
              setIpInput(e.target.value);
              resetCursor();
            }}
            placeholder="203.0.113.42"
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

      {events.isLoading ? (
        <div className="flex h-[40vh] items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : events.data && events.data.items.length === 0 ? (
        <div className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          No hay eventos con los filtros seleccionados.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Fecha</th>
                  <th className="px-3 py-2 text-left font-medium">Tipo</th>
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                  <th className="px-3 py-2 text-left font-medium">Slug</th>
                  <th className="px-3 py-2 text-left font-medium">IP</th>
                  <th className="px-3 py-2 text-left font-medium">Motivo</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {events.data?.items.map((ev) => {
                  const label = EVENT_TYPE_LABELS[ev.eventType];
                  return (
                    <tr key={ev.id} className="hover:bg-accent/30">
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                        {new Date(ev.occurredAt).toLocaleString('es-ES')}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={label?.variant ?? 'secondary'}>
                          {label?.label ?? ev.eventType}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{ev.emailAttempted ?? '—'}</td>
                      <td className="px-3 py-2">{ev.tenantSlugAttempted ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{ev.ipAddress ?? '—'}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {ev.reason ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t bg-muted/20 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              {events.data?.items.length ?? 0} eventos en esta pagina
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
                disabled={!events.data?.nextCursor}
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
