'use client';

import { Eye, Loader2, Send } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import type { AdminAddonOpportunityDto, AdminOpportunityCandidateDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { ProposeAddonDialog } from '@/components/admin/propose-addon-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminOpportunities } from '@/lib/admin/hooks';
import { tenantStatusLabel } from '@/lib/admin/labels';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');

/**
 * Oportunidades de venta de extras: por cada extra, los tenants que no lo
 * tienen y tienen motivos para quererlo (han entrado en la función sin tenerla
 * o su uso lo pide). Desde aquí se les propone en un clic.
 */
export default function OpportunitiesPage() {
  const data = useAdminOpportunities();
  const [onlyInterest, setOnlyInterest] = useState(false);
  const [target, setTarget] = useState<{
    addon: AdminAddonOpportunityDto;
    candidate: AdminOpportunityCandidateDto;
  } | null>(null);

  if (data.isError) return <AdminError onRetry={() => void data.refetch()} />;
  const list = (data.data ?? [])
    .map((a) => ({
      ...a,
      candidates: onlyInterest ? a.candidates.filter((c) => c.interestCount > 0) : a.candidates,
    }))
    .filter((a) => a.candidates.length > 0);
  const interested = (data.data ?? []).reduce(
    (n, a) => n + a.candidates.filter((c) => c.interestCount > 0).length,
    0,
  );

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Oportunidades</h1>
          <p className="text-sm text-muted-foreground">
            A quién ofrecer cada extra: han entrado en la función sin tenerla o su uso lo pide.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOnlyInterest((v) => !v)}
          aria-pressed={onlyInterest}
          className={`h-9 rounded-md border px-3 text-sm ${
            onlyInterest ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground'
          }`}
        >
          Solo con interés ({interested})
        </button>
      </div>

      {data.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Ahora mismo no hay candidatos.
          </CardContent>
        </Card>
      ) : (
        list.map((a) => (
          <Card key={a.addonId}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                <span>
                  {a.addonName}{' '}
                  <span className="text-sm font-normal text-muted-foreground">
                    · {eur(a.priceMonthly)}/mes
                  </span>
                </span>
                <span className="text-sm font-normal text-muted-foreground">
                  {a.candidates.length} {a.candidates.length === 1 ? 'candidato' : 'candidatos'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y">
                {a.candidates.map((c) => (
                  <CandidateRow
                    key={c.tenantId}
                    c={c}
                    onPropose={() => setTarget({ addon: a, candidate: c })}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}

      <ProposeAddonDialog
        tenantId={target?.candidate.tenantId ?? ''}
        tenantName={target?.candidate.tenantName ?? ''}
        addon={
          target
            ? {
                id: target.addon.addonId,
                name: target.addon.addonName,
                priceMonthly: target.addon.priceMonthly,
              }
            : null
        }
        canTrial={!!target?.addon.feature}
        open={!!target}
        onOpenChange={(v) => !v && setTarget(null)}
      />
    </div>
  );
}

function CandidateRow({
  c,
  onPropose,
}: {
  c: AdminOpportunityCandidateDto;
  onPropose: () => void;
}) {
  const canEdit = useIsSuperadmin();
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/admin/tenants/${c.tenantId}`} className="font-medium hover:underline">
            {c.tenantName}
          </Link>
          <Badge variant="outline">{tenantStatusLabel(c.tenantStatus)}</Badge>
          {c.planName && <span className="text-xs text-muted-foreground">{c.planName}</span>}
          {c.interestCount > 0 && (
            <Badge className="bg-amber-500 text-white hover:bg-amber-500">
              Interés · {c.interestCount}
            </Badge>
          )}
        </div>
        <ul className="text-xs text-muted-foreground">
          {c.reasons.map((r) => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
        {c.lastOfferAt && (
          <p className="text-xs text-muted-foreground">Propuesto el {day(c.lastOfferAt)}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" onClick={onPropose} disabled={!canEdit}>
          <Send className="mr-1.5 size-4" /> Proponer
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href={`/admin/tenants/${c.tenantId}`} aria-label="Ver tenant">
            <Eye className="size-4" />
          </Link>
        </Button>
      </div>
    </li>
  );
}
