'use client';

import { AlarmClock, CreditCard, Loader2, MoonStar } from 'lucide-react';
import Link from 'next/link';

import type { AdminAtRiskTenantDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminAtRisk } from '@/lib/admin/hooks';

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-ES') : '—';
}

export default function AdminAtRiskPage() {
  const risk = useAdminAtRisk();

  if (risk.isError) {
    return <AdminError onRetry={() => void risk.refetch()} />;
  }
  if (risk.isLoading || !risk.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const d = risk.data;
  const total = d.trialExpiring.length + d.pastDue.length + d.inactive.length;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tenants en riesgo</h1>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? 'Ningún tenant en riesgo ahora mismo. 🎉'
            : `${total} tenant(s) que conviene atender. Pincha un tenant para actuar (extender trial, contactar…).`}
        </p>
      </div>

      <RiskSection
        title="Trials por expirar"
        subtitle="Prueba termina en los próximos 7 días"
        icon={AlarmClock}
        accent="text-amber-600"
        rows={d.trialExpiring}
        sinceLabel="Expira"
      />
      <RiskSection
        title="Pago fallido"
        subtitle="Suscripción en past_due"
        icon={CreditCard}
        accent="text-red-600"
        rows={d.pastDue}
        sinceLabel="Fin de periodo"
      />
      <RiskSection
        title="Inactivos"
        subtitle="Activos sin actividad de usuario en 14+ días"
        icon={MoonStar}
        accent="text-slate-500"
        rows={d.inactive}
        sinceLabel="Último acceso"
      />
    </div>
  );
}

function RiskSection({
  title,
  subtitle,
  icon: Icon,
  accent,
  rows,
  sinceLabel,
}: {
  title: string;
  subtitle: string;
  icon: typeof AlarmClock;
  accent: string;
  rows: AdminAtRiskTenantDto[];
  sinceLabel: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={`size-4 ${accent}`} />
          {title}
          <Badge variant={rows.length > 0 ? 'secondary' : 'outline'}>{rows.length}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Ninguno.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs text-muted-foreground">/{t.slug}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t.planName ?? 'sin plan'} · {t.detail}
                    {t.since ? ` · ${sinceLabel}: ${fmtDate(t.since)}` : ''}
                  </div>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/admin/tenants/${t.id}`}>Ver tenant</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
