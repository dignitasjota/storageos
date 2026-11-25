'use client';

import {
  SEO_PROVIDER_LABELS,
  SEO_SISTRIX_CONNECTION_LABELS,
  SEO_SISTRIX_DATA_TYPES,
  SEO_SISTRIX_DATA_TYPE_LABELS,
  SEO_SISTRIX_WAIT_LABELS,
  SEO_SYNC_FREQUENCIES,
  SEO_SYNC_FREQUENCY_LABELS,
  type SeoSistrixDataType,
  type SeoSistrixIntegrationsDto,
  type SeoSyncFrequency,
} from '@storageos/shared';
import { AlertTriangle, Link2, Loader2, Unplug } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { BackLink } from '@/components/layout/back-link';
import { seoErrorMessage } from '@/components/seo/seo-errors';
import { SistrixRunRow } from '@/components/seo/sistrix/sistrix-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { formatCount, formatDateTime } from '@/lib/format';
import {
  useAuthorizeSistrixApi,
  useCancelPlatformSistrixRun,
  useConnectSistrix,
  useDisconnectSistrix,
  useRefreshSistrixTools,
  useRevokeSistrixApi,
  useSistrixIntegrations,
  useSistrixRequests,
  useTestPlatformSistrixApi,
  useTestSistrix,
  useUpdatePlatformSistrixApi,
  useUpdatePlatformSyncSettings,
} from '@/lib/seo-advanced/sistrix-hooks';

const ALL = 'all';

