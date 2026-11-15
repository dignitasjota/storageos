'use client';

import {
  COMMUNICATION_CHANNEL_LABELS,
  communicationSourceLabel,
  type CommunicationDto,
  type CommunicationStatusValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCommunicationsPage, useRetryCommunication } from '@/lib/communications/hooks';
import { formatDateTime } from '@/lib/format';

const STATUS_LABELS: Record<
  CommunicationStatusValue,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  pending: { label: 'Pendiente', variant: 'secondary' },
  processing: { label: 'Enviando', variant: 'default' },
  sent: { label: 'Enviada', variant: 'default' },
  delivered: { label: 'Entregada', variant: 'default' },
  bounced: { label: 'Rebote', variant: 'destructive' },
  failed: { label: 'Fallida', variant: 'destructive' },
  skipped: { label: 'Omitida', variant: 'outline' },
};

const PERIODS: Record<string, { label: string; days: number | null }> = {
  '7': { label: 'Últimos 7 días', days: 7 },
  '30': { label: 'Últimos 30 días', days: 30 },
  '90': { label: 'Últimos 90 días', days: 90 },
  all: { label: 'Todo', days: null },
};

/** Tras este rato «Enviando», un envío se puede reintentar (el envío se cortó). */
const STUCK_MS = 15 * 60_000;

function isScheduled(c: CommunicationDto): boolean {
  return (
    c.status === 'pending' && !!c.scheduledFor && new Date(c.scheduledFor).getTime() > Date.now()
  );
}

function canRetry(c: CommunicationDto): boolean {
  if (c.status === 'failed' || c.status === 'bounced') return true;
  // `processing` sin avanzar: lo deja así un envío cortado a medias.
  return c.status === 'processing' && Date.now() - new Date(c.createdAt).getTime() > STUCK_MS;
}

export default function CommunicationsPage() {
  const canSend = useHasPermission('communications:send');
  const [status, setStatus] = useState<CommunicationStatusValue | undefined>();
  const [channel, setChannel] = useState<string | undefined>();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState('30');
  const [openId, setOpenId] = useState<string | null>(null);
  // Espera a que deje de escribir para buscar en el servidor.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  const from = useMemo(() => {
    const days = PERIODS[period]?.days;
    return days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
  }, [period]);
  const communications = useCommunicationsPage({
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    ...(search ? { search } : {}),
    ...(from ? { from } : {}),
  });
  const rows = useMemo(
    () => communications.data?.pages.flatMap((p) => p.items) ?? [],
    [communications.data],
  );
  const opened = rows.find((r) => r.id === openId) ?? null;
  const retry = useRetryCommunication();

  async function handleRetry(c: CommunicationDto) {
    try {
      await retry.mutateAsync(c.id);
      toast.success('Se vuelve a enviar. El estado se actualiza en unos segundos.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reintentar');
    }
  }

  const columns: ColumnDef<CommunicationDto>[] = [
    {
      accessorKey: 'createdAt',
      header: 'Fecha',
      cell: ({ row }) => formatDateTime(row.original.createdAt),
    },
    {
      accessorKey: 'channel',
      header: 'Canal',
      cell: ({ row }) => COMMUNICATION_CHANNEL_LABELS[row.original.channel] ?? row.original.channel,
    },
    {
      accessorKey: 'recipient',
      header: 'Destinatario',
      cell: ({ row }) => {
        const c = row.original;
        if (!c.customerId) return c.recipient;
        return (
          <Link href={`/customers/${c.customerId}`} className="hover:underline">
            {c.customerName ?? c.recipient}
            {c.customerName ? (
              <span className="block text-xs text-muted-foreground">{c.recipient}</span>
            ) : null}
          </Link>
        );
      },
    },
    { accessorKey: 'subject', header: 'Asunto', cell: ({ row }) => row.original.subject ?? '—' },
    {
      id: 'related',
      header: 'Relacionado',
      cell: ({ row }) => <RelatedLinks c={row.original} />,
    },
    {
      accessorKey: 'source',
      header: 'Tipo',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {communicationSourceLabel(row.original.source, row.original.campaignName)}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => <StatusCell c={row.original} />,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canSend && canRetry(row.original) ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleRetry(row.original)}
            disabled={retry.isPending}
          >
            Reintentar
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Comunicaciones</h1>
        <p className="text-sm text-muted-foreground">
          Los correos y mensajes de WhatsApp enviados a inquilinos y contactos. Pulsa uno para
          leerlo; los que fallan se pueden reintentar.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Buscar destinatario, asunto o inquilino…"
          className="w-full text-base sm:w-[300px] sm:text-sm"
        />
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PERIODS).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status ?? 'all'}
          onValueChange={(v) =>
            setStatus(v === 'all' ? undefined : (v as CommunicationStatusValue))
          }
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {(Object.keys(STATUS_LABELS) as CommunicationStatusValue[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={channel ?? 'all'}
          onValueChange={(v) => setChannel(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Canal" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los canales</SelectItem>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="whatsapp">WhatsApp</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {communications.isError ? (
        <SectionError onRetry={() => void communications.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={communications.isLoading}
          emptyText="No hay comunicaciones con estos filtros."
          onRowClick={(c) => setOpenId(c.id)}
          loadMore={{
            hasMore: !!communications.hasNextPage,
            loading: communications.isFetchingNextPage,
            onLoadMore: () => void communications.fetchNextPage(),
          }}
        />
      )}

      <CommunicationDialog
        c={opened}
        onOpenChange={(open) => !open && setOpenId(null)}
        {...(canSend ? { onRetry: (c: CommunicationDto) => void handleRetry(c) } : {})}
      />
    </div>
  );
}

function RelatedLinks({ c }: { c: CommunicationDto }) {
  const links: { href: string; label: string }[] = [];
  if (c.contractId) {
    links.push({ href: `/contracts/${c.contractId}`, label: c.contractNumber ?? 'Contrato' });
  }
  if (c.unitId) links.push({ href: `/units/${c.unitId}`, label: c.unitCode ?? 'Trastero' });
  if (c.invoiceId) {
    links.push({ href: `/invoices/${c.invoiceId}`, label: c.invoiceNumber ?? 'Factura' });
  }
  if (links.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="hover:underline">
          {l.label}
        </Link>
      ))}
    </div>
  );
}

