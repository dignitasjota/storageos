'use client';

import {
  COMMUNICATION_CHANNEL_LABELS,
  COMMUNICATION_SOURCE_GROUPS,
  communicationSourceLabel,
  type CommunicationDto,
  type CommunicationSourceGroup,
  type CommunicationStatusValue,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Download, Eye } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ProblemAddresses } from './problem-addresses';

import { useConfirm } from '@/components/confirm-provider';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, apiFetchBlob } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  communicationPageQuery,
  useCancelCommunication,
  useCommunicationPreview,
  useCommunicationStats,
  useCommunicationsPage,
  useRetryCommunication,
} from '@/lib/communications/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { useFacilityFilterState } from '@/lib/facilities/store';
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
  const [tab, setTab] = useState('history');
  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Comunicaciones</h1>
        <p className="text-sm text-muted-foreground">
          Los correos y mensajes de WhatsApp enviados a inquilinos y contactos. Pulsa uno para
          leerlo; los que fallan se pueden reintentar.
        </p>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="history">Historial</TabsTrigger>
          <TabsTrigger value="problems">Direcciones con problemas</TabsTrigger>
        </TabsList>
        <TabsContent value="history" className="mt-4">
          <History />
        </TabsContent>
        <TabsContent value="problems" className="mt-4">
          <ProblemAddresses enabled={tab === 'problems'} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function History() {
  const ask = useConfirm();
  const canSend = useHasPermission('communications:send');
  const facilities = useFacilities();
  const facilityList = facilities.data ?? [];
  const [facilityId, setFacilityId] = useFacilityFilterState();
  const [status, setStatus] = useState<CommunicationStatusValue | undefined>();
  const [channel, setChannel] = useState<string | undefined>();
  const [sourceGroup, setSourceGroup] = useState<CommunicationSourceGroup | undefined>();
  const [exporting, setExporting] = useState(false);
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
  const params = {
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    ...(search ? { search } : {}),
    ...(from ? { from } : {}),
    ...(sourceGroup ? { sourceGroup } : {}),
    ...(facilityId ? { facilityId } : {}),
  };
  const communications = useCommunicationsPage(params);
  const stats = useCommunicationStats(params);
  const rows = useMemo(
    () => communications.data?.pages.flatMap((p) => p.items) ?? [],
    [communications.data],
  );
  const opened = rows.find((r) => r.id === openId) ?? null;
  const retry = useRetryCommunication();
  const cancel = useCancelCommunication();

  async function handleCancel(c: CommunicationDto) {
    const ok = await ask({
      title: '¿Cancelar este envío?',
      description: 'No saldrá. Queda en el historial como omitido.',
      confirmLabel: 'Cancelar el envío',
      destructive: true,
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(c.id);
      toast.success('Envío cancelado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar');
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const { status: _s, ...rest } = params;
      const qs = communicationPageQuery({ ...rest, ...(status ? { status } : {}) });
      const blob = await apiFetchBlob(`/communications/export?${qs}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'comunicaciones.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo exportar');
    } finally {
      setExporting(false);
    }
  }

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
        ) : canSend && row.original.status === 'pending' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleCancel(row.original)}
            disabled={cancel.isPending}
          >
            Cancelar
          </Button>
        ) : null,
    },
  ];

  const st = stats.data;
  return (
    <div className="space-y-4">
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
        <Select
          value={sourceGroup ?? 'all'}
          onValueChange={(v) =>
            setSourceGroup(v === 'all' ? undefined : (v as CommunicationSourceGroup))
          }
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los tipos</SelectItem>
            {(Object.keys(COMMUNICATION_SOURCE_GROUPS) as CommunicationSourceGroup[]).map((g) => (
              <SelectItem key={g} value={g}>
                {COMMUNICATION_SOURCE_GROUPS[g].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {facilityList.length > 1 && (
          <Select
            value={facilityId ?? 'all'}
            onValueChange={(v) => setFacilityId(v === 'all' ? undefined : v)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Local" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los locales</SelectItem>
              {facilityList.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
          <Download className="mr-1 size-4" />
          {exporting ? 'Exportando…' : 'CSV'}
        </Button>
      </div>

      {st && st.total > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatTile
            label="Total"
            value={st.total}
            active={!status}
            onClick={() => setStatus(undefined)}
          />
          <StatTile
            label="Enviados"
            value={st.sent + st.delivered}
            hint={st.delivered > 0 ? `${st.delivered} entregados` : undefined}
            active={status === 'sent'}
            onClick={() => setStatus('sent')}
          />
          <StatTile
            label="Rebotes"
            value={st.bounced}
            warn={st.bounced > 0}
            active={status === 'bounced'}
            onClick={() => setStatus('bounced')}
          />
          <StatTile
            label="Fallidos"
            value={st.failed}
            warn={st.failed > 0}
            active={status === 'failed'}
            onClick={() => setStatus('failed')}
          />
          <StatTile
            label="Pendientes"
            value={st.pending}
            active={status === 'pending'}
            onClick={() => setStatus('pending')}
          />
        </div>
      )}

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
        {...(canSend
          ? {
              onRetry: (c: CommunicationDto) => void handleRetry(c),
              onCancel: (c: CommunicationDto) => void handleCancel(c),
            }
          : {})}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  warn,
  active,
  onClick,
}: {
  label: string;
  value: number;
  hint?: string | undefined;
  warn?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-2 text-left transition-colors hover:bg-muted/60 ${active ? 'border-primary bg-primary/5' : ''}`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold ${warn ? 'text-amber-600 dark:text-amber-400' : ''}`}>
        {value.toLocaleString('es-ES')}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </button>
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
  onCancel,
}: {
  c: CommunicationDto | null;
  onOpenChange: (open: boolean) => void;
  onRetry?: (c: CommunicationDto) => void;
  onCancel?: (c: CommunicationDto) => void;
}) {
  const [asSent, setAsSent] = useState(false);
  const preview = useCommunicationPreview(asSent && c?.channel === 'email' ? c.id : null);
  useEffect(() => setAsSent(false), [c?.id]);
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
                <dt className="text-muted-foreground">Recorrido</dt>
                <dd>
                  <Timeline c={c} />
                </dd>
                <dt className="text-muted-foreground">Relacionado</dt>
                <dd>
                  <RelatedLinks c={c} />
                </dd>
              </dl>
              {asSent && c.channel === 'email' ? (
                preview.isError ? (
                  <SectionError onRetry={() => void preview.refetch()} />
                ) : preview.data ? (
                  <iframe
                    title="Correo tal como se envió"
                    sandbox=""
                    srcDoc={preview.data.html}
                    className="h-[55vh] w-full rounded-md border bg-white"
                  />
                ) : (
                  <p className="text-muted-foreground">Cargando…</p>
                )
              ) : (
                <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2 text-muted-foreground">
                  {c.bodyText}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Los códigos de los enlaces que dan acceso (firmar, pagar, descargar) se ven como
                ••••: el destinatario los recibió completos.
              </p>
              <div className="flex flex-wrap gap-2">
                {c.channel === 'email' && (
                  <Button size="sm" variant="outline" onClick={() => setAsSent((v) => !v)}>
                    <Eye className="mr-1 size-4" />
                    {asSent ? 'Ver el texto' : 'Ver el correo como le llegó'}
                  </Button>
                )}
                {onRetry && canRetry(c) && (
                  <Button size="sm" variant="outline" onClick={() => onRetry(c)}>
                    Reintentar el envío
                  </Button>
                )}
                {onCancel && c.status === 'pending' && (
                  <Button size="sm" variant="ghost" onClick={() => onCancel(c)}>
                    Cancelar el envío
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Los pasos del envío: creado, programado, enviado, entregado o fallido. */
function Timeline({ c }: { c: CommunicationDto }) {
  const steps: { label: string; at: string; tone?: 'bad' }[] = [
    { label: 'Creado', at: c.createdAt },
  ];
  if (isScheduled(c)) steps.push({ label: 'Saldrá', at: c.scheduledFor! });
  if (c.sentAt) steps.push({ label: 'Enviado', at: c.sentAt });
  if (c.deliveredAt) steps.push({ label: 'Entregado', at: c.deliveredAt });
  if (c.failedAt) {
    steps.push({ label: c.status === 'bounced' ? 'Rebotó' : 'Falló', at: c.failedAt, tone: 'bad' });
  }
  return (
    <ol className="space-y-1">
      {steps.map((s) => (
        <li key={s.label} className="flex items-center gap-2">
          <span
            className={`size-2 shrink-0 rounded-full ${s.tone === 'bad' ? 'bg-destructive' : 'bg-primary'}`}
          />
          <span className={s.tone === 'bad' ? 'text-destructive' : ''}>{s.label}</span>
          <span className="text-muted-foreground">{formatDateTime(s.at)}</span>
        </li>
      ))}
    </ol>
  );
}