function McpCard({ data, canEdit }: { data: SeoSistrixIntegrationsDto; canEdit: boolean }) {
  const confirm = useConfirm();
  const connect = useConnectSistrix();
  const test = useTestSistrix();
  const tools = useRefreshSistrixTools();
  const disconnect = useDisconnectSistrix();
  const authorize = useAuthorizeSistrixApi();
  const revoke = useRevokeSistrixApi();
  const mcp = data.mcp;
  const connected = mcp.status === 'connected';

  const go = async () => {
    try {
      const { authorizationUrl } = await connect.mutateAsync(undefined);
      window.location.href = authorizationUrl;
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const probe = async () => {
    try {
      const res = await test.mutateAsync(undefined);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const off = async () => {
    const yes = await confirm({
      title: '¿Desconectar SISTRIX?',
      description:
        'Se borran los tokens y se revoca el acceso en SISTRIX. Las descargas de SISTRIX se paran hasta que vuelvas a conectar. Lo ya descargado se conserva.',
      confirmLabel: 'Desconectar',
      destructive: true,
    });
    if (yes) await run(() => disconnect.mutateAsync(undefined), 'SISTRIX desconectado');
  };
  const continueByApi = async () => {
    const yes = await confirm({
      title: '¿Continuar por la API clásica?',
      description: `Gasta créditos de SISTRIX (como mucho ${formatCount(data.api.weeklyBudget)} a la semana) hasta que el MCP vuelva a tener cuota${
        mcp.quotaExhaustedUntil ? `, el ${formatDateTime(mcp.quotaExhaustedUntil)}` : ''
      }. Entonces se vuelve solo al MCP.`,
      confirmLabel: 'Continuar por API',
    });
    if (yes) await run(() => authorize.mutateAsync(undefined), 'Las consultas siguen por la API');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          SISTRIX (MCP)
          <Badge variant={connected ? 'secondary' : 'outline'}>
            {SEO_SISTRIX_CONNECTION_LABELS[mcp.status]}
          </Badge>
        </CardTitle>
        <CardDescription>
          Con la cuenta de SISTRIX de la plataforma, sin gastar créditos. Sirve a trasteros.pro y a
          los negocios propios a los que se lo actives.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Conectado</dt>
            <dd>
              {mcp.connectedAt ? formatDateTime(mcp.connectedAt) : '—'}
              {mcp.connectedBy ? ` · ${mcp.connectedBy}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Última respuesta correcta</dt>
            <dd>{mcp.lastSuccessAt ? formatDateTime(mcp.lastSuccessAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Ahora se pide por</dt>
            <dd>
              {data.routing.provider
                ? SEO_PROVIDER_LABELS[data.routing.provider]
                : data.routing.waitReason
                  ? SEO_SISTRIX_WAIT_LABELS[data.routing.waitReason]
                  : '—'}
            </dd>
          </div>
        </dl>
        <p className="break-all text-xs text-muted-foreground">
          Dirección de vuelta: <span className="font-mono">{mcp.redirectUri}</span>
        </p>
        {mcp.lastError && <p className="text-sm text-destructive">{mcp.lastError}</p>}

        {mcp.quotaExhaustedUntil && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              SISTRIX agotó la cuota del día. Las consultas siguen solas el{' '}
              {formatDateTime(mcp.quotaExhaustedUntil)}.
            </p>
            {data.api.authorizedUntil ? (
              <div className="flex flex-wrap items-center gap-2">
                <span>Siguen por la API hasta el {formatDateTime(data.api.authorizedUntil)}.</span>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run(() => revoke.mutateAsync(undefined), 'Autorización retirada')
                    }
                  >
                    Parar la API
                  </Button>
                )}
              </div>
            ) : data.canContinueByApi ? (
              canEdit && (
                <Button size="sm" onClick={() => void continueByApi()}>
                  Continuar por API
                </Button>
              )
            ) : (
              <p className="text-xs text-muted-foreground">
                Para seguir antes, activa la API clásica con su clave y un presupuesto semanal.
              </p>
            )}
          </div>
        )}

        {mcp.toolsChanges &&
          (mcp.toolsChanges.removedTools.length > 0 ||
            mcp.toolsChanges.removedViews.length > 0 ||
            mcp.toolsChanges.addedTools.length > 0) && (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                SISTRIX cambió sus herramientas
                {mcp.toolsChangedAt ? ` (${formatDateTime(mcp.toolsChangedAt)})` : ''}
                {mcp.toolsChanges.affectsUs ? ': afecta a lo que usamos' : ''}
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {mcp.toolsChanges.removedTools.map((t) => (
                  <li key={t}>Ya no está la herramienta {t}</li>
                ))}
                {mcp.toolsChanges.removedViews.map((v) => (
                  <li key={`${v.tool}.${v.view}`}>
                    Ya no está la vista {v.view} de {v.tool}
                  </li>
                ))}
                {mcp.toolsChanges.addedTools.map((t) => (
                  <li key={t}>Nueva: {t}</li>
                ))}
              </ul>
            </div>
          )}

        {mcp.tools.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              {mcp.tools.length} herramientas disponibles
              {mcp.toolsCheckedAt ? ` · revisadas ${formatDateTime(mcp.toolsCheckedAt)}` : ''}
            </summary>
            <ul className="mt-2 space-y-1">
              {mcp.tools.map((t) => (
                <li key={t.name}>
                  <span className="font-mono">{t.name}</span>
                  {t.views.length > 0 && (
                    <span className="block break-words text-xs text-muted-foreground">
                      {t.views.join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void go()} disabled={connect.isPending}>
              {connect.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
              ) : (
                <Link2 className="mr-1 size-4" aria-hidden />
              )}
              {mcp.status === 'disconnected' ? 'Conectar SISTRIX' : 'Volver a conectar'}
            </Button>
            {connected && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void probe()}
                  disabled={test.isPending}
                >
                  Probar la conexión
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void run(() => tools.mutateAsync(undefined), 'Herramientas revisadas')
                  }
                  disabled={tools.isPending}
                >
                  Revisar herramientas
                </Button>
              </>
            )}
            {mcp.status !== 'disconnected' && (
              <Button size="sm" variant="ghost" onClick={() => void off()}>
                <Unplug className="mr-1 size-4" aria-hidden /> Desconectar
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ApiCard({ data, canEdit }: { data: SeoSistrixIntegrationsDto; canEdit: boolean }) {
  const update = useUpdatePlatformSistrixApi();
  const test = useTestPlatformSistrixApi();
  const api = data.api;
  const [key, setKey] = useState('');
  const [budget, setBudget] = useState(String(api.weeklyBudget));
  const [enabled, setEnabled] = useState(api.enabled);
  useEffect(() => {
    setBudget(String(api.weeklyBudget));
    setEnabled(api.enabled);
  }, [api.weeklyBudget, api.enabled]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        enabled,
        weeklyBudget: Math.max(0, Math.round(Number(budget) || 0)),
      });
      setKey('');
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const probe = async () => {
    try {
      const res = await test.mutateAsync(undefined);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          SISTRIX (API clásica)
          <Badge variant={api.enabled ? 'secondary' : 'outline'}>
            {api.enabled ? 'Activada' : 'Desactivada'}
          </Badge>
        </CardTitle>
        <CardDescription>
          Opcional. Gasta créditos: solo se usa cuando el MCP agota la cuota y autorizas «Continuar
          por API», con el presupuesto semanal como tope.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Clave</dt>
            <dd className="font-mono">{api.hasKey ? `••••${api.keyLast4}` : 'Sin clave'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Créditos de esta semana</dt>
            <dd className="tabular-nums">
              {formatCount(api.weekSpent)} de {formatCount(api.weeklyBudget)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Saldo en SISTRIX</dt>
            <dd className="tabular-nums">
              {api.creditsBalance === null ? '—' : formatCount(api.creditsBalance)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Consultado</dt>
            <dd>{api.creditsCheckedAt ? formatDateTime(api.creditsCheckedAt) : '—'}</dd>
          </div>
        </dl>
        {api.lastError && <p className="text-sm text-destructive">{api.lastError}</p>}
        {canEdit && (
          <form onSubmit={(e) => void save(e)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="api-key">{api.hasKey ? 'Cambiar la clave' : 'Clave de API'}</Label>
                <Input
                  id="api-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={
                    api.hasKey ? 'Deja vacío para no cambiarla' : 'La de «API access» en SISTRIX'
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="api-budget">Presupuesto semanal (créditos)</Label>
                <Input
                  id="api-budget"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
              Activar la API clásica
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={update.isPending}>
                Guardar
              </Button>
              {api.hasKey && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void probe()}
                  disabled={test.isPending}
                >
                  Ver saldo
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function SettingsCard({ data, canEdit }: { data: SeoSistrixIntegrationsDto; canEdit: boolean }) {
  const update = useUpdatePlatformSyncSettings();
  const s = data.settings;
  const [freq, setFreq] = useState(s.frequencies);
  const [perDay, setPerDay] = useState(String(s.maxRequestsPerDay));
  const [perBatch, setPerBatch] = useState(String(s.maxRequestsPerBatch));
  const [pause, setPause] = useState(String(s.pauseMs));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        frequencies: freq,
        maxRequestsPerDay: Math.max(1, Math.round(Number(perDay) || 1)),
        maxRequestsPerBatch: Math.max(1, Math.round(Number(perBatch) || 1)),
        pauseMs: Math.max(0, Math.round(Number(pause) || 0)),
      });
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Frecuencias y límites</CardTitle>
        <CardDescription>
          Cada cuánto se pide cada dato a SISTRIX para los proyectos de la plataforma. Hoy van{' '}
          {formatCount(s.requestsToday)} consultas de {formatCount(s.maxRequestsPerDay)}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {SEO_SISTRIX_DATA_TYPES.map((t: SeoSistrixDataType) => (
              <div key={t} className="space-y-1">
                <Label>{SEO_SISTRIX_DATA_TYPE_LABELS[t]}</Label>
                <Select
                  value={freq[t]}
                  disabled={!canEdit}
                  onValueChange={(v) => setFreq({ ...freq, [t]: v as SeoSyncFrequency })}
                >
                  <SelectTrigger aria-label={SEO_SISTRIX_DATA_TYPE_LABELS[t]}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEO_SYNC_FREQUENCIES.map((f) => (
                      <SelectItem key={f} value={f}>
                        {SEO_SYNC_FREQUENCY_LABELS[f]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="per-day">Consultas al día, como mucho</Label>
              <Input
                id="per-day"
                type="number"
                min={1}
                value={perDay}
                disabled={!canEdit}
                onChange={(e) => setPerDay(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="per-batch">Consultas por tanda</Label>
              <Input
                id="per-batch"
                type="number"
                min={1}
                value={perBatch}
                disabled={!canEdit}
                onChange={(e) => setPerBatch(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pause">Pausa entre llamadas (ms)</Label>
              <Input
                id="pause"
                type="number"
                min={0}
                value={pause}
                disabled={!canEdit}
                onChange={(e) => setPause(e.target.value)}
              />
            </div>
          </div>
          {canEdit && (
            <Button type="submit" size="sm" disabled={update.isPending}>
              Guardar
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function RequestsCard() {
  const [status, setStatus] = useState(ALL);
  const [provider, setProvider] = useState(ALL);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const list = useSistrixRequests({
    status: status === ALL ? '' : status,
    provider: provider === ALL ? '' : provider,
    cursor,
  });
  const reset = () => setCursors([null]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Historial de peticiones</CardTitle>
        <CardDescription>
          Cada consulta a SISTRIX (las servidas de la caché no gastan nada).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              reset();
            }}
          >
            <SelectTrigger className="sm:w-48" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas</SelectItem>
              <SelectItem value="ok">Correctas</SelectItem>
              <SelectItem value="empty">Sin resultados</SelectItem>
              <SelectItem value="cached">De la caché</SelectItem>
              <SelectItem value="quota">Cuota agotada</SelectItem>
              <SelectItem value="error">Con error</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v);
              reset();
            }}
          >
            <SelectTrigger className="sm:w-48" aria-label="Vía">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>MCP y API</SelectItem>
              <SelectItem value="sistrix_mcp">{SEO_PROVIDER_LABELS.sistrix_mcp}</SelectItem>
              <SelectItem value="sistrix_api">{SEO_PROVIDER_LABELS.sistrix_api}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {list.isError ? (
          <AdminError onRetry={() => void list.refetch()} />
        ) : list.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : !list.data?.items.length ? (
          <p className="text-sm text-muted-foreground">No hay peticiones.</p>
        ) : (
          <ul className="divide-y text-sm">
            {list.data.items.map((r) => (
              <li key={r.id} className="space-y-0.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">
                    {r.tool}
                    {r.view ? `/${r.view}` : ''}
                  </span>
                  <Badge
                    variant={
                      r.status === 'error' || r.status === 'quota' ? 'destructive' : 'outline'
                    }
                  >
                    {r.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {SEO_PROVIDER_LABELS[r.provider]}
                  </span>
                  {r.credits > 0 && (
                    <span className="text-xs text-muted-foreground">{r.credits} créditos</span>
                  )}
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  {formatDateTime(r.createdAt)} · {r.durationMs} ms
                  {r.projectName ? ` · ${r.projectName}` : ''}
                  {r.createdBy ? ` · ${r.createdBy}` : ''} ·{' '}
                  {Object.entries(r.args)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(' ')}
                </p>
                {r.errorMessage && (
                  <p className="break-words text-xs text-destructive">
                    {r.errorCode ? `(${r.errorCode}) ` : ''}
                    {r.errorMessage}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          {cursors.length > 1 && (
            <Button size="sm" variant="outline" onClick={() => setCursors(cursors.slice(0, -1))}>
              Anteriores
            </Button>
          )}
          {list.data?.nextCursor && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCursors([...cursors, list.data!.nextCursor])}
            >
              Más antiguas
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Panel admin → SEO → Integraciones: SISTRIX por MCP (principal) y por API (preparada). */
export default function SeoIntegrationsPage() {
  const isSuperadmin = useIsSuperadmin();
  const data = useSistrixIntegrations();
  const cancel = useCancelPlatformSistrixRun();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('sistrix');
    if (!result) return;
    if (result === 'ok') toast.success('SISTRIX conectado');
    else toast.error('No se pudo conectar con SISTRIX. Vuelve a intentarlo.');
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="space-y-2">
        <BackLink href="/admin/seo" label="Proyectos" />
        <h1 className="text-2xl font-semibold tracking-tight">Integraciones de SEO</h1>
        <p className="text-sm text-muted-foreground">
          SISTRIX por MCP con la cuenta de la plataforma y, si hace falta, por la API clásica.
          Ningún token ni clave sale de aquí.
        </p>
      </div>
      {data.isError ? (
        <AdminError onRetry={() => void data.refetch()} />
      ) : data.isLoading || !data.data ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <McpCard data={data.data} canEdit={isSuperadmin} />
          <ApiCard data={data.data} canEdit={isSuperadmin} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Trabajos pendientes</CardTitle>
              <CardDescription>
                Tandas en cola, en curso o en espera de los proyectos de la plataforma.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.data.pending.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nada pendiente.</p>
              ) : (
                <ul className="divide-y">
                  {data.data.pending.map((r) => (
                    <SistrixRunRow
                      key={r.id}
                      run={r}
                      showProject
                      onCancel={isSuperadmin ? (id) => cancel.mutateAsync(id) : undefined}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <SettingsCard
            key={JSON.stringify(data.data.settings.frequencies)}
            data={data.data}
            canEdit={isSuperadmin}
          />
          <RequestsCard />
        </>
      )}
    </div>
  );
}
