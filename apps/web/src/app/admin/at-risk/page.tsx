'use client';

import {
  AlarmClock,
  ArrowRight,
  BellOff,
  CalendarX,
  CreditCard,
  HeartPulse,
  LifeBuoy,
  Loader2,
  LogOut,
  MoonStar,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  AdminAtRiskRowDto,
  AdminAtRiskSnoozedDto,
  AtRiskKind,
  RetentionPlaybookReason,
} from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useAtRiskOverview,
  useLaunchPlaybook,
  usePlaybookPreview,
} from '@/lib/admin/tenant-ops-hooks';
import { useRiskSnooze } from '@/lib/admin/tenant-tools-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatEur, formatShortDay, plural } from '@/lib/format';

interface SectionDef {
  key: string;
  title: string;
  subtitle: string;
  icon: typeof AlarmClock;
  accent: string;
  sinceLabel: string;
  reason: AtRiskKind;
}

/** Secciones conocidas; una sección nueva de la API sale con el texto genérico. */
const SECTIONS: SectionDef[] = [
  {
    key: 'pastDue',
    title: 'Pago fallido',
    subtitle: 'La cuota no se ha podido cobrar',
    icon: CreditCard,
    accent: 'text-red-600',
    sinceLabel: 'Debe desde',
    reason: 'past_due',
  },
  {
    key: 'trialExpiring',
    title: 'Pruebas por terminar',
    subtitle: 'La prueba termina en los próximos 7 días',
    icon: AlarmClock,
    accent: 'text-amber-600',
    sinceLabel: 'Termina',
    reason: 'trial_expiring',
  },
  {
    key: 'trialExpired',
    title: 'Pruebas caducadas sin pagar',
    subtitle: 'Terminó la prueba y siguen en solo lectura',
    icon: CalendarX,
    accent: 'text-amber-700',
    sinceLabel: 'Terminó',
    reason: 'trial_expired',
  },
  {
    key: 'scheduledEnd',
    title: 'Baja programada',
    subtitle: 'Tienen una baja o una anonimización con fecha',
    icon: LogOut,
    accent: 'text-red-700',
    sinceLabel: 'Fecha',
    reason: 'scheduled_end',
  },
  {
    key: 'cancelAtPeriodEnd',
    title: 'Cancelará al final del periodo',
    subtitle: 'Pidieron no renovar: se van al acabar lo que han pagado',
    icon: LogOut,
    accent: 'text-orange-600',
    sinceLabel: 'Acaba',
    reason: 'cancel_at_period_end',
  },
  {
    key: 'inactive',
    title: 'Inactivos',
    subtitle: 'Pagan pero nadie de su equipo entra desde hace 14 días o más',
    icon: MoonStar,
    accent: 'text-slate-500',
    sinceLabel: 'Último acceso',
    reason: 'inactive',
  },
  {
    key: 'lowHealth',
    title: 'Salud baja',
    subtitle:
      'Salud «en riesgo» o «dormida» que no sale arriba (mismo criterio que la página Salud)',
    icon: HeartPulse,
    accent: 'text-orange-600',
    sinceLabel: 'Último acceso',
    reason: 'low_health',
  },
];

const CONTACT_LABELS: Record<string, string> = {
  call: 'llamada',
  email: 'correo',
  meeting: 'reunión',
  whatsapp: 'WhatsApp',
  note: 'nota',
  support: 'ticket',
};

export default function AdminAtRiskPage() {
  const risk = useAtRiskOverview();
  const [playbook, setPlaybook] = useState<{
    row: AdminAtRiskRowDto;
    reason: RetentionPlaybookReason;
  } | null>(null);

  if (risk.isError) return <AdminError onRetry={() => void risk.refetch()} />;
  if (risk.isLoading || !risk.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const d = risk.data as unknown as Record<string, unknown> & {
    monthlyAtStake: number;
    snoozedCount: number;
    snoozed: AdminAtRiskSnoozedDto[];
  };
  const sections = Object.entries(d)
    .filter((e): e is [string, AdminAtRiskRowDto[]] => e[0] !== 'snoozed' && Array.isArray(e[1]))
    .map(([key, rows]) => ({
      def:
        SECTIONS.find((s) => s.key === key) ??
        ({
          key,
          title: key,
          subtitle: '',
          icon: AlarmClock,
          accent: 'text-muted-foreground',
          sinceLabel: 'Desde',
          reason: 'low_health',
        } satisfies SectionDef),
      rows,
      total: rows.reduce((s, r) => s + (r.monthly ?? 0), 0),
    }))
    // Primero donde hay más dinero en juego.
    .sort((a, b) => b.total - a.total || b.rows.length - a.rows.length);
  const tenants = new Set(sections.flatMap((s) => s.rows.map((r) => r.id))).size;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">En riesgo</h1>
        <p className="text-sm text-muted-foreground">
          {tenants === 0
            ? 'Ningún cliente en riesgo ahora mismo. 🎉'
            : `${plural(tenants, 'cliente', 'clientes')} que conviene atender, de más dinero en juego a menos.`}
          {d.snoozedCount > 0 &&
            ` ${plural(d.snoozedCount, 'ignorado', 'ignorados')} por ahora (abajo).`}
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-4">
          <span className="text-sm text-muted-foreground">Cuota al mes en juego</span>
          <span className="text-2xl font-semibold">{formatEur(d.monthlyAtStake)}</span>
          <span className="text-xs text-muted-foreground">sin IVA · en pruebas, la del plan</span>
        </CardContent>
      </Card>

      {sections.map(({ def, rows, total }) => (
        <RiskSection
          key={def.key}
          def={def}
          rows={rows}
          total={total}
          onPlaybook={(row) => setPlaybook({ row, reason: def.reason })}
        />
      ))}

      <SnoozedSection rows={d.snoozed ?? []} />

      <PlaybookDialog target={playbook} onClose={() => setPlaybook(null)} />
    </div>
  );
}

