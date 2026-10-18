'use client';

import { APPROVAL_ACTION_LABELS, type AdminApprovalRequestDto } from '@storageos/shared';
import { ShieldQuestion } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { useConfirm } from '@/components/admin/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDecideApproval } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

/** Solicitudes del rol soporte pendientes de aprobar (en el «Hoy»). */
export function ApprovalsSection({ items }: { items: AdminApprovalRequestDto[] }) {
  const canDecide = useIsSuperadmin();
  const decide = useDecideApproval();
  const confirm = useConfirm();
  if (items.length === 0) return null;

  async function onDecide(r: AdminApprovalRequestDto, decision: 'approve' | 'reject') {
    const res = await confirm({
      title: decision === 'approve' ? 'Aprobar y aplicar' : 'Rechazar la solicitud',
      description: `${APPROVAL_ACTION_LABELS[r.action]} · ${r.tenantName}: ${r.summary}`,
      confirmLabel: decision === 'approve' ? 'Aprobar' : 'Rechazar',
      destructive: decision === 'reject',
      input: { label: 'Nota (opcional)', placeholder: 'Se la verá quien lo pidió' },
    });
    if (!res) return;
    try {
      const out = await decide.mutateAsync({
        id: r.id,
        decision,
        ...(res.value?.trim() ? { note: res.value.trim() } : {}),
      });
      if (out.status === 'failed') toast.error(`Aprobada, pero no se pudo aplicar: ${out.error}`);
      else toast.success(decision === 'approve' ? 'Aprobada y aplicada.' : 'Rechazada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo resolver.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldQuestion className="size-4 text-amber-500" />
          Solicitudes por aprobar ({items.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((r) => (
          <div
            key={r.id}
            className="flex flex-col gap-2 rounded-md border p-2 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <span className="font-medium">{APPROVAL_ACTION_LABELS[r.action]}</span>
              <span className="text-muted-foreground"> · </span>
              <Link href={`/admin/tenants/${r.tenantId}`} className="hover:underline">
                {r.tenantName}
              </Link>
              <p className="text-muted-foreground">{r.summary}</p>
              <p className="text-xs text-muted-foreground">
                {r.requestedByName ?? '—'}: {r.reason}
              </p>
            </div>
            {canDecide && (
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() => void onDecide(r, 'reject')}
                >
                  Rechazar
                </Button>
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => void onDecide(r, 'approve')}
                >
                  Aprobar
                </Button>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
