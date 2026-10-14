'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import {
  useTestWhatsapp,
  useUpdateWhatsappSettings,
  useWhatsappSettings,
} from '@/lib/whatsapp/hooks';

/** Número de WhatsApp Business del negocio (Cloud API de Meta). */
export default function WhatsappSettingsPage() {
  const settings = useWhatsappSettings();
  const update = useUpdateWhatsappSettings();
  const test = useTestWhatsapp();

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [webButtonEnabled, setWebButtonEnabled] = useState(true);

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

  async function runTest() {
    try {
      const r = await test.mutateAsync();
      if (r.ok) toast.success(`Conexión correcta: ${r.displayPhone ?? 'número verificado'}`);
      else toast.error(`No se pudo conectar: ${r.error ?? 'error desconocido'}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar.');
    }
  }

  if (settings.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
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
                    ? ` · comprobado el ${new Date(data.lastCheckedAt).toLocaleString('es-ES')}`
                    : ''}
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={runTest} disabled={test.isPending}>
              {test.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Probar conexión
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conexión con WhatsApp</CardTitle>
          <CardDescription>
            Los datos están en Meta (developers.facebook.com → tu app → WhatsApp → Configuración de
            la API). Usa un token de acceso permanente de un usuario del sistema.
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
                Un botón flotante en todas las páginas de tu web que abre una conversación contigo.
              </span>
            </span>
          </label>
          <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            WhatsApp solo deja escribir libremente durante las 24 horas siguientes al último mensaje
            de cada contacto. Pasado ese plazo hay que esperar a que vuelva a escribir.
          </p>
          <Button onClick={save} disabled={update.isPending || !phoneNumberId.trim()}>
            {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Guardar
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
