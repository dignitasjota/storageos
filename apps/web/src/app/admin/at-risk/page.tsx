'use client';

import {
  AlarmClock,
  ArrowRight,
  BellOff,
  CreditCard,
  HeartPulse,
  Hourglass,
  LifeBuoy,
  Loader2,
  MoonStar,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminAtRiskSnoozedDto, AdminAtRiskTenantDto, AtRiskKind } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminAtRisk, useRetentionPlaybook } from '@/lib/admin/hooks';
import { useRiskSnooze } from '@/lib/admin/tenant-tools-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { plural } from '@/lib/format';

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-ES') : '—';
}

/** Nombre de cada sección (para «Ignorados»). */
const KIND_LABELS: Record<AtRiskKind, string> = {
  trial_expiring: 'Pruebas por terminar',
  past_due: 'Pago fallido',
  inactive: 'Inactivos',
  low_health: 'Salud baja',
  trial_expired: 'Pruebas caducadas sin pagar',
};

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
  const total =
    d.trialExpiring.length +
    d.pastDue.length +
    d.inactive.length +
    d.trialExpired.length +
    d.lowHealth.length;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tenants en riesgo</h1>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? 'Ningún tenant en riesgo ahora mismo. 🎉'
            : `${plural(total, 'tenant', 'tenants')} que conviene atender.`}
          {d.snoozedCount > 0 &&
            ` ${plural(d.snoozedCount, 'ignorado', 'ignorados')} por ahora (abajo).`}
        </p>
      </div>

      <RiskSection
        kind="trial_expiring"
        title="Pruebas por terminar"
        subtitle="La prueba termina en los próximos 7 días (o ya venció y falta cerrarla)"
        icon={AlarmClock}
        accent="text-amber-600"
        rows={d.trialExpiring}
        sinceLabel="Termina"
      />
      <RiskSection
        kind="past_due"
        title="Pago fallido"
        subtitle="La cuota no se ha podido cobrar"
        icon={CreditCard}
        accent="text-red-600"
        rows={d.pastDue}
        sinceLabel="Debe desde"
      />
      <RiskSection
        kind="trial_expired"
        title="Pruebas caducadas sin pagar"
        subtitle="La prueba terminó y no ha pagado: está en solo lectura"
        icon={Hourglass}
        accent="text-amber-700"
        rows={d.trialExpired}
        sinceLabel="Terminó"
      />
      <RiskSection
        kind="inactive"
        title="Inactivos"
        subtitle="Clientes de pago (con más de 14 días de alta) sin que nadie entre en 14+ días"
        icon={MoonStar}
        accent="text-slate-500"
        rows={d.inactive}
        sinceLabel="Último acceso"
      />
      <RiskSection
        kind="low_health"
        title="Salud baja"
        subtitle="Salud «en riesgo» o «dormida» que no sale arriba (mismo criterio que la página Salud)"
        icon={HeartPulse}
        accent="text-orange-600"
        rows={d.lowHealth}
        sinceLabel="Último acceso"
      />
      <SnoozedSection rows={d.snoozed} />
    </div>
  );
}

