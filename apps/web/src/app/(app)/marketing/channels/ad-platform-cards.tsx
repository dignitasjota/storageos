'use client';

import { type AdConversionStatsDto } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';
import {
  useDeleteGoogleAdsSettings,
  useDeleteMetaAdsSettings,
  useGoogleAdsSettings,
  useMetaAdsSettings,
  useTestGoogleAds,
  useTestMetaAds,
  useUpdateGoogleAdsSettings,
  useUpdateMetaAdsSettings,
} from '@/lib/marketing/hooks';

/**
 * Conexiones con plataformas de anuncios: el propio tenant pega sus
 * credenciales (generadas a mano — refresh token de Google, token de
 * Business Manager de Meta) para sincronizar el gasto por campaña vinculada
 * a un canal, en vez de introducirlo a mano cada mes.
 */
export function GoogleAdsCard() {
  const ask = useConfirm();
  const settings = useGoogleAdsSettings();
  const update = useUpdateGoogleAdsSettings();
  const test = useTestGoogleAds();
  const remove = useDeleteGoogleAdsSettings();

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [developerToken, setDeveloperToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [loginCustomerId, setLoginCustomerId] = useState('');
  const [conversionActionId, setConversionActionId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const data = settings.data;
  if (data && !initialized) {
    setEnabled(data.enabled);
    setCustomerId(data.customerId ?? '');
    setLoginCustomerId(data.loginCustomerId ?? '');
    setConversionActionId(data.conversionActionId ?? '');
    setInitialized(true);
  }

  async function save() {
    try {
      await update.mutateAsync({
        enabled,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(developerToken ? { developerToken } : {}),
        ...(refreshToken ? { refreshToken } : {}),
        ...(customerId ? { customerId } : {}),
        loginCustomerId,
        conversionActionId: conversionActionId.replace(/\D/g, ''),
      });
      setClientSecret('');
      setDeveloperToken('');
      setRefreshToken('');
      toast.success('Integración con Google Ads guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
    }
  }

  async function runTest() {
    try {
      const res = await test.mutateAsync();
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar');
    }
  }

  async function removeCreds() {
    if (
      !(await ask({
        title: '¿Borrar las credenciales de Google Ads?',
        description:
          'Se deja de sincronizar el gasto. El gasto y las métricas ya guardados se conservan.',
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync();
      setClientId('');
      setCustomerId('');
      setLoginCustomerId('');
      setEnabled(false);
      toast.success('Credenciales borradas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron borrar');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Google Ads</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Sincroniza el gasto diario de tus campañas automáticamente. Genera un refresh token desde
          el{' '}
          <a
            href="https://developers.google.com/oauthplayground"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            OAuth Playground de Google
          </a>{' '}
          con tu app de Google Ads API — no gestionamos ningún consentimiento nosotros.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="gads-client-id" className="text-xs">
              Client ID
            </Label>
            <Input
              id="gads-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="•••.apps.googleusercontent.com"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gads-client-secret" className="text-xs">
              Client secret
            </Label>
            <Input
              id="gads-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={data?.hasCredentials ? '•••••••• (guardado)' : 'Pégalo'}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="gads-dev-token" className="text-xs">
              Developer token
            </Label>
            <Input
              id="gads-dev-token"
              type="password"
              value={developerToken}
              onChange={(e) => setDeveloperToken(e.target.value)}
              placeholder={data?.hasCredentials ? '•••••••• (guardado)' : 'Pégalo'}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gads-refresh-token" className="text-xs">
              Refresh token
            </Label>
            <Input
              id="gads-refresh-token"
              type="password"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder={data?.hasCredentials ? '•••••••• (guardado)' : 'Pégalo'}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="gads-customer" className="text-xs">
              ID de cuenta (customer ID)
            </Label>
            <Input
              id="gads-customer"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="123-456-7890"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gads-mcc" className="text-xs">
              ID de cuenta gestora (MCC, opcional)
            </Label>
            <Input
              id="gads-mcc"
              value={loginCustomerId}
              onChange={(e) => setLoginCustomerId(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="gads-conversion" className="text-xs">
            Acción de conversión para los contratos firmados (opcional)
          </Label>
          <Input
            id="gads-conversion"
            inputMode="numeric"
            value={conversionActionId}
            onChange={(e) => setConversionActionId(e.target.value)}
            placeholder="Solo cifras (en Google Ads: Objetivos → Conversiones)"
          />
          <p className="text-xs text-muted-foreground">
            Cuando alguien que llegó por un anuncio firma el contrato, se lo contamos a Google Ads
            (con su clic, solo si aceptó todas las cookies). Así Google sabe qué anuncios traen
            clientes y no solo clics.
          </p>
          <ConversionStats stats={data?.conversions} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Sincronizar el gasto automáticamente
        </label>
        {data?.lastSyncAt && (
          <p className="text-xs text-muted-foreground">
            Última sincronización: {formatDateTime(data.lastSyncAt)}
          </p>
        )}
        {data?.lastError && (
          <p className="text-xs text-destructive">Último error: {data.lastError}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
          <Button
            variant="outline"
            onClick={runTest}
            disabled={test.isPending || !data?.hasCredentials}
          >
            {test.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Probar conexión
          </Button>
          {data?.hasCredentials && (
            <Button variant="ghost" onClick={removeCreds} disabled={remove.isPending}>
              Borrar credenciales
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function MetaAdsCard() {
  const ask = useConfirm();
  const settings = useMetaAdsSettings();
  const update = useUpdateMetaAdsSettings();
  const test = useTestMetaAds();
  const remove = useDeleteMetaAdsSettings();

  const [accessToken, setAccessToken] = useState('');
  const [adAccountId, setAdAccountId] = useState('');
  const [pixelId, setPixelId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const data = settings.data;
  if (data && !initialized) {
    setEnabled(data.enabled);
    setAdAccountId(data.adAccountId ?? '');
    setPixelId(data.pixelId ?? '');
    setInitialized(true);
  }

  async function save() {
    try {
      await update.mutateAsync({
        enabled,
        ...(accessToken ? { accessToken } : {}),
        ...(adAccountId ? { adAccountId } : {}),
        pixelId: pixelId.replace(/\D/g, ''),
      });
      setAccessToken('');
      toast.success('Integración con Meta Ads guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
    }
  }

  async function runTest() {
    try {
      const res = await test.mutateAsync();
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo probar');
    }
  }

  async function removeCreds() {
    if (
      !(await ask({
        title: '¿Borrar las credenciales de Meta Ads?',
        description:
          'Se deja de sincronizar el gasto. El gasto y las métricas ya guardados se conservan.',
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync();
      setAdAccountId('');
      setEnabled(false);
      toast.success('Credenciales borradas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron borrar');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Meta Ads (Facebook e Instagram)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Genera un token de acceso de larga duración desde tu Business Manager (System User o Graph
          API Explorer con permiso <code>ads_read</code>) y pégalo aquí.
        </p>
        <div className="space-y-1">
          <Label htmlFor="meta-ads-token" className="text-xs">
            Token de acceso
          </Label>
          <Input
            id="meta-ads-token"
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder={data?.hasAccessToken ? '•••••••• (guardado)' : 'Pégalo'}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="meta-ads-account" className="text-xs">
            ID de cuenta publicitaria
          </Label>
          <Input
            id="meta-ads-account"
            value={adAccountId}
            onChange={(e) => setAdAccountId(e.target.value)}
            placeholder="act_1234567890 (o solo los dígitos)"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="meta-ads-pixel" className="text-xs">
            Píxel para los contratos firmados (opcional)
          </Label>
          <Input
            id="meta-ads-pixel"
            inputMode="numeric"
            value={pixelId}
            onChange={(e) => setPixelId(e.target.value)}
            placeholder="ID del píxel (Administrador de eventos)"
          />
          <p className="text-xs text-muted-foreground">
            Cuando alguien que llegó por un anuncio de Facebook o Instagram firma el contrato, se lo
            contamos a Meta (con su clic y su email y teléfono cifrados, solo si aceptó todas las
            cookies).
          </p>
          <ConversionStats stats={data?.conversions} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Sincronizar el gasto automáticamente
        </label>
        {data?.lastSyncAt && (
          <p className="text-xs text-muted-foreground">
            Última sincronización: {formatDateTime(data.lastSyncAt)}
          </p>
        )}
        {data?.lastError && (
          <p className="text-xs text-destructive">Último error: {data.lastError}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
          <Button
            variant="outline"
            onClick={runTest}
            disabled={test.isPending || !data?.hasAccessToken}
          >
            {test.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Probar conexión
          </Button>
          {data?.hasAccessToken && (
            <Button variant="ghost" onClick={removeCreds} disabled={remove.isPending}>
              Borrar credenciales
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Contratos devueltos a la plataforma en los últimos 30 días. */
function ConversionStats({ stats }: { stats: AdConversionStatsDto | undefined }) {
  if (!stats || (stats.sent === 0 && stats.failed === 0)) return null;
  return (
    <div className="text-xs">
      <p className="text-muted-foreground">
        Últimos 30 días: {stats.sent} {stats.sent === 1 ? 'contrato enviado' : 'contratos enviados'}
        {stats.lastSentAt ? ` (el último, ${formatDateTime(stats.lastSentAt)})` : ''}.
      </p>
      {stats.failed > 0 && (
        <p className="text-destructive">
          {stats.failed} {stats.failed === 1 ? 'no se pudo enviar' : 'no se pudieron enviar'}
          {stats.lastError ? `: ${stats.lastError}` : ''}. Al guardar otra configuración se vuelven
          a intentar.
        </p>
      )}
    </div>
  );
}
