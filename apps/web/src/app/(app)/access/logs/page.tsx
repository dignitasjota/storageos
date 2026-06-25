'use client';

import { type AccessLogDto, type AccessResultValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import { useState } from 'react';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAccessLogs, useDevices } from '@/lib/access/hooks';

const METHOD_LABELS: Record<string, string> = { pin: 'PIN', qr: 'QR', rfid: 'RFID' };

const RESULT_LABELS: Record<AccessResultValue, { label: string; className: string }> = {
  allowed: { label: 'Permitido', className: 'bg-green-100 text-green-700' },
  denied_invalid_credential: { label: 'Credencial inválida', className: 'bg-red-100 text-red-700' },
  denied_inactive_credential: {
    label: 'Credencial inactiva',
    className: 'bg-orange-100 text-orange-700',
  },
  denied_outside_hours: { label: 'Fuera de horario', className: 'bg-orange-100 text-orange-700' },
  denied_wrong_facility: { label: 'Local incorrecto', className: 'bg-orange-100 text-orange-700' },
  denied_dunning: { label: 'Impago', className: 'bg-red-100 text-red-700' },
  denied_unknown: { label: 'Denegado', className: 'bg-red-100 text-red-700' },
  error: { label: 'Error', className: 'bg-slate-200 text-slate-800' },
};

const RESULTS = Object.keys(RESULT_LABELS) as AccessResultValue[];

export default function AccessLogsPage() {
  const [result, setResult] = useState<AccessResultValue | undefined>();
  const [deviceId, setDeviceId] = useState<string | undefined>();

  const logs = useAccessLogs({
    ...(result ? { result } : {}),
    ...(deviceId ? { deviceId } : {}),
  });
  const devices = useDevices();

  const columns: ColumnDef<AccessLogDto>[] = [
    {
      accessorKey: 'occurredAt',
      header: 'Fecha',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.original.occurredAt).toLocaleString('es-ES')}
        </span>
      ),
    },
    {
      accessorKey: 'customerName',
      header: 'Inquilino',
      cell: ({ row }) =>
        row.original.customerId ? (
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
        <span className="text-xs">{METHOD_LABELS[row.original.method] ?? row.original.method}</span>
      ),
    },
    {
      accessorKey: 'result',
      header: 'Resultado',
      cell: ({ row }) => {
        const r = RESULT_LABELS[row.original.result] ?? {
          label: row.original.result,
          className: 'bg-slate-100 text-slate-700',
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
            {row.original.reason}
          </Badge>
        ) : (
          '—'
        ),
    },
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
      </div>

      <DataTable
        columns={columns}
        data={logs.data ?? []}
        isLoading={logs.isLoading}
        searchPlaceholder="Buscar..."
        emptyText="No hay intentos de acceso registrados todavía."
      />
    </div>
  );
}
