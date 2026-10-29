'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  useAdminAiSettings,
  useTestAdminAiSettings,
  useUpdateAdminAiSettings,
} from '@/lib/admin/ai-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

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

  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [monthly, setMonthly] = useState('300');
  const [daily, setDaily] = useState('50');
  const [portalDaily, setPortalDaily] = useState('20');
  const [webModel, setWebModel] = useState('');
  const [webMonthly, setWebMonthly] = useState('300');
  const [webDaily, setWebDaily] = useState('15');

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
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...extra,
      });
      setApiKey('');
      toast.success('Ajustes del asistente guardados. Se aplican en menos de un minuto.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function runTest() {
    try {
      const r = await test.mutateAsync();
      if (r.ok) toast.success(`${r.message} Modelo: ${r.model}.`);
      else toast.error(r.message);
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
            <Button variant="outline" onClick={runTest} disabled={test.isPending || !canEdit}>
              {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Probar conexión
            </Button>
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
