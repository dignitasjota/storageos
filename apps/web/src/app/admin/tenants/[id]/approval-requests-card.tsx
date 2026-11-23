'use client';

import { APPROVAL_ACTION_LABELS, type AdminApprovalRequestDto } from '@storageos/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApprovals, useDecideApproval } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

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
  const canDecide = useIsSuperadmin() && r.status === 'pending';
  const decide = useDecideApproval();
  const ask = useConfirm();
  const changed = r.changedSinceRequest ?? [];

  async function run(decision: 'approve' | 'reject') {
    const res = await ask({
      title: decision === 'approve' ? 'Aprobar y ejecutar' : 'Rechazar la solicitud',
      description:
        decision === 'approve'
          ? `${r.summary}${changed.length ? ` · Ojo: desde que se pidió ha cambiado ${changed.join('; ')}.` : ''}`
          : r.summary,
      confirmLabel: decision === 'approve' ? 'Aprobar' : 'Rechazar',
      destructive: decision === 'reject',
      input: { label: 'Nota (opcional)' },
    });
    if (!res) return;
    try {
      const out = await decide.mutateAsync({
        id: r.id,
        decision,
        ...(res.value.trim() ? { note: res.value.trim() } : {}),
      });
      if (out.status === 'failed') toast.error(`Aprobada, pero falló: ${out.error ?? ''}`);
      else toast.success(decision === 'approve' ? 'Aprobada y hecha.' : 'Rechazada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo decidir.');
    }
  }

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
      {r.currentState && <p className="text-xs text-muted-foreground">Ahora: {r.currentState}</p>}
      {changed.length > 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 p-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Ha cambiado desde que se pidió: {changed.join(' · ')}
        </p>
      )}
      {canDecide && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => void run('approve')} disabled={decide.isPending}>
            Aprobar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void run('reject')}
            disabled={decide.isPending}
          >
            Rechazar
          </Button>
        </div>
      )}
    </div>
  );
}
