'use client';

import {
  PLATFORM_EMAIL_KIND_INFO,
  PLATFORM_EMAIL_KINDS,
  type PlatformEmailKind,
  type PlatformEmailLogDto,
  type PlatformEmailLogStatus,
} from '@storageos/shared';
import { ChevronDown, ChevronRight, Download, Eye, Loader2, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminApiFetchBlob } from '@/lib/admin/api';
import { useEmailBody, useResendEmail } from '@/lib/admin/comms-hooks';
import { useAdminEmailLog } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

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
  const [announcementId, setAnnouncementId] = useState<string | null>(null);
  // `?kind=`, `?status=` y `?announcementId=` en la dirección (p. ej. desde un anuncio recién enviado).
  useEffect(() => {
    if (tenantId) return;
    const qs = new URLSearchParams(window.location.search);
    const k = qs.get('kind');
    const st = qs.get('status');
    if (k && (PLATFORM_EMAIL_KINDS as readonly string[]).includes(k)) setKind(k);
    if (st && st in STATUS) setStatus(st);
    const a = qs.get('announcementId');
    if (a && /^[0-9a-f-]{36}$/i.test(a)) setAnnouncementId(a);
  }, [tenantId]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const log = useAdminEmailLog({
    ...(tenantId ? { tenantId } : {}),
    ...(search ? { search } : {}),
    ...(kind !== 'all' ? { kind } : {}),
    ...(status !== 'all' ? { status } : {}),
    ...(announcementId ? { announcementId } : {}),
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
        <Button
          variant="outline"
          onClick={() => {
            const qs = new URLSearchParams();
            if (tenantId) qs.set('tenantId', tenantId);
            if (search) qs.set('search', search);
            if (kind !== 'all') qs.set('kind', kind);
            if (status !== 'all') qs.set('status', status);
            if (announcementId) qs.set('announcementId', announcementId);
            void adminApiFetchBlob(`/admin/email-log/export?${qs}`).then((blob) => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'correos-enviados.csv';
              a.click();
              URL.revokeObjectURL(url);
            });
          }}
        >
          <Download className="mr-1.5 size-4" /> CSV
        </Button>
      </div>
      {announcementId && (
        <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          Solo los correos de un anuncio.
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => setAnnouncementId(null)}
          >
            Ver todos
          </button>
        </p>
      )}

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
  const [viewing, setViewing] = useState(false);
  const resend = useResendEmail();
  const canEdit = useIsSuperadmin();
  const confirm = useConfirm();
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
          {row.hasHtml && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setViewing(true)}>
                <Eye className="mr-1 size-3.5" /> Ver el correo
              </Button>
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resend.isPending}
                  onClick={async () => {
                    if (!(await confirm({ title: `¿Reenviar este correo a ${row.recipient}?` })))
                      return;
                    try {
                      const r = await resend.mutateAsync(row.id);
                      if (r.suppressed) toast.error(r.suppressed);
                      else toast.success('Correo reenviado.');
                    } catch (err) {
                      toast.error(
                        err instanceof ApiError ? err.body.message : 'No se pudo reenviar.',
                      );
                    }
                  }}
                >
                  <RotateCw className="mr-1 size-3.5" /> Reenviar
                </Button>
              )}
            </div>
          )}
          {viewing && (
            <EmailBodyDialog id={row.id} subject={row.subject} onClose={() => setViewing(false)} />
          )}
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

function EmailBodyDialog({
  id,
  subject,
  onClose,
}: {
  id: string;
  subject: string;
  onClose: () => void;
}) {
  const body = useEmailBody(id);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{subject}</DialogTitle>
        </DialogHeader>
        {body.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : body.data?.html ? (
          <iframe
            title="Correo enviado"
            sandbox=""
            srcDoc={body.data.html}
            className="h-[520px] w-full rounded-md border bg-white"
          />
        ) : (
          <p className="text-sm text-muted-foreground">No se guardó el HTML de este correo.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
