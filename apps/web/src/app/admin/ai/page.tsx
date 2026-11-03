'use client';

import { SUGGESTED_AI_MODELS } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminAiSettings,
  useAdminAiUsage,
  useTestAdminAiSettings,
  useUpdateAdminAiSettings,
} from '@/lib/admin/ai-hooks';
import { useAdminSubscriptionPlans } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime, formatNumber } from '@/lib/format';

const SOURCE_LABEL = {
  panel: 'Clave del panel',
  env: 'Clave de las variables del servidor',
  demo: 'Modo demo (sin clave)',
} as const;

/**
 * Asistente IA del panel de los tenants: clave de Anthropic y modelo (sin
 * volver a desplegar; si no hay clave aquí se usan las variables del servidor)
 * y cuántas consultas puede hacer cada tenant.
 */
export default function AdminAiPage() {
  const canEdit = useIsSuperadmin();
  const settings = useAdminAiSettings();
  const update = useUpdateAdminAiSettings();
  const test = useTestAdminAiSettings();
  const usage = useAdminAiUsage();
  const plans = useAdminSubscriptionPlans();

  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [monthly, setMonthly] = useState('300');
  const [daily, setDaily] = useState('50');
  const [portalDaily, setPortalDaily] = useState('20');
  const [webModel, setWebModel] = useState('');
  const [webMonthly, setWebMonthly] = useState('300');
  const [webDaily, setWebDaily] = useState('15');
  const [costAlert, setCostAlert] = useState('');
  const [planLimits, setPlanLimits] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);

  const loaded = useRef(false);
  useEffect(() => {
    if (!settings.data || loaded.current) return;
    loaded.current = true;
    setModel(settings.data.panelModel ?? '');
    setMonthly(String(settings.data.monthlyQueryLimit));
    setDaily(String(settings.data.dailyUserLimit));
    setPortalDaily(String(settings.data.portalDailyLimit));
    setWebModel(settings.data.panelWebModel ?? '');
    setWebMonthly(String(settings.data.webMonthlyLimit));
    setWebDaily(String(settings.data.webVisitorDailyLimit));
    setCostAlert(
      settings.data.monthlyCostAlertUsd != null ? String(settings.data.monthlyCostAlertUsd) : '',
    );
    setPlanLimits(
      Object.fromEntries(Object.entries(settings.data.planLimits).map(([k, v]) => [k, String(v)])),
    );
  }, [settings.data]);

  async function save(extra: { apiKey?: string } = {}) {
    try {
      await update.mutateAsync({
        model: model.trim(),
        monthlyQueryLimit: Math.max(0, Number.parseInt(monthly, 10) || 0),
        dailyUserLimit: Math.max(0, Number.parseInt(daily, 10) || 0),
        portalDailyLimit: Math.max(0, Number.parseInt(portalDaily, 10) || 0),
        webModel: webModel.trim(),
        webMonthlyLimit: Math.max(0, Number.parseInt(webMonthly, 10) || 0),
        webVisitorDailyLimit: Math.max(0, Number.parseInt(webDaily, 10) || 0),
        monthlyCostAlertUsd: costAlert.trim() ? Math.max(0, Number(costAlert) || 0) : null,
        planLimits: Object.fromEntries(
          Object.entries(planLimits)
            .filter(([, v]) => v.trim() !== '')
            .map(([k, v]) => [k, Math.max(0, Number.parseInt(v, 10) || 0)]),
        ),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...extra,
      });
      setApiKey('');
      toast.success('Ajustes del asistente guardados. Se aplican en menos de un minuto.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function runTest(withPrompt = false) {
    try {
      setAnswer(null);
      const r = await test.mutateAsync(withPrompt ? prompt.trim() : undefined);
      if (r.ok) {
        if (r.answer) setAnswer(r.answer);
        else toast.success(`${r.message} Modelo: ${r.model}.`);
      } else toast.error(r.message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar.');
    }
  }

  if (settings.isLoading || !settings.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const d = settings.data;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Asistente IA</h1>
        <p className="text-sm text-muted-foreground">
          La IA del asistente del panel de los tenants (no la de WhatsApp, que va aparte). Lo que
          guardes aquí manda sobre las variables del servidor, sin volver a desplegar.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Uso este mes
            {usage.data?.overAlert && <Badge variant="destructive">Supera el aviso de gasto</Badge>}
          </CardTitle>
          <CardDescription>
            Coste estimado con los precios por millón de tokens de las variables del servidor; las
            consultas con la clave propia de un tenant no cuentan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {usage.data ? (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Consultas (plataforma)" value={formatNumber(usage.data.queries, 0)} />
                <Stat
                  label="Con claves de los tenants"
                  value={formatNumber(usage.data.ownKeyQueries, 0)}
                />
                <Stat label="Gasto estimado" value={`${formatNumber(usage.data.costUsd)} $`} />
                <Stat
                  label="Previsión a fin de mes"
                  value={`${formatNumber(usage.data.projectedCostUsd)} $`}
                />
              </div>
              {usage.data.topTenants.length > 0 && (
                <div className="text-sm">
                  <p className="mb-1 font-medium">Los que más gastan</p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {usage.data.topTenants.map((t) => (
                      <li key={t.tenantId} className="flex justify-between gap-2">
                        <a href={`/admin/tenants/${t.tenantId}`} className="hover:underline">
                          {t.name}
                        </a>
                        <span>
                          {formatNumber(t.queries, 0)} llamadas · {formatNumber(t.costUsd)} $
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ai-cost-alert">Avisarme si el gasto del mes pasa de ($)</Label>
              <Input
                id="ai-cost-alert"
                type="number"
                min={0}
                step="0.01"
                value={costAlert}
                onChange={(e) => setCostAlert(e.target.value)}
                placeholder="Sin aviso"
                className="w-40 text-base sm:text-sm"
              />
            </div>
            <Button onClick={() => save()} disabled={update.isPending || !canEdit}>
              Guardar
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            El aviso sale en esta página y en el aviso diario por email.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Clave y modelo
            <Badge variant={d.source === 'demo' ? 'secondary' : 'outline'}>
              {SOURCE_LABEL[d.source]}
            </Badge>
          </CardTitle>
          <CardDescription>
            Ahora se usa el modelo <span className="font-mono">{d.model}</span>.{' '}
            {d.envKeyConfigured
              ? 'Las variables del servidor también tienen una clave: es la de respaldo si quitas la del panel.'
              : 'Las variables del servidor no tienen clave: sin la del panel, el asistente funciona en modo demo.'}
            {d.updatedAt ? ` Último cambio: ${formatDateTime(d.updatedAt)}.` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ai-key">Clave de Anthropic</Label>
              <Input
                id="ai-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  d.panelKeyConfigured ? `Guardada (termina en ${d.panelKeyLast4})` : 'sk-ant-…'
                }
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Se guarda cifrada y no se vuelve a mostrar. Déjalo vacío para no cambiarla.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-model">Modelo</Label>
              <Input
                id="ai-model"
                list="ai-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={d.envModel ?? d.model}
                className="font-mono text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Vacío ={' '}
                {d.envModel
                  ? `el de las variables del servidor (${d.envModel})`
                  : 'el de por defecto (claude-sonnet-4-6)'}
                .
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save()} disabled={update.isPending || !canEdit}>
              {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Guardar
            </Button>
            <Button
              variant="outline"
              onClick={() => void runTest()}
              disabled={test.isPending || !canEdit}
            >
              {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Probar conexión
            </Button>
            <datalist id="ai-models">
              {SUGGESTED_AI_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {d.panelKeyConfigured && (
              <Button
                variant="ghost"
                onClick={() => save({ apiKey: '' })}
                disabled={update.isPending || !canEdit}
              >
                Quitar la clave del panel
              </Button>
            )}
          </div>
          <div className="space-y-2 border-t pt-4">
            <Label htmlFor="ai-prompt">Probar con una pregunta</Label>
            <Textarea
              id="ai-prompt"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={2000}
              placeholder="¿Cómo reduzco la morosidad de mis inquilinos?"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={test.isPending || !canEdit || !prompt.trim()}
              onClick={() => void runTest(true)}
            >
              Preguntar
            </Button>
            {answer && (
              <p className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
                {answer}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Sin datos de ningún tenant; la respuesta no se guarda.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Límite de consultas</CardTitle>
          <CardDescription>
            Una consulta es una pregunta al asistente (también redactar una respuesta, una campaña o
            un texto, y lo que pregunta un inquilino en su área de clientes). Las «Sugerencias de
            hoy» no cuentan. Para dar más a un tenant: el extra «IA ampliada» o un límite propio en
            su ficha.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ai-monthly">Consultas al mes por tenant</Label>
              <Input
                id="ai-monthly"
                type="number"
                min={0}
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-daily">Consultas al día por persona</Label>
              <Input
                id="ai-daily"
                type="number"
                min={0}
                value={daily}
                onChange={(e) => setDaily(e.target.value)}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">0 = sin tope diario.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-portal-daily">
                Preguntas al día por inquilino (área de clientes)
              </Label>
              <Input
                id="ai-portal-daily"
                type="number"
                min={0}
                value={portalDaily}
                onChange={(e) => setPortalDaily(e.target.value)}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Para que un solo inquilino no gaste las consultas del negocio. 0 = sin tope.
              </p>
            </div>
          </div>
          {(plans.data ?? []).length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Consultas al mes por plan</p>
              <p className="text-xs text-muted-foreground">
                Vacío = el general. El límite propio de un tenant manda sobre el de su plan.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {(plans.data ?? []).map((p) => (
                  <div key={p.slug} className="space-y-1">
                    <Label htmlFor={`plan-${p.slug}`} className="text-xs">
                      {p.name}
                    </Label>
                    <Input
                      id={`plan-${p.slug}`}
                      type="number"
                      min={0}
                      value={planLimits[p.slug] ?? ''}
                      placeholder={monthly}
                      onChange={(e) =>
                        setPlanLimits((prev) => ({ ...prev, [p.slug]: e.target.value }))
                      }
                      className="text-base sm:text-sm"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <Button onClick={() => save()} disabled={update.isPending || !canEdit}>
            Guardar
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Chat de la web de los tenants</CardTitle>
          <CardDescription>
            El chat con IA que ven los visitantes de la web pública de cada tenant con el asistente
            IA. Sus respuestas tienen un límite propio (no gastan las consultas del panel) y usan un
            modelo más barato. Al llegar al límite, el visitante ve el teléfono, WhatsApp y el email
            del negocio; si el tenant tiene su propia clave, sigue respondiendo con ella.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ai-web-model">Modelo</Label>
              <Input
                id="ai-web-model"
                value={webModel}
                onChange={(e) => setWebModel(e.target.value)}
                placeholder={settings.data?.webModel}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Ahora: {settings.data?.webModel}. Vacío = el de por defecto.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-web-monthly">Respuestas al mes por tenant</Label>
              <Input
                id="ai-web-monthly"
                type="number"
                min={0}
                value={webMonthly}
                onChange={(e) => setWebMonthly(e.target.value)}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Se puede cambiar por tenant en su ficha.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-web-daily">Preguntas al día por visitante</Label>
              <Input
                id="ai-web-daily"
                type="number"
                min={0}
                value={webDaily}
                onChange={(e) => setWebDaily(e.target.value)}
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Además, 10 mensajes por minuto desde la misma IP.
              </p>
            </div>
          </div>
          <Button onClick={() => save()} disabled={update.isPending || !canEdit}>
            Guardar
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
