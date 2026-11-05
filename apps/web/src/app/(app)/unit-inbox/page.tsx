'use client';

import { UNIT_INBOX_LABELS, type UnitInboxItemDto, type UnitInboxKind } from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
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
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { downloadCsv } from '@/lib/csv';
import { formatDate } from '@/lib/format';
import { useAssignUnitInbox, useUnitInbox } from '@/lib/unit-ops/hooks';
import { useUsers } from '@/lib/users/hooks';

const KINDS = Object.keys(UNIT_INBOX_LABELS) as UnitInboxKind[];

function waited(days: number): string {
  if (days === 0) return 'Hoy';
  return days === 1 ? '1 día' : `${days} días`;
}

export default function UnitInboxPage() {
  const inbox = useUnitInbox();
  const users = useUsers();
  const assign = useAssignUnitInbox();
  const canAssign = useHasPermission('reservations:write');
  const [kind, setKind] = useState<UnitInboxKind | 'all'>('all');

  const rows = useMemo(
    () => (inbox.data?.items ?? []).filter((i) => kind === 'all' || i.kind === kind),
    [inbox.data, kind],
  );

  async function onAssign(item: UnitInboxItemDto, userId: string | null) {
    try {
      await assign.mutateAsync({ kind: item.kind, id: item.id, userId });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo asignar');
    }
  }

  function exportCsv() {
    downloadCsv('peticiones-de-trastero.csv', [
      ['Tipo', 'Quién', 'Qué', 'Local', 'Desde', 'Días esperando', 'Responsable'],
      ...rows.map((i) => [
        UNIT_INBOX_LABELS[i.kind],
        i.title,
        i.detail ?? '',
        i.facilityName ?? '',
        formatDate(i.since),
        i.ageDays,
        i.assignedToName ?? '',
      ]),
    ]);
  }

  const columns: ColumnDef<UnitInboxItemDto>[] = [
    {
      id: 'what',
      header: 'Petición',
      cell: ({ row }) => (
        <div>
          <Link href={row.original.link} className="font-medium hover:underline">
            {row.original.title}
          </Link>
          {row.original.detail && (
            <p className="line-clamp-2 max-w-md text-xs text-muted-foreground">
              {row.original.detail}
            </p>
          )}
        </div>
      ),
    },
    {
      id: 'kind',
      header: 'Tipo',
      cell: ({ row }) => <Badge variant="secondary">{UNIT_INBOX_LABELS[row.original.kind]}</Badge>,
    },
    {
      id: 'facility',
      header: 'Local',
      cell: ({ row }) => row.original.facilityName ?? '—',
    },
    {
      id: 'age',
      header: 'Esperando',
      cell: ({ row }) => (
        <span className={row.original.ageDays >= 3 ? 'font-medium text-amber-600' : undefined}>
          {waited(row.original.ageDays)}
          {row.original.dueAt ? ` · caduca el ${formatDate(row.original.dueAt)}` : ''}
        </span>
      ),
    },
    {
      id: 'assignee',
      header: 'Responsable',
      cell: ({ row }) =>
        canAssign ? (
          <Select
            value={row.original.assignedToUserId ?? 'none'}
            onValueChange={(v) => void onAssign(row.original, v === 'none' ? null : v)}
          >
            <SelectTrigger className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sin asignar</SelectItem>
              {(users.data ?? [])
                .filter((u) => u.isActive)
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.fullName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          (row.original.assignedToName ?? '—')
        ),
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Peticiones de trastero</h1>
        <p className="text-sm text-muted-foreground">
          Lo que espera respuesta: cambios, solicitudes, gente en cola con hueco libre y reservas a
          punto de caducar.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={kind === 'all' ? 'default' : 'outline'}
          onClick={() => setKind('all')}
        >
          Todas ({inbox.data?.items.length ?? 0})
        </Button>
        {KINDS.map((k) => (
          <Button
            key={k}
            size="sm"
            variant={kind === k ? 'default' : 'outline'}
            onClick={() => setKind(k)}
          >
            {UNIT_INBOX_LABELS[k]} ({inbox.data?.counts[k] ?? 0})
          </Button>
        ))}
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="mr-1 size-4" /> CSV
        </Button>
      </div>

      {inbox.isError ? (
        <SectionError onRetry={() => void inbox.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={inbox.isLoading}
          emptyText="Nada pendiente."
        />
      )}
    </div>
  );
}
