'use client';

import { APPROVAL_ACTION_LABELS, type AdminApprovalRequestDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
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

/** Solicitudes de aprobación de este tenant (solo si hay alguna). */
export function ApprovalRequestsCard({ tenantId }: { tenantId: string }) {
  const q = useApprovals({ tenantId });
  const rows = q.data ?? [];
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Solicitudes de aprobación</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-md border p-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{APPROVAL_ACTION_LABELS[r.action]}</span>
              <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
            </div>
            <p className="text-muted-foreground">{r.summary}</p>
            <p className="text-xs text-muted-foreground">
              {r.requestedByName ?? '—'} · {new Date(r.createdAt).toLocaleString('es-ES')} ·{' '}
              {r.reason}
            </p>
            {r.decidedByName && (
              <p className="text-xs text-muted-foreground">
                Decidió {r.decidedByName}
                {r.decisionNote ? `: ${r.decisionNote}` : ''}
              </p>
            )}
            {r.error && <p className="text-xs text-destructive">{r.error}</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
