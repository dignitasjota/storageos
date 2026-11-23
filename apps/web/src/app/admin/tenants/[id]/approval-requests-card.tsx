'use client';

import { APPROVAL_ACTION_LABELS, type AdminApprovalRequestDto } from '@storageos/shared';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApprovals } from '@/lib/admin/hooks';

const STATUS: Record<
  AdminApprovalRequestDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  pending: { label: 'Pendiente', variant: 'secondary' },
  approved: { label: 'Aprobada', variant: 'default' },
  rejected: { label: 'Rechazada', variant: 'outline' },
  failed: { label: 'Falló', variant: 'destructive' },
};

/**
 * Solicitudes de aprobación de este tenant (solo si hay alguna): las pendientes
 * a la vista y las resueltas plegadas.
 */
export function ApprovalRequestsCard({ tenantId }: { tenantId: string }) {
  const q = useApprovals({ tenantId });
  const [showResolved, setShowResolved] = useState(false);
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  const pending = rows.filter((r) => r.status === 'pending');
  const resolved = rows.filter((r) => r.status !== 'pending');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Solicitudes de aprobación</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {pending.length === 0 && (
          <p className="text-sm text-muted-foreground">Ninguna pendiente.</p>
        )}
        {pending.map((r) => (
          <ApprovalRow key={r.id} r={r} />
        ))}
        {resolved.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="px-0 text-xs"
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? 'Ocultar las resueltas' : `Ver las resueltas (${resolved.length})`}
          </Button>
        )}
        {showResolved && resolved.map((r) => <ApprovalRow key={r.id} r={r} />)}
      </CardContent>
    </Card>
  );
}

function ApprovalRow({ r }: { r: AdminApprovalRequestDto }) {
  return (
    <div className="rounded-md border p-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{APPROVAL_ACTION_LABELS[r.action]}</span>
        <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
      </div>
      <p className="text-muted-foreground">{r.summary}</p>
      <p className="text-xs text-muted-foreground">
        {r.requestedByName ?? '—'} · {new Date(r.createdAt).toLocaleString('es-ES')} · {r.reason}
      </p>
      {(r.decidedByName || r.decisionNote) && (
        <p className="text-xs text-muted-foreground">
          {r.decidedByName ? `Decidió ${r.decidedByName}` : 'Sin decidir'}
          {r.decisionNote ? `: ${r.decisionNote}` : ''}
        </p>
      )}
      {r.error && <p className="text-xs text-destructive">{r.error}</p>}
    </div>
  );
}
