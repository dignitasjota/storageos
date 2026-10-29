'use client';

import {
  AlarmClock,
  ArrowRight,
  BellOff,
  CreditCard,
  HeartPulse,
  LifeBuoy,
  Loader2,
  MoonStar,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import type { AdminAtRiskTenantDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminAtRisk, useRetentionPlaybook } from '@/lib/admin/hooks';
import { useRiskSnooze } from '@/lib/admin/tenant-tools-hooks';
import { ApiError } from '@/lib/auth/api';

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
  const total = d.trialExpiring.length + d.pastDue.length + d.inactive.length + d.lowHealth.length;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tenants en riesgo</h1>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? 'Ningún tenant en riesgo ahora mismo. 🎉'
            : `${total} tenant(s) que conviene atender. Pincha un tenant para actuar (extender trial, contactar…).`}
          {d.snoozedCount > 0 && ` ${d.snoozedCount} ignorado(s) por ahora.`}
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
      <RiskSection
        title="Salud baja"
        subtitle="Salud «en riesgo» o «dormida» que no sale arriba (mismo criterio que la página Salud)"
        icon={HeartPulse}
        accent="text-orange-600"
        rows={d.lowHealth}
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
                <div className="flex shrink-0 items-center gap-2">
                  <RetentionButton tenantId={t.id} tenantName={t.name} />
                  <SnoozeButton tenantId={t.id} tenantName={t.name} />
                  <Button
                    asChild
                    variant="outline"
                    size="icon"
                    aria-label="Ver tenant"
                    title="Ver tenant"
                  >
                    <Link href={`/admin/tenants/${t.id}`}>
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Botón «Playbook de retención»: con un clic crea un seguimiento, envía un
 * email de retención al owner y registra la gestión como interacción.
 */
function RetentionButton({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const playbook = useRetentionPlaybook();
  return (
    <Button
      variant="default"
      size="sm"
      disabled={playbook.isPending}
      onClick={() => {
        playbook.mutate(tenantId, {
          onSuccess: (res) => {
            toast.success('Playbook de retención lanzado', {
              description: `${tenantName}: seguimiento creado + email enviado a ${res.emailRecipients} destinatario(s).`,
            });
          },
          onError: () => {
            toast.error('No se pudo lanzar el playbook de retención.');
          },
        });
      }}
    >
      {playbook.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <LifeBuoy className="size-4" />
      )}
      Playbook
    </Button>
  );
}

/** «Ignorar» el tenant en esta lista unos días (con el motivo). */
function SnoozeButton({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const ask = useConfirm();
  const snooze = useRiskSnooze();
  async function run() {
    const res = await ask({
      title: `Ignorar ${tenantName} 30 días`,
      description: 'Deja de salir en esta lista durante 30 días. Queda anotado en su historial.',
      input: { label: 'Motivo', placeholder: 'Ya hablado: vuelve tras el verano' },
      confirmLabel: 'Ignorar',
    });
    if (!res || res.value.trim().length < 3) return;
    try {
      await snooze.mutateAsync({ tenantId, input: { days: 30, reason: res.value.trim() } });
      toast.success(`${tenantName} no saldrá aquí en 30 días.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo ignorar.');
    }
  }
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Ignorar 30 días"
      title="Ignorar 30 días"
      disabled={snooze.isPending}
      onClick={() => void run()}
    >
      <BellOff className="size-4" />
    </Button>
  );
}
