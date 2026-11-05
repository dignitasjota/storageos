'use client';

import {
  accessReasonLabel,
  type AccessLogDto,
  type AccessResultValue,
  isStaffAccessLog,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Camera, Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  fetchAllAccessLogs,
  useAccessLogCamera,
  useAccessLogPages,
  useDevices,
} from '@/lib/access/hooks';
import { useHasFeature } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { formatDateTime } from '@/lib/format';

const METHOD_LABELS: Record<string, string> = {
  pin: 'PIN',
  qr: 'QR',
  rfid: 'Tarjeta',
  face: 'Facial',
};

const RESULT_LABELS: Record<AccessResultValue, { label: string; className: string }> = {
  allowed: {
    label: 'Permitido',
    className: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  },
  denied_invalid_credential: {
    label: 'Credencial inválida',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  denied_inactive_credential: {
    label: 'Credencial inactiva',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  },
  denied_outside_hours: {
    label: 'Fuera de horario',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  },
  denied_wrong_facility: {
    label: 'Local incorrecto',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300',
  },
  denied_dunning: {
    label: 'Impago',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  denied_unknown: {
    label: 'Denegado',
    className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  error: {
    label: 'Error',
    className: 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  },
};

const RESULTS = Object.keys(RESULT_LABELS) as AccessResultValue[];

export default function AccessLogsPage() {
  const [result, setResult] = useState<AccessResultValue | undefined>();
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState<string | undefined>();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [cameraLog, setCameraLog] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const hasCameras = useHasFeature('cameras');
  const facilityId = useHeaderFacilityId();

  async function exportCsv() {
    setExporting(true);
    try {
      const all = await fetchAllAccessLogs({ facilityId, customerId, deviceId, result, from, to });
      downloadCsv('registro-accesos.csv', [
        ['Fecha', 'Quién', 'Dispositivo', 'Método', 'Resultado', 'Código', 'Motivo'],
        ...all.map((l) => [
          formatDateTime(l.occurredAt),
          isStaffAccessLog(l.reason)
            ? `Equipo ${l.staffName ?? ''}`.trim()
            : (l.customerName ?? ''),
          l.deviceName ?? '',
          METHOD_LABELS[l.method] ?? l.method,
          RESULT_LABELS[l.result]?.label ?? l.result,
          l.attemptedValue ?? '',
          accessReasonLabel(l.reason) ?? '',
        ]),
      ]);
    } catch {
      toast.error('No se ha podido exportar.');
    } finally {
      setExporting(false);
    }
  }

  const logs = useAccessLogPages({
    ...(customerId ? { customerId } : {}),
    ...(result ? { result } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const rows = logs.data?.pages.flat() ?? [];
  const devices = useDevices();

  const columns: ColumnDef<AccessLogDto>[] = [
    {
      accessorKey: 'occurredAt',
      header: 'Fecha',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {formatDateTime(row.original.occurredAt)}
        </span>
      ),
    },
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) =>
        isStaffAccessLog(row.original.reason) ? (
          <span className="text-sm text-muted-foreground">
            Equipo{row.original.staffName ? ` · ${row.original.staffName}` : ''}
          </span>
        ) : row.original.customerId ? (
          <Link href={`/customers/${row.original.customerId}`} className="text-sm hover:underline">
            {row.original.customerName}
          </Link>
        ) : (
          <span className="text-sm">{row.original.customerName ?? '—'}</span>
        ),
    },
    {
      accessorKey: 'deviceName',
      header: 'Dispositivo',
      cell: ({ row }) => <span className="text-sm">{row.original.deviceName ?? '—'}</span>,
    },
    {
      accessorKey: 'method',
      header: 'Método',
      cell: ({ row }) => (
        <span className="text-xs">
          {isStaffAccessLog(row.original.reason)
            ? 'Panel'
            : (METHOD_LABELS[row.original.method] ?? row.original.method)}
        </span>
      ),
    },
    {
      accessorKey: 'result',
      header: 'Resultado',
      cell: ({ row }) => {
        const r = RESULT_LABELS[row.original.result] ?? {
          label: row.original.result,
          className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
        };
        return (
          <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${r.className}`}>
            {r.label}
          </span>
        );
      },
    },
    {
      accessorKey: 'attemptedValue',
      header: 'Código',
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.attemptedValue ?? '—'}
        </span>
      ),
    },
    {
      accessorKey: 'reason',
      header: 'Motivo',
      cell: ({ row }) =>
        row.original.reason ? (
          <Badge variant="outline" className="text-xs">
            {accessReasonLabel(row.original.reason)}
          </Badge>
        ) : (
          '—'
        ),
    },
    ...(hasCameras
      ? [
          {
            id: 'camera',
            header: '',
            cell: ({ row }: { row: { original: AccessLogDto } }) => (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Ver la foto de la cámara"
                onClick={() => setCameraLog(row.original.id)}
              >
                <Camera className="h-4 w-4" />
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select
          value={result ?? 'all'}
          onValueChange={(v) => setResult(v === 'all' ? undefined : (v as AccessResultValue))}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Resultado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los resultados</SelectItem>
            {RESULTS.map((r) => (
              <SelectItem key={r} value={r}>
                {RESULT_LABELS[r].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={deviceId ?? 'all'}
          onValueChange={(v) => setDeviceId(v === 'all' ? undefined : v)}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Dispositivo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los dispositivos</SelectItem>
            {(devices.data ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CustomerSearchSelect
          value={customerId}
          onChange={setCustomerId}
          clearLabel="Todos los inquilinos"
          className="w-[220px]"
        />
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Desde</span>
          <DateSelect value={from} onChange={setFrom} />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Hasta</span>
          <DateSelect value={to} onChange={setTo} />
        </div>
      </div>

      {logs.isError && rows.length === 0 ? (
        <SectionError onRetry={() => void logs.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={logs.isLoading}
          loadMore={{
            hasMore: !!logs.hasNextPage,
            loading: logs.isFetchingNextPage,
            onLoadMore: () => void logs.fetchNextPage(),
          }}
          searchPlaceholder="Buscar..."
          toolbarRight={
            <Button variant="outline" disabled={exporting} onClick={() => void exportCsv()}>
              <Download className="mr-1 h-4 w-4" /> {exporting ? 'Exportando...' : 'Exportar CSV'}
            </Button>
          }
          emptyText="No hay intentos de acceso registrados todavía."
        />
      )}

      {cameraLog && <CameraDialog logId={cameraLog} onClose={() => setCameraLog(null)} />}
    </div>
  );
}

function CameraDialog({ logId, onClose }: { logId: string; onClose: () => void }) {
  const camera = useAccessLogCamera(logId);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Foto de la cámara</DialogTitle>
        </DialogHeader>
        {camera.isLoading ? (
          <p className="text-sm text-muted-foreground">Buscando…</p>
        ) : camera.data ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={camera.data.url} alt="Foto de la cámara" className="w-full rounded-md" />
            <p className="text-sm text-muted-foreground">
              {camera.data.cameraName} · {formatDateTime(camera.data.occurredAt)}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No hay ninguna foto en los dos minutos alrededor de este acceso.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
