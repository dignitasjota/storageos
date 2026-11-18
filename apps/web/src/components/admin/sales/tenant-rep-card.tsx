'use client';

import { SALES_SOURCE_LABELS } from '@storageos/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { errorText } from './common';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAccountRep, useAssignSalesAccount, useSalesTeam } from '@/lib/admin/sales-team-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { formatDate } from '@/lib/format';

const NONE = '-';

/** Comercial de la cuenta: quién la lleva, desde cuándo y por qué (y cambiarlo). */
export function TenantRepCard({ tenantId }: { tenantId: string }) {
  const isSuperadmin = useIsSuperadmin();
  const rep = useAccountRep(tenantId, isSuperadmin);
  const team = useSalesTeam(isSuperadmin);
  const assign = useAssignSalesAccount();
  const [repId, setRepId] = useState(NONE);
  useEffect(() => setRepId(rep.data?.repId ?? NONE), [rep.data?.repId]);
  if (!isSuperadmin || !rep.data) return null;
  const r = rep.data;
  const reps = (team.data?.reps ?? []).filter((x) => x.isActive || x.id === r.repId);

  async function save() {
    try {
      await assign.mutateAsync({ tenantId, repId: repId === NONE ? null : repId });
      toast.success(repId === NONE ? 'La cuenta queda sin comercial.' : 'Comercial asignado.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Comercial</CardTitle>
        <CardDescription>
          {r.repId ? (
            <>
              <Link
                href={`/admin/sales-team/${r.repId}`}
                className="font-medium text-foreground hover:underline"
              >
                {r.repName}
              </Link>
              {!r.repActive && ' (desactivado)'}
              {r.source && ` · ${SALES_SOURCE_LABELS[r.source] ?? r.source}`}
              {r.assignedAt && ` · desde ${formatDate(r.assignedAt)}`}
            </>
          ) : (
            'Sin comercial: no genera comisiones.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {r.profile?.status && <p>{r.profile.status}</p>}
        {r.profile?.pinnedNote && (
          <p className="text-muted-foreground">📌 {r.profile.pinnedNote}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={repId} onValueChange={setRepId}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sin comercial</SelectItem>
              {reps.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={assign.isPending || repId === (r.repId ?? NONE)}
            onClick={() => void save()}
          >
            Cambiar
          </Button>
        </div>
        {r.history.length > 1 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Historial</summary>
            <ul className="mt-1 space-y-0.5 text-xs">
              {r.history.map((h, i) => (
                <li key={i}>
                  {h.repName} · {h.source} · {formatDate(h.startedAt)}
                  {h.endedAt ? ` → ${formatDate(h.endedAt)}` : ' → hoy'}
                  {h.endedReason && ` (${h.endedReason})`}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
