'use client';

import { CheckCircle2, Copy, Loader2, Unplug, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AssistantCard } from './assistant-card';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { formatDateTime } from '@/lib/format';
import {
  useDisconnectWhatsapp,
  useTestWhatsapp,
  useUpdateWhatsappSettings,
  useWhatsappSettings,
} from '@/lib/whatsapp/hooks';

/** Número de WhatsApp Business del negocio (Cloud API de Meta). */
export default function WhatsappSettingsPage() {
  const ask = useConfirm();
  // Sin el extra (p. ej. tras bajar de plan) solo se puede desactivar o
  // desconectar lo guardado.
  const hasFeature = useHasFeature('whatsapp_business');
  const canManage = useHasPermission('settings:manage');
  const settings = useWhatsappSettings();
  const update = useUpdateWhatsappSettings();
  const test = useTestWhatsapp();
  const disconnect = useDisconnectWhatsapp();

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [webButtonEnabled, setWebButtonEnabled] = useState(true);
  const [appSecret, setAppSecret] = useState('');

  // Se rellena una sola vez: si los ajustes se vuelven a pedir (al volver a la
  // pestaña, tras guardar) no se pisa lo que el usuario está escribiendo.
  const loaded = useRef(false);
  useEffect(() => {
    if (!settings.data || loaded.current) return;
    loaded.current = true;
    setPhoneNumberId(settings.data.phoneNumberId ?? '');
    setWabaId(settings.data.wabaId ?? '');
    setEnabled(settings.data.enabled);
    setWebButtonEnabled(settings.data.webButtonEnabled);
  }, [settings.data]);

  async function save() {
    try {
      await update.mutateAsync({
        phoneNumberId: phoneNumberId.trim(),
        wabaId: wabaId.trim(),
        ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
        enabled,
        webButtonEnabled,
      });
      setAccessToken('');
      toast.success('WhatsApp guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  /** Guarda solo el secreto de la app ('' lo quita). */
  async function saveSecret(value: string) {
    if (
      !value &&
      !(await ask({
        title: '¿Quitar la clave secreta de tu app?',
        description:
          'Sin ella se rechazan los avisos que lleguen desde tu propia app de Meta: dejarás de recibir mensajes por esa vía.',
        confirmLabel: 'Quitar',
        destructive: true,
      }))
    )
      return;
    try {
      await update.mutateAsync({ appSecret: value });
      setAppSecret('');
      toast.success(value ? 'Clave secreta guardada.' : 'Clave secreta quitada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  /** Prueba lo escrito si hay un token nuevo; si no, lo guardado. */
  async function runTest() {
    const typedToken = accessToken.trim();
    try {
      const r = await test.mutateAsync(
        typedToken
          ? {
              accessToken: typedToken,
              ...(phoneNumberId.trim() ? { phoneNumberId: phoneNumberId.trim() } : {}),
            }
          : {},
      );
      const what = typedToken
        ? 'Los datos escritos funcionan (aún sin guardar)'
        : 'Conexión correcta';
      if (r.ok) toast.success(`${what}: ${r.displayPhone ?? 'número verificado'}`);
      else toast.error(`No se pudo conectar: ${r.error ?? 'error desconocido'}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar.');
    }
  }

  async function disable() {
    try {
      await update.mutateAsync({ enabled: false });
      setEnabled(false);
      toast.success('WhatsApp desactivado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo desactivar.');
    }
  }

  async function runDisconnect() {
    if (
      !(await ask({
        title: '¿Desconectar el número de WhatsApp?',
        description:
          'Se borran el token, la clave secreta de tu app, la clave de IA del asistente y estos ajustes, y el número queda libre para conectarlo en otra cuenta. Las conversaciones se conservan, pero no podrás responder desde el panel hasta que vuelvas a conectar un número.',
        confirmLabel: 'Desconectar',
        destructive: true,
      }))
    )
      return;
    try {
      await disconnect.mutateAsync();
      loaded.current = false;
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setAppSecret('');
      setEnabled(false);
      setWebButtonEnabled(true);
      toast.success('Número desconectado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo desconectar.');
    }
  }

  if (settings.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (settings.isError) return <SectionError onRetry={() => void settings.refetch()} />;
  const data = settings.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">WhatsApp</h1>
        <p className="text-sm text-muted-foreground">
          Conecta el WhatsApp de tu negocio: aparece un botón en tu web, quien te escribe entra como
          contacto y le respondes desde el panel (menú Crecimiento → Mensajería → WhatsApp).
        </p>
      </div>

      {data?.configured && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              {data.enabled ? (
                <CheckCircle2 className="size-5 text-emerald-600" />
              ) : (
                <XCircle className="size-5 text-muted-foreground" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {data.displayPhone ?? 'Número sin comprobar'}
                  {data.verifiedName ? ` · ${data.verifiedName}` : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  {data.enabled ? 'Activo' : 'Desactivado'}
                  {data.lastCheckedAt
                    ? ` · comprobado el ${formatDateTime(data.lastCheckedAt)}`
                    : ''}
                </p>
              </div>
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {hasFeature ? (
                  <Button variant="outline" onClick={runTest} disabled={test.isPending}>
                    {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                    Probar conexión
                  </Button>
                ) : (
                  data.enabled && (
                    <Button variant="outline" onClick={disable} disabled={update.isPending}>
                      Desactivar
                    </Button>
                  )
                )}
                <Button variant="outline" onClick={runDisconnect} disabled={disconnect.isPending}>
                  {disconnect.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Unplug className="mr-2 size-4" />
                  )}
                  Desconectar número
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!hasFeature && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          WhatsApp Business ya no está en tu plan. Puedes desactivarlo o desconectar el número; para
          volver a usarlo,{' '}
          <Link href="/settings/saas-billing" className="font-medium underline">
            contrátalo en Planes y extras
          </Link>
          .
        </p>
      )}

      {hasFeature && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conexión con WhatsApp</CardTitle>
            <CardDescription>
              Los datos están en Meta (developers.facebook.com → tu app → WhatsApp → Configuración
              de la API). Usa un token de acceso permanente de un usuario del sistema.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wa-phone-id">ID del número de teléfono</Label>
                <Input
                  id="wa-phone-id"
                  inputMode="numeric"
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  placeholder="Ej.: 123456789012345"
                  className="text-base sm:text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wa-waba-id">ID de la cuenta de WhatsApp Business (opcional)</Label>
                <Input
                  id="wa-waba-id"
                  inputMode="numeric"
                  value={wabaId}
                  onChange={(e) => setWabaId(e.target.value)}
                  placeholder="Ej.: 987654321098765"
                  className="text-base sm:text-sm"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wa-token">Token de acceso</Label>
              <Input
                id="wa-token"
                type="password"
                autoComplete="off"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={
                  data?.tokenLast4
                    ? `Guardado (termina en ${data.tokenLast4}). Escribe uno nuevo para cambiarlo.`
                    : 'Pega aquí el token'
                }
                className="text-base sm:text-sm"
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
              <span>
                Activar WhatsApp
                <span className="block text-xs text-muted-foreground">
                  Al activarlo se comprueba el número con WhatsApp.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={webButtonEnabled}
                onCheckedChange={(v) => setWebButtonEnabled(v === true)}
              />
              <span>
                Mostrar el botón de WhatsApp en tu web
                <span className="block text-xs text-muted-foreground">
                  Un botón flotante en todas las páginas de tu web que abre una conversación
                  contigo.
                </span>
              </span>
            </label>
            <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              WhatsApp solo deja escribir libremente durante las 24 horas siguientes al último
              mensaje de cada contacto. Pasado ese plazo hay que esperar a que vuelva a escribir.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={save}
                disabled={update.isPending || !canManage || !phoneNumberId.trim()}
              >
                {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Guardar
              </Button>
              {canManage && accessToken.trim() && (
                <Button variant="outline" onClick={runTest} disabled={test.isPending}>
                  {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Probar estos datos
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {hasFeature && data?.configured && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Si usas tu propia app de Meta</CardTitle>
            <CardDescription>
              Si tu número está en una app de Meta tuya (developers.facebook.com), configura en ella
              el webhook de WhatsApp con estos datos y suscríbelo a «messages». Así los mensajes
              llegan a esta bandeja.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CopyField label="URL de devolución de llamada" value={data.webhookUrl} />
            {canManage ? (
              <CopyField
                label="Token de verificación"
                value={data.webhookVerifyToken ?? 'Se genera al guardar'}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                El token de verificación solo lo ven quienes pueden cambiar los ajustes.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="wa-app-secret">Clave secreta de tu app</Label>
              <Input
                id="wa-app-secret"
                type="password"
                autoComplete="off"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={
                  data.appSecretConfigured
                    ? 'Guardada. Escribe otra para cambiarla.'
                    : 'Configuración de la app → Básica → Clave secreta'
                }
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Con ella comprobamos que los avisos vienen de tu app. Sin ella, se rechazan.
              </p>
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void saveSecret(appSecret.trim())}
                  disabled={update.isPending || appSecret.trim().length < 16}
                >
                  Guardar clave secreta
                </Button>
                {data.appSecretConfigured && (
                  <Button
                    variant="ghost"
                    onClick={() => void saveSecret('')}
                    disabled={update.isPending}
                  >
                    Quitar clave secreta
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {data?.configured && <AssistantCard limited={!hasFeature} />}
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Copiar ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => toast.success('Copiado.'));
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
    </div>
  );
}
