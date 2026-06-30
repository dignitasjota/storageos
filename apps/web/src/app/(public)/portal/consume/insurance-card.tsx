'use client';

import { Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { InsurancePlanDto, PortalContractDto, PortalSessionDto } from '@storageos/shared';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, apiFetch } from '@/lib/auth/api';

const NONE = 'none';

export function InsuranceCard({
  session,
  contracts,
  onContractsChange,
}: {
  session: PortalSessionDto;
  contracts: PortalContractDto[];
  onContractsChange: (c: PortalContractDto[]) => void;
}) {
  const [plans, setPlans] = useState<InsurancePlanDto[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<InsurancePlanDto[]>('/portal/me/insurance-plans', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then((p) => {
        if (!cancelled) setPlans(p);
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  async function apply(contractId: string, value: string) {
    const planId = value === NONE ? null : value;
    setBusyId(contractId);
    try {
      const updated = await apiFetch<PortalContractDto[]>(
        `/portal/me/contracts/${contractId}/insurance`,
        {
          method: 'PUT',
          json: { planId },
          headers: { Authorization: `Bearer ${session.accessToken}` },
          requiresAuth: false,
        },
      );
      onContractsChange(updated);
      toast.success(planId ? 'Protección contratada.' : 'Protección cancelada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo actualizar.');
    } finally {
      setBusyId(null);
    }
  }

  const active = contracts.filter((c) => c.status === 'active' || c.status === 'ending');
  if (!plans || plans.length === 0 || active.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" /> Protección de contenido
        </CardTitle>
        <CardDescription>
          Protege lo que guardas. La prima se añade a tu factura mensual.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {plans.map((p) => (
            <div key={p.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="tabular-nums">{p.monthlyPrice.toFixed(2)} €/mes</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Cobertura hasta {p.coverageAmount.toFixed(0)} €
                {p.description ? ` · ${p.description}` : ''}
              </p>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          {active.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            >
              <div className="text-sm">
                <p className="font-medium">
                  {c.unitCode} · {c.facilityName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.insurancePlanName
                    ? `Protegido: ${c.insurancePlanName}`
                    : 'Sin protección contratada'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {busyId === c.id && <Loader2 className="h-4 w-4 animate-spin" />}
                <Select
                  value={c.insurancePlanId ?? NONE}
                  onValueChange={(v) => apply(c.id, v)}
                  disabled={busyId === c.id}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Sin protección</SelectItem>
                    {plans.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.monthlyPrice.toFixed(2)} €)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
