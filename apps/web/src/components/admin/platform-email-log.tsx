'use client';

import {
  PLATFORM_EMAIL_KIND_INFO,
  PLATFORM_EMAIL_KINDS,
  type PlatformEmailKind,
  type PlatformEmailLogDto,
  type PlatformEmailLogStatus,
} from '@storageos/shared';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

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
import { useAdminEmailLog } from '@/lib/admin/hooks';

const STATUS: Record<PlatformEmailLogStatus, { label: string; className: string }> = {
  sent: {
    label: 'Enviado',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  },
  delivered: {
    label: 'Entregado',
    className: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  bounced: {
    label: 'Rebotado',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  failed: {
    label: 'Fallido',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  suppressed: {
    label: 'No enviado (bloqueado)',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
};

function kindLabel(kind: string | null): string {
  if (!kind) return 'Otro';
  return PLATFORM_EMAIL_KIND_INFO[kind as PlatformEmailKind]?.label ?? kind;
}

/** Historial de correos de la plataforma (todos o los de un tenant). */
export function PlatformEmailLog({ tenantId }: { tenantId?: string }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const log = useAdminEmailLog({
    ...(tenantId ? { tenantId } : {}),
    ...(search ? { search } : {}),
    ...(kind !== 'all' ? { kind } : {}),
    ...(status !== 'all' ? { status } : {}),
  });
  const rows = useMemo(() => log.data?.pages.flatMap((p) => p.items) ?? [], [log.data]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={
            tenantId ? 'Buscar destinatario o asunto…' : 'Buscar destinatario, asunto o tenant…'
          }
          className="w-full text-base sm:w-[300px] sm:text-sm"
        />
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tipos</SelectItem>
            {PLATFORM_EMAIL_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {PLATFORM_EMAIL_KIND_INFO[k].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS) as PlatformEmailLogStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {log.isLoading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : log.isError ? (
        <p className="text-sm text-destructive">No se pudo cargar el historial.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hay correos con estos filtros.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((r) => (
            <EmailRow key={r.id} row={r} showTenant={!tenantId} />
          ))}
        </ul>
      )}

      {log.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
          >
            {log.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
          </Button>
        </div>
      )}
    </div>
  );
}

function EmailRow({ row, showTenant }: { row: PlatformEmailLogDto; showTenant: boolean }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[row.status];
  return (
    <li className="p-3 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.subject}</span>
            <Badge className={st.className} variant="outline">
              {st.label}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {new Date(row.createdAt).toLocaleString('es-ES')} · {kindLabel(row.kind)} ·{' '}
            {row.recipient}
          </p>
        </div>
      </button>
      {showTenant && row.tenantId && (
        <p className="ml-6 mt-1 text-xs">
          <Link href={`/admin/tenants/${row.tenantId}`} className="hover:underline">
            {row.tenantName ?? 'Ver tenant'}
          </Link>
        </p>
      )}
      {open && (
        <div className="ml-6 mt-2 space-y-2 text-xs">
          <p className="text-muted-foreground">
            Proveedor: {row.provider ?? '—'}
            {row.deliveredAt
              ? ` · entregado el ${new Date(row.deliveredAt).toLocaleString('es-ES')}`
              : ''}
          </p>
          {row.errorMessage && <p className="text-destructive">{row.errorMessage}</p>}
          {row.bodyText ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-sans">
              {row.bodyText}
            </pre>
          ) : (
            <p className="italic text-muted-foreground">
              El texto no se guarda en los correos de cuenta (llevan enlaces que dan acceso).
            </p>
          )}
        </div>
      )}
    </li>
  );
}