function StatusCell({ c }: { c: CommunicationDto }) {
  const s = isScheduled(c)
    ? { label: 'Programada', variant: 'secondary' as const }
    : STATUS_LABELS[c.status];
  return (
    <div className="space-y-0.5">
      <Badge variant={s.variant}>{s.label}</Badge>
      {isScheduled(c) && (
        <p className="text-xs text-muted-foreground">Sale el {formatDateTime(c.scheduledFor!)}</p>
      )}
      {c.errorMessage &&
        (c.status === 'skipped' || c.status === 'failed' || c.status === 'bounced') && (
          <p className="max-w-[220px] text-xs text-muted-foreground">{c.errorMessage}</p>
        )}
    </div>
  );
}

/** Lo que se envió, a quién, cuándo y qué pasó. */
function CommunicationDialog({
  c,
  onOpenChange,
  onRetry,
}: {
  c: CommunicationDto | null;
  onOpenChange: (open: boolean) => void;
  onRetry?: (c: CommunicationDto) => void;
}) {
  return (
    <Dialog open={!!c} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {c && (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6">{c.subject ?? 'Mensaje'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[130px_1fr]">
                <dt className="text-muted-foreground">Para</dt>
                <dd>
                  {c.customerName ? `${c.customerName} · ` : ''}
                  {c.recipient}
                </dd>
                <dt className="text-muted-foreground">Canal</dt>
                <dd>{COMMUNICATION_CHANNEL_LABELS[c.channel] ?? c.channel}</dd>
                <dt className="text-muted-foreground">Tipo</dt>
                <dd>{communicationSourceLabel(c.source, c.campaignName)}</dd>
                <dt className="text-muted-foreground">Estado</dt>
                <dd>
                  <StatusCell c={c} />
                </dd>
                <dt className="text-muted-foreground">Creado</dt>
                <dd>{formatDateTime(c.createdAt)}</dd>
                {c.sentAt && (
                  <>
                    <dt className="text-muted-foreground">Enviado</dt>
                    <dd>{formatDateTime(c.sentAt)}</dd>
                  </>
                )}
                {c.deliveredAt && (
                  <>
                    <dt className="text-muted-foreground">Entregado</dt>
                    <dd>{formatDateTime(c.deliveredAt)}</dd>
                  </>
                )}
                {c.failedAt && (
                  <>
                    <dt className="text-muted-foreground">Falló</dt>
                    <dd>{formatDateTime(c.failedAt)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Relacionado</dt>
                <dd>
                  <RelatedLinks c={c} />
                </dd>
              </dl>
              <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2 text-muted-foreground">
                {c.bodyText}
              </p>
              <p className="text-xs text-muted-foreground">
                Los códigos de los enlaces que dan acceso (firmar, pagar, descargar) se ven como
                ••••: el destinatario los recibió completos.
              </p>
              {onRetry && canRetry(c) && (
                <Button size="sm" variant="outline" onClick={() => onRetry(c)}>
                  Reintentar el envío
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
