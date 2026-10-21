'use client';

import { type Ga4ReportDto, type Ga4SettingsDto } from '@storageos/shared';
import { Copy, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useGa4Action, useGa4Report, useGa4Settings } from '@/lib/marketing/hooks';

const int = (n: number) => n.toLocaleString('es-ES');
const pct = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)} %`);

function sinceLabel(iso: string | null): string {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Variación frente al periodo anterior; null sin datos de antes. */
function delta(now: number, before: number): { text: string; className: string } | null {
  if (before === 0) return null;
  const p = Math.round(((now - before) / before) * 100);
  if (p === 0) return { text: '=', className: 'text-muted-foreground' };
  return {
    text: `${p > 0 ? '+' : ''}${p} %`,
    className: p > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
  };
}

function ConnectForm({ settings }: { settings: Ga4SettingsDto }) {
  const canManage = useHasPermission('marketing:manage');
  const action = useGa4Action();
  const [propertyId, setPropertyId] = useState(settings.propertyId ?? '');

  async function copyEmail() {
    if (!settings.serviceAccountEmail) return;
    await navigator.clipboard.writeText(settings.serviceAccountEmail);
    toast.success('Email copiado');
  }

  async function connect() {
    try {
      await action.mutateAsync({ propertyId });
      toast.success('Google Analytics conectado');
    } catch (err) {
      // Sin acceso a la propiedad: el motivo ya sale debajo del formulario.
      if (err instanceof ApiError && err.body.code === 'ga4_no_access') return;
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo conectar');
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <ol className="list-decimal space-y-3 pl-5 text-muted-foreground">
        <li>
          En Google Analytics, entra en{' '}
          <strong>Administrar → Gestión del acceso a la propiedad</strong> y añade este email con el
          rol <strong>Lector</strong>:
          <div className="mt-2 flex max-w-md items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs text-foreground">
              {settings.serviceAccountEmail}
            </code>
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={copyEmail}
              aria-label="Copiar email"
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </li>
        <li>
          Copia el <strong>ID de la propiedad</strong> (Administrar → Configuración de la propiedad;
          es un número, no el «G-…» de medición) y pégalo aquí.
        </li>
      </ol>
      {settings.status === 'error' && settings.lastError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
          {settings.lastError}
        </p>
      )}
      {canManage ? (
        <div className="flex max-w-md gap-2">
          <Input
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            placeholder="123456789"
            inputMode="numeric"
            aria-label="ID de la propiedad de Google Analytics"
          />
          <Button onClick={connect} disabled={!propertyId.trim() || action.isPending}>
            {action.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Conectar
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">Pide a un responsable que conecte Google Analytics.</p>
      )}
    </div>
  );
}

function Report({ report, ownVisitors }: { report: Ga4ReportDto; ownVisitors: number }) {
  const t = report.totals;
  const kpis = [
    { label: 'Sesiones', value: int(t.sessions), d: delta(t.sessions, report.previous.sessions) },
    { label: 'Con interacción', value: pct(t.engagementRate), d: null },
    {
      label: 'Páginas vistas',
      value: int(t.pageViews),
      d: delta(t.pageViews, report.previous.pageViews),
    },
    {
      label: 'Eventos clave',
      value: int(t.keyEvents),
      d: delta(t.keyEvents, report.previous.keyEvents),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">{k.label}</div>
            <div className="text-xl font-semibold tabular-nums">{k.value}</div>
            {k.d && (
              <div className="text-xs">
                <span className={k.d.className}>{k.d.text}</span>{' '}
                <span className="text-muted-foreground">frente al periodo anterior</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Hasta ayer: Google Analytics tarda un día en tener los datos.
        {ownVisitors > 0 &&
          ` TrasterOS contó ${int(ownVisitors)} ${ownVisitors === 1 ? 'visitante' : 'visitantes'} en este periodo; las cifras no coinciden porque Google Analytics cuenta sesiones y solo de quien acepta las cookies.`}
      </p>
      {report.sources.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          Google Analytics aún no tiene sesiones en este periodo.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-2 py-2 font-medium">Origen / medio</th>
                <th className="px-2 py-2 text-right font-medium">Sesiones</th>
                <th className="px-2 py-2 text-right font-medium">Con interacción</th>
                <th className="px-2 py-2 text-right font-medium">Eventos clave</th>
              </tr>
            </thead>
            <tbody>
              {report.sources.map((s) => (
                <tr key={`${s.source}/${s.medium}`} className="border-b last:border-0">
                  <td className="px-2 py-2">
                    <span className="font-medium">{s.source}</span>
                    <span className="text-muted-foreground"> / {s.medium}</span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{int(s.sessions)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{pct(s.engagementRate)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{int(s.keyEvents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Google Analytics 4 en la página de visitas (Web Premium). */
export function Ga4Section({ days, ownVisitors }: { days: number; ownVisitors: number }) {
  const hasFeature = useHasFeature('web_premium');
  const canManage = useHasPermission('marketing:manage');
  const settings = useGa4Settings(hasFeature);
  const connected = settings.data?.status === 'connected';
  const report = useGa4Report(days, hasFeature && connected);
  const action = useGa4Action();
  const ask = useConfirm();

  async function sync() {
    const res = await action.mutateAsync('sync');
    if (res.status === 'error') toast.error(res.lastError ?? 'No se pudo actualizar');
    else toast.success('Datos actualizados');
  }

  async function disconnect() {
    const ok = await ask({
      title: 'Desconectar Google Analytics',
      description: 'Se borran los datos descargados. Puedes volver a conectarlo cuando quieras.',
      confirmLabel: 'Desconectar',
      destructive: true,
    });
    if (ok) await action.mutateAsync(null);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Google Analytics</CardTitle>
          <CardDescription>
            {connected && settings.data
              ? `Propiedad ${settings.data.propertyId} · actualizado ${sinceLabel(settings.data.lastSyncedAt)}`
              : 'Los datos de tu propiedad de Google Analytics 4, junto a los de TrasterOS.'}
          </CardDescription>
        </div>
        {connected && canManage && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={sync} disabled={action.isPending}>
              <RefreshCw className={`mr-2 size-4 ${action.isPending ? 'animate-spin' : ''}`} />
              Actualizar
            </Button>
            <Button size="sm" variant="ghost" onClick={disconnect} disabled={action.isPending}>
              Desconectar
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {!hasFeature ? (
          <p className="text-sm text-muted-foreground">
            Incluido en <strong>Web Premium</strong>.{' '}
            <Link href="/settings/saas-billing" className="text-primary hover:underline">
              Ver planes y extras
            </Link>
          </p>
        ) : settings.isLoading || !settings.data ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : !settings.data.available ? (
          <p className="text-sm text-muted-foreground">
            La conexión con Google Analytics estará disponible pronto.
          </p>
        ) : !connected ? (
          <ConnectForm settings={settings.data} />
        ) : report.isLoading || !report.data ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <Report report={report.data} ownVisitors={ownVisitors} />
        )}
      </CardContent>
    </Card>
  );
}
