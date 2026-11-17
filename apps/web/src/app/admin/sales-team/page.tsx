'use client';

import { ExternalLink, Loader2, MonitorPlay, Plus, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PlatformSalesSettingsDto } from '@storageos/shared';

import {
  Empty,
  errorText,
  Field,
  PageHeader,
  relativeDays,
  SalesPage,
  Stat,
} from '@/components/admin/sales/common';
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
  useSalesSettings,
  useSalesTeam,
  useSaveSalesSettings,
} from '@/lib/admin/sales-team-hooks';
import { openImpersonationTab } from '@/lib/auth/impersonation';
import { formatDateTime, formatEur } from '@/lib/format';

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
  useEffect(() => {
    setForm({
      signupExtraTrialDays: settings.signupExtraTrialDays,
      leadReleaseDays: settings.leadReleaseDays,
      repTrialExtensionDays: settings.repTrialExtensionDays,
      repAddonTrialDays: settings.repAddonTrialDays,
      lifecycleFromRep: settings.lifecycleFromRep,
    });
  }, [settings]);
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
          que cambien se deshace cada noche.
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

export default function SalesTeamPage() {
  const team = useSalesTeam();
  const settings = useSalesSettings();
  const [newOpen, setNewOpen] = useState(false);
  const data = team.data;
  const reps = data?.reps ?? [];
  const active = reps.filter((r) => r.isActive);

  return (
    <SalesPage>
      <PageHeader
        title="Equipo comercial"
        description="Tus comerciales, su cartera y lo que llevan ganado."
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 size-4" />
            Nuevo comercial
          </Button>
        }
      />
      <NewRepDialog open={newOpen} onClose={() => setNewOpen(false)} />

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

      {settings.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsCard settings={settings.data} />
          <DemoCard settings={settings.data} />
        </div>
      )}
    </SalesPage>
  );
}