/** Los ignorados ahora mismo: en qué sección, hasta cuándo y por qué. */
function SnoozedSection({ rows }: { rows: AdminAtRiskSnoozedDto[] }) {
  const [open, setOpen] = useState(false);
  const snooze = useRiskSnooze();
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 text-left text-base font-semibold"
        >
          <BellOff className="size-4 text-muted-foreground" />
          Ignorados
          <Badge variant="secondary">{rows.length}</Badge>
          <span className="text-xs font-normal text-muted-foreground">
            {open ? 'Ocultar' : 'Ver'}
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent>
          <ul className="divide-y">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <Link href={`/admin/tenants/${r.id}`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {r.kind ? (KIND_LABELS[r.kind as AtRiskKind] ?? r.kind) : 'Todas las secciones'}{' '}
                    · hasta el {fmtDate(r.until)}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={snooze.isPending}
                  onClick={() =>
                    snooze.mutate(
                      { tenantId: r.id, input: null },
                      {
                        onSuccess: () => toast.success(`${r.name} vuelve a salir.`),
                        onError: (err) =>
                          toast.error(
                            err instanceof ApiError ? err.body.message : 'No se pudo cambiar.',
                          ),
                      },
                    )
                  }
                >
                  Volver a mostrar
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function RiskSection({
  kind,
  title,
  subtitle,
  icon: Icon,
  accent,
  rows,
  sinceLabel,
}: {
  kind: AtRiskKind;
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
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/tenants/${t.id}`} className="font-medium hover:underline">
                      {t.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">/{t.slug}</span>
                    {t.expired && <Badge variant="destructive">Vencida</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t.planName ?? 'sin plan'} · {t.detail}
                    {t.since ? ` · ${sinceLabel}: ${fmtDate(t.since)}` : ''}
                    {t.playbookAt ? ` · Playbook lanzado el ${fmtDate(t.playbookAt)}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <RetentionButton
                    tenantId={t.id}
                    tenantName={t.name}
                    playbookAt={t.playbookAt ?? null}
                  />
                  <SnoozeButton
                    tenantId={t.id}
                    tenantName={t.name}
                    kind={kind}
                    sectionTitle={title}
                  />
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
function RetentionButton({
  tenantId,
  tenantName,
  playbookAt,
}: {
  tenantId: string;
  tenantName: string;
  playbookAt: string | null;
}) {
  const playbook = useRetentionPlaybook();
  const ask = useConfirm();
  // El rol soporte no lo lanza (le daría 403).
  const canLaunch = useIsSuperadmin();
  if (!canLaunch) return null;
  return (
    <Button
      variant="default"
      size="sm"
      disabled={playbook.isPending || !!playbookAt}
      title={
        playbookAt
          ? `Ya se lanzó el ${fmtDate(playbookAt)}: espera 14 días para repetirlo.`
          : undefined
      }
      onClick={async () => {
        const ok = await ask({
          title: `¿Lanzar el playbook de retención con ${tenantName}?`,
          description:
            'Crea un seguimiento para dentro de 3 días y le envía un correo de retención a sus propietarios.',
        });
        if (!ok) return;
        playbook.mutate(tenantId, {
          onSuccess: (res) => {
            toast.success('Playbook de retención lanzado', {
              description:
                res.emailRecipients > 0
                  ? `${tenantName}: seguimiento creado y correo encolado para ${plural(
                      res.emailRecipients,
                      'destinatario',
                      'destinatarios',
                    )}.`
                  : `${tenantName}: seguimiento creado. No tiene a quién escribir: no se ha enviado correo.`,
            });
          },
          onError: (err) => {
            toast.error(
              err instanceof ApiError
                ? err.body.message
                : 'No se pudo lanzar el playbook de retención.',
            );
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

/** «Ignorar» el tenant en esta sección unos días (con el motivo). */
function SnoozeButton({
  tenantId,
  tenantName,
  kind,
  sectionTitle,
}: {
  tenantId: string;
  tenantName: string;
  kind: AtRiskKind;
  sectionTitle: string;
}) {
  const ask = useConfirm();
  const snooze = useRiskSnooze();
  async function run() {
    const res = await ask({
      title: `Ignorar ${tenantName} 30 días`,
      description: `Deja de salir en «${sectionTitle}» durante 30 días (si aparece por otro motivo, sí sale). En «Hoy» sigue saliendo. Queda anotado en su historial.`,
      input: { label: 'Motivo', placeholder: 'Ya hablado: vuelve tras el verano' },
      confirmLabel: 'Ignorar',
    });
    if (!res || res.value.trim().length < 3) return;
    try {
      await snooze.mutateAsync({
        tenantId,
        input: { days: 30, reason: res.value.trim(), kind },
      });
      toast.success(`${tenantName} no saldrá en «${sectionTitle}» en 30 días.`);
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
