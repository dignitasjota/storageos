'use client';

import { ExternalLink, Loader2, MonitorPlay, Plus, RotateCcw, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PlatformSalesSettingsDto } from '@storageos/shared';

import {
  Empty,
  errorText,
  Field,
  PageHeader,
  QueryError,
  QueryState,
  relativeDays,
  SalesPage,
  Stat,
} from '@/components/admin/sales/common';
import { DemoExtraLinks } from '@/components/admin/sales/demo-links';
import { DistributeDialog } from '@/components/admin/sales/distribute-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useCreateSalesRep,
  useDemoAction,
  useOpenDemoAsAdmin,
  useOpenDemoPortalAsAdmin,
  useSalesBatches,
  useSalesSettings,
  useSalesTeam,
  useSaveSalesSettings,
  useTeamComparison,
  useTeamForecast,
} from '@/lib/admin/sales-team-hooks';
import { openImpersonationTab } from '@/lib/auth/impersonation';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';
import { cn } from '@/lib/utils';

function NewRepDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateSalesRep();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', salesCode: '' });

  async function submit() {
    try {
      const rep = await create.mutateAsync({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(form.salesCode.trim() ? { salesCode: form.salesCode.trim() } : {}),
      });
      toast.success(
        `Comercial creado con el código ${rep.salesCode}. Le llega un correo para elegir su contraseña.`,
      );
      setForm({ fullName: '', email: '', phone: '', salesCode: '' });
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido crear.'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nuevo comercial</DialogTitle>
          <DialogDescription>
            Entra al panel de administración, pero solo ve su cartera. La primera vez tendrá que
            activar la verificación en dos pasos.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field id="nr-name" label="Nombre">
            <Input
              id="nr-name"
              value={form.fullName}
              maxLength={120}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
            />
          </Field>
          <Field id="nr-email" label="Email">
            <Input
              id="nr-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </Field>
          <Field id="nr-phone" label="Teléfono (opcional)">
            <Input
              id="nr-phone"
              type="tel"
              value={form.phone}
              maxLength={30}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </Field>
          <Field
            id="nr-code"
            label="Código (opcional)"
            hint="De 4 a 12 letras o cifras. Si no, se crea uno con su nombre."
          >
            <Input
              id="nr-code"
              value={form.salesCode}
              maxLength={12}
              onChange={(e) => setForm((f) => ({ ...f, salesCode: e.target.value.toUpperCase() }))}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={
              form.fullName.trim().length < 2 || !form.email.includes('@') || create.isPending
            }
            onClick={() => void submit()}
          >
            {create.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsCard({ settings }: { settings: PlatformSalesSettingsDto }) {
  const save = useSaveSalesSettings();
  const [form, setForm] = useState({
    signupExtraTrialDays: settings.signupExtraTrialDays,
    leadReleaseDays: settings.leadReleaseDays,
    repTrialExtensionDays: settings.repTrialExtensionDays,
    repAddonTrialDays: settings.repAddonTrialDays,
    lifecycleFromRep: settings.lifecycleFromRep,
  });
  // Solo cuando cambian estas reglas (no al tocar la demo, que comparte ajustes).
  useEffect(() => {
    setForm({
      signupExtraTrialDays: settings.signupExtraTrialDays,
      leadReleaseDays: settings.leadReleaseDays,
      repTrialExtensionDays: settings.repTrialExtensionDays,
      repAddonTrialDays: settings.repAddonTrialDays,
      lifecycleFromRep: settings.lifecycleFromRep,
    });
  }, [
    settings.signupExtraTrialDays,
    settings.leadReleaseDays,
    settings.repTrialExtensionDays,
    settings.repAddonTrialDays,
    settings.lifecycleFromRep,
  ]);
  const num = (k: keyof typeof form, max: number) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: Math.max(0, Math.min(max, e.target.valueAsNumber || 0)) }));

  async function submit() {
    try {
      await save.mutateAsync(form);
      toast.success('Ajustes guardados.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Reglas del equipo</CardTitle>
        <CardDescription>Valen para todos los comerciales.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="ss-extra"
            label="Días de prueba de más con el código"
            hint="0 = la prueba normal."
          >
            <Input
              id="ss-extra"
              type="number"
              min={0}
              max={90}
              value={form.signupExtraTrialDays}
              onChange={num('signupExtraTrialDays', 90)}
            />
          </Field>
          <Field
            id="ss-release"
            label="Liberar prospectos sin contacto a los (días)"
            hint="0 = nunca. Quedan libres para otro comercial."
          >
            <Input
              id="ss-release"
              type="number"
              min={0}
              max={730}
              value={form.leadReleaseDays}
              onChange={num('leadReleaseDays', 730)}
            />
          </Field>
          <Field
            id="ss-trial"
            label="Días de prueba que puede ampliar un comercial"
            hint="En total por cliente; para más, te lo piden."
          >
            <Input
              id="ss-trial"
              type="number"
              min={0}
              max={90}
              value={form.repTrialExtensionDays}
              onChange={num('repTrialExtensionDays', 90)}
            />
          </Field>
          <Field
            id="ss-addon"
            label="Días de prueba de un extra"
            hint="Uno por cliente. 0 = no pueden dar pruebas."
          >
            <Input
              id="ss-addon"
              type="number"
              min={0}
              max={90}
              value={form.repAddonTrialDays}
              onChange={num('repAddonTrialDays', 90)}
            />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.lifecycleFromRep}
            onChange={(e) => setForm((f) => ({ ...f, lifecycleFromRep: e.target.checked }))}
          />
          <span>
            Los correos automáticos de sus clientes (bienvenida, fin de la prueba…) salen con el
            nombre del comercial y las respuestas le llegan a él.
          </span>
        </label>
        <div className="flex justify-end">
          <Button size="sm" disabled={save.isPending} onClick={() => void submit()}>
            {save.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DemoCard({ settings }: { settings: PlatformSalesSettingsDto }) {
  const action = useDemoAction();
  const open = useOpenDemoAsAdmin();
  const openPortal = useOpenDemoPortalAsAdmin();
  const save = useSaveSalesSettings();
  const demo = settings.demo;

  async function run(kind: 'create' | 'reset') {
    try {
      await action.mutateAsync(kind);
      toast.success(kind === 'create' ? 'Cuenta de demostración creada.' : 'Demo puesta a cero.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cuenta de demostración</CardTitle>
        <CardDescription>
          Un negocio de ejemplo para las demos de los comerciales. No cuenta en ninguna cifra y lo
          que cambien (datos y ajustes) se deshace cada noche. Las fotos de los locales, el logo y
          las fotos de la portada se conservan: súbelas una vez desde la demo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {demo.tenantId ? (
          <>
            <p>
              <strong>{demo.tenantName}</strong>
              {demo.resetAt && (
                <span className="text-muted-foreground">
                  {' '}
                  · puesta a cero {formatDateTime(demo.resetAt)}
                </span>
              )}
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={demo.resetEnabled}
                onChange={(e) =>
                  void save
                    .mutateAsync({ demoResetEnabled: e.target.checked })
                    .catch((err) => toast.error(errorText(err)))
                }
              />
              Ponerla a cero cada noche
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={open.isPending}
                onClick={() =>
                  void open
                    .mutateAsync()
                    .then((s) => openImpersonationTab(s))
                    .catch((err) => toast.error(errorText(err)))
                }
              >
                <MonitorPlay className="mr-1.5 size-4" />
                Abrir
                <ExternalLink className="ml-1.5 size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={action.isPending}
                onClick={() => void run('reset')}
              >
                <RotateCcw className="mr-1.5 size-4" />
                Poner a cero ahora
              </Button>
            </div>
            <DemoExtraLinks
              size="sm"
              tenantSlug={demo.tenantSlug}
              openPortal={() => openPortal.mutateAsync()}
              portalPending={openPortal.isPending}
            />
          </>
        ) : (
          <Button size="sm" disabled={action.isPending} onClick={() => void run('create')}>
            {action.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Crear la cuenta de demostración
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

const PERIODS = [
  { value: '1', label: 'Este mes' },
  { value: '3', label: 'Últimos 3 meses' },
  { value: '6', label: 'Últimos 6 meses' },
  { value: '12', label: 'Último año' },
];

/** Cómo va cada comercial en el periodo. */
function ComparisonCard() {
  const [months, setMonths] = useState('3');
  const data = useTeamComparison(Number(months));
  const rows = data.data?.rows ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">Comparativa del equipo</CardTitle>
          <CardDescription>
            Prospectos, pruebas, ventas y bajas de cada comercial en el periodo; las cuotas, las de
            hoy.
          </CardDescription>
        </div>
        <Select value={months} onValueChange={setMonths}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {data.isLoading || data.isError ? (
          <QueryState query={data} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no tienes comerciales.</p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Comercial</TableHead>
                  <TableHead className="text-right">Prospectos</TableHead>
                  <TableHead className="text-right">Pruebas</TableHead>
                  <TableHead className="text-right">Ventas</TableHead>
                  <TableHead className="text-right">Conversión</TableHead>
                  <TableHead className="text-right">Días hasta pagar</TableHead>
                  <TableHead className="text-right">Bajas</TableHead>
                  <TableHead className="text-right">Cuotas al mes</TableHead>
                  <TableHead className="text-right">Comisiones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.repId} className={cn(!r.isActive && 'opacity-60')}>
                    <TableCell className="text-sm">
                      <Link href={`/admin/sales-team/${r.repId}`} className="hover:underline">
                        {r.repName}
                      </Link>
                      {!r.isActive && (
                        <span className="block text-xs text-muted-foreground">Desactivado</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.leads}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.trials}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.wins}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.conversionPct === null ? '—' : `${r.conversionPct} %`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.avgDaysToClose ?? '—'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        r.churned > 0 && 'text-rose-600 dark:text-rose-400',
                      )}
                    >
                      {r.churned}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatEur(r.mrr)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatEur(r.commission)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Lotes repartidos por la dirección: cuántos y en qué fase están ahora. */
function BatchesCard() {
  const data = useSalesBatches();
  const rows = data.data ?? [];
  if (rows.length === 0) return null;
  const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Lotes repartidos</CardTitle>
        <CardDescription>
          Cómo van los prospectos de cada reparto. «Sin abrir» son los que su comercial aún no ha
          mirado.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lote</TableHead>
                <TableHead className="text-right">Prospectos</TableHead>
                <TableHead className="text-right">Sin abrir</TableHead>
                <TableHead className="text-right">Contactados</TableHead>
                <TableHead className="text-right">Interesados</TableHead>
                <TableHead className="text-right">En prueba</TableHead>
                <TableHead className="text-right">Clientes</TableHead>
                <TableHead className="text-right">Perdidos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.name}>
                  <TableCell className="text-sm">
                    <Link
                      href={`/admin/leads?view=list&batch=${encodeURIComponent(b.name)}`}
                      className="font-medium hover:underline"
                    >
                      {b.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {b.reps === 1 ? '1 comercial' : `${b.reps} comerciales`}
                      {b.lastAssignedAt && ` · ${formatDate(b.lastAssignedAt)}`}
                      {b.withRep < b.total && ` · ${b.total - b.withRep} ya sin comercial`}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{b.total}</TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      b.unseen > 0 && 'text-amber-700 dark:text-amber-300',
                    )}
                  >
                    {b.unseen}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{b.contacted}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.interested}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.trial}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {b.customer}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({pct(b.customer, b.total)} %)
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{b.lost}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/** Lo que costarán las comisiones del % los próximos meses (con la cartera de hoy). */
function TeamForecastCard() {
  const data = useTeamForecast();
  const f = data.data;
  if (!f || f.reps.length === 0 || f.total <= 0) return null;
  const monthName = (m: string) => {
    const [y, mo] = m.split('-').map(Number) as [number, number];
    return new Date(y, mo - 1, 1).toLocaleDateString('es-ES', { month: 'short' });
  };
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Comisiones previstas</CardTitle>
        <CardDescription>
          El % de cada comercial sobre lo que pagan hoy sus clientes, los próximos {f.months.length}{' '}
          meses. Sin ventas nuevas, fijos ni bonus.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Comercial</TableHead>
                {f.months.map((m) => (
                  <TableHead key={m} className="text-right capitalize">
                    {monthName(m)}
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {f.reps.map((r) => (
                <TableRow key={r.repId}>
                  <TableCell className="text-sm">{r.repName}</TableCell>
                  {r.amounts.map((a, i) => (
                    <TableCell key={i} className="text-right tabular-nums">
                      {formatEur(a)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatEur(r.total)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="text-sm font-medium">Equipo</TableCell>
                {f.totals.map((a, i) => (
                  <TableCell key={i} className="text-right font-medium tabular-nums">
                    {formatEur(a)}
                  </TableCell>
                ))}
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatEur(f.total)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SalesTeamPage() {
  const team = useSalesTeam();
  const settings = useSalesSettings();
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const data = team.data;
  const reps = data?.reps ?? [];
  const active = reps.filter((r) => r.isActive);

  return (
    <SalesPage>
      <PageHeader
        title="Equipo comercial"
        description="Tus comerciales, su cartera y lo que llevan ganado."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={active.length === 0}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="mr-1.5 size-4" />
              Importar y repartir prospectos
            </Button>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              Nuevo comercial
            </Button>
          </div>
        }
      />
      <NewRepDialog open={newOpen} onClose={() => setNewOpen(false)} />
      {importOpen && (
        <DistributeDialog source={{ kind: 'file' }} onClose={() => setImportOpen(false)} />
      )}

      {data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Comerciales activos" value={active.length} />
          <Stat label="Clientes del equipo" value={active.reduce((s, r) => s + r.customers, 0)} />
          <Stat
            label="Pagan al mes"
            value={formatEur(active.reduce((s, r) => s + r.mrr, 0))}
            tone="good"
          />
          <Stat
            label="Por decidir"
            value={data.pending.claims + data.pending.concepts}
            hint={
              <Link href="/admin/sales-team/pending" className="text-primary hover:underline">
                Revisar
              </Link>
            }
            tone={data.pending.claims + data.pending.concepts > 0 ? 'warn' : 'default'}
          />
        </div>
      )}
      {data && data.orphanAccounts > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {data.orphanAccounts} cuentas son de comerciales desactivados. Pásalas a otro desde la
          ficha de ese comercial.
        </p>
      )}

      {team.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : team.isError ? (
        <QueryError query={team} />
      ) : reps.length === 0 ? (
        <Empty>Aún no tienes comerciales.</Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Comercial</TableHead>
                <TableHead className="text-right">Cartera</TableHead>
                <TableHead className="text-right">Pagan al mes</TableHead>
                <TableHead className="hidden text-right md:table-cell">Este mes</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Conversión</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Actividad 7 d</TableHead>
                <TableHead className="text-right">Comisión del mes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reps.map((r) => (
                <TableRow key={r.id} className={r.isActive ? '' : 'opacity-60'}>
                  <TableCell>
                    <Link
                      href={`/admin/sales-team/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.fullName}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{r.salesCode}</span>
                      {!r.isActive && <Badge variant="secondary">Desactivado</Badge>}
                      {r.isActive && !r.twoFactorEnabled && (
                        <Badge variant="outline">Sin 2FA</Badge>
                      )}
                      {r.pendingClaims > 0 && (
                        <Badge variant="outline">{r.pendingClaims} extras por aprobar</Badge>
                      )}
                      <span>· entró {relativeDays(r.lastLoginAt)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {r.prospects} prosp. · {r.trials} pruebas · {r.customers} clientes
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatEur(r.mrr)}</TableCell>
                  <TableCell className="hidden text-right text-xs md:table-cell">
                    {r.newClientsMonth} clientes · {formatEur(r.newMrrMonth)}
                    {r.target && (
                      <span className="block text-muted-foreground">
                        objetivo {r.target.newClients} · {formatEur(r.target.newMrr)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right lg:table-cell">
                    {r.conversionPct === null ? '—' : `${r.conversionPct} %`}
                  </TableCell>
                  <TableCell className="hidden text-right lg:table-cell">
                    {r.activities7d}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatEur(r.commissionMonth)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <BatchesCard />
      <ComparisonCard />
      <TeamForecastCard />

      {settings.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsCard settings={settings.data} />
          <DemoCard settings={settings.data} />
        </div>
      )}
    </SalesPage>
  );
}
