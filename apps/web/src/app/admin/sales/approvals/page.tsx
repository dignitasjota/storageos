'use client';

import { APPROVAL_ACTION_LABELS } from '@storageos/shared';
import { Loader2 } from 'lucide-react';

import { Empty, PageHeader, QueryError, SalesPage } from '@/components/admin/sales/common';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useSalesApprovals } from '@/lib/admin/sales-hooks';
import { formatDate } from '@/lib/format';

const STATUS: Record<
  string,
  { label: string; variant: 'default' | 'outline' | 'destructive' | 'secondary' }
> = {
  pending: { label: 'Esperando', variant: 'outline' },
  approved: { label: 'Aprobada', variant: 'default' },
  rejected: { label: 'Rechazada', variant: 'destructive' },
  failed: { label: 'No se pudo aplicar', variant: 'destructive' },
  cancelled: { label: 'Cancelada', variant: 'secondary' },
};

export default function SalesApprovalsPage() {
  const approvals = useSalesApprovals();
  const rows = approvals.data ?? [];
  return (
    <SalesPage>
      <PageHeader
        title="Peticiones a la dirección"
        description="Lo que has pedido para tus clientes (cambios de plan, precios especiales, más días de prueba). Te avisamos cuando se decide."
      />
      {approvals.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : approvals.isError ? (
        <QueryError query={approvals} />
      ) : rows.length === 0 ? (
        <Empty>No has pedido nada todavía. Se pide desde la ficha de cada cliente.</Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Petición</TableHead>
                <TableHead className="hidden md:table-cell">Fecha</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const st = STATUS[r.status] ?? { label: r.status, variant: 'outline' as const };
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.tenantName}</TableCell>
                    <TableCell className="text-sm">
                      {APPROVAL_ACTION_LABELS[r.action] ?? r.action}: {r.summary}
                      <span className="block text-xs text-muted-foreground">{r.reason}</span>
                      {r.decisionNote && (
                        <span className="block text-xs">Respuesta: {r.decisionNote}</span>
                      )}
                      {r.error && <span className="block text-xs text-destructive">{r.error}</span>}
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">
                      {formatDate(r.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={st.variant}>{st.label}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SalesPage>
  );
}
