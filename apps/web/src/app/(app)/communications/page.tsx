'use client';

import { type CommunicationDto, type CommunicationStatusValue } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCommunications, useRetryCommunication } from '@/lib/communications/hooks';

const STATUS_LABELS: Record<CommunicationStatusValue, { label: string; variant: string }> = {
  pending: { label: 'Pendiente', variant: 'secondary' },
  processing: { label: 'Enviando', variant: 'default' },
  sent: { label: 'Enviada', variant: 'default' },
  delivered: { label: 'Entregada', variant: 'default' },
  bounced: { label: 'Rebote', variant: 'destructive' },
  failed: { label: 'Fallida', variant: 'destructive' },
  skipped: { label: 'Cancelada', variant: 'outline' },
};

export default function CommunicationsPage() {
  const [status, setStatus] = useState<CommunicationStatusValue | undefined>();
  const [channel, setChannel] = useState<string | undefined>();
  const communications = useCommunications({
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
  });
  const retry = useRetryCommunication();

  const columns: ColumnDef<CommunicationDto>[] = [
    {
      accessorKey: 'createdAt',
      header: 'Fecha',
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleString('es-ES'),
    },
    { accessorKey: 'channel', header: 'Canal' },
    { accessorKey: 'recipient', header: 'Destinatario' },
    { accessorKey: 'subject', header: 'Asunto', cell: ({ row }) => row.original.subject ?? '—' },
    {
      accessorKey: 'source',
      header: 'Origen',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">{row.original.source ?? '—'}</span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Estado',
      cell: ({ row }) => {
        const s = STATUS_LABELS[row.original.status];
        return <Badge>{s.label}</Badge>;
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        if (row.original.status === 'failed' || row.original.status === 'bounced') {
          return (
            <Button
              size="sm"
              variant="outline"
              onClick={() => retry.mutate(row.original.id)}
              disabled={retry.isPending}
            >
              Reintentar
            </Button>
          );
        }
        return null;
      },
    },
  ];

  if (communications.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Comunicaciones</h1>
        <p className="text-sm text-muted-foreground">
          Historial de envíos (emails, WhatsApp, SMS). Las fallidas se pueden reintentar
          manualmente.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
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
            <SelectItem value="sms">SMS</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={communications.data ?? []}
        isLoading={communications.isLoading}
        searchPlaceholder="Buscar destinatario..."
        emptyText="Aún no hay comunicaciones."
      />
    </div>
  );
}