function RiskSection({
  def,
  rows,
  total,
  onPlaybook,
}: {
  def: SectionDef;
  rows: AdminAtRiskRowDto[];
  total: number;
  onPlaybook: (row: AdminAtRiskRowDto) => void;
}) {
  const Icon = def.icon;
  const canEdit = useIsSuperadmin();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Icon className={`size-4 ${def.accent}`} />
          {def.title}
          <Badge variant={rows.length > 0 ? 'secondary' : 'outline'}>{rows.length}</Badge>
          {total > 0 ? (
            <span className="ml-auto text-sm font-normal text-muted-foreground">
              {formatEur(total)}/mes
            </span>
          ) : null}
        </CardTitle>
        {def.subtitle ? <p className="text-xs text-muted-foreground">{def.subtitle}</p> : null}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Ninguno.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((t) => (
              <li key={t.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/tenants/${t.id}`} className="font-medium hover:underline">
                      {t.name}
                    </Link>
                    <span className="text-sm font-medium">{formatEur(t.monthly)}/mes</span>
                    {t.expired ? <Badge variant="destructive">Vencida</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t.planName ?? 'sin plan'} · {t.detail}
                    {t.since ? ` · ${def.sinceLabel}: ${formatShortDay(t.since)}` : ''}
                    {t.playbookAt ? ` · Playbook lanzado el ${formatShortDay(t.playbookAt)}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t.ownerName
                      ? `Lo lleva ${t.ownerName}${t.ownerSource === 'sales' ? ' (comercial)' : ''}`
                      : 'Sin responsable'}
                    {' · '}
                    {t.lastContactAt
                      ? `Último contacto: ${formatShortDay(t.lastContactAt)}${
                          t.lastContactType
                            ? ` (${CONTACT_LABELS[t.lastContactType] ?? t.lastContactType})`
                            : ''
                        }`
                      : 'Sin contactos anotados'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {canEdit ? (
                    <Button
                      size="sm"
                      onClick={() => onPlaybook(t)}
                      disabled={!!t.playbookAt}
                      title={
                        t.playbookAt
                          ? `Ya se lanzó el ${formatShortDay(t.playbookAt)}: espera 14 días para repetirlo.`
                          : 'Seguimiento a 3 días y correo de retención'
                      }
                    >
                      <LifeBuoy className="mr-1 size-4" /> Playbook
                    </Button>
                  ) : null}
                  <SnoozeButton
                    tenantId={t.id}
                    tenantName={t.name}
                    kind={def.reason}
                    sectionTitle={def.title}
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

/** Playbook de retención con el correo propio del motivo y vista previa. */
function PlaybookDialog({
  target,
  onClose,
}: {
  target: { row: AdminAtRiskRowDto; reason: RetentionPlaybookReason } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {target ? <PlaybookForm key={target.row.id} target={target} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PlaybookForm({
  target,
  onClose,
}: {
  target: { row: AdminAtRiskRowDto; reason: RetentionPlaybookReason };
  onClose: () => void;
}) {
  const [message, setMessage] = useState('');
  const [debounced, setDebounced] = useState('');
  const preview = usePlaybookPreview(target.row.id, target.reason, debounced);
  const launch = useLaunchPlaybook();

  async function run() {
    try {
      const res = await launch.mutateAsync({
        tenantId: target.row.id,
        reason: target.reason,
        message,
      });
      toast.success('Playbook lanzado', {
        description:
          res.emailRecipients > 0
            ? `Seguimiento creado y correo enviado a ${plural(res.emailRecipients, 'persona', 'personas')}.`
            : 'Seguimiento creado. No tiene a quién escribir: no se ha enviado correo.',
      });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo lanzar el playbook.');
    }
  }

  const p = preview.data;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Playbook de retención · {target.row.name}</DialogTitle>
        <DialogDescription>
          Crea un seguimiento para dentro de 3 días y envía este correo a sus propietarios. No se
          repite en 14 días.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="pb-msg">Tu mensaje (opcional, va al principio)</Label>
          <Textarea
            id="pb-msg"
            value={message}
            maxLength={2000}
            onChange={(e) => setMessage(e.target.value)}
            onBlur={() => setDebounced(message)}
            placeholder="Te llamé ayer y no pudimos hablar…"
          />
        </div>
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          {preview.isLoading || !p ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Para:{' '}
                {p.recipients.length
                  ? p.recipients.join(', ')
                  : 'nadie (no tiene a quién escribir)'}
              </p>
              <p className="mt-1 font-medium">{p.subject}</p>
              <p className="mt-2 whitespace-pre-line text-muted-foreground">{p.body}</p>
            </>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={() => void run()} disabled={launch.isPending}>
          {launch.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
          Lanzar playbook
        </Button>
      </DialogFooter>
    </>
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
      await snooze.mutateAsync({ tenantId, input: { days: 30, reason: res.value.trim(), kind } });
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
                    {r.kind
                      ? (SECTIONS.find((x) => x.reason === r.kind)?.title ?? r.kind)
                      : 'Todas las secciones'}{' '}
                    · hasta el {formatShortDay(r.until)}
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
