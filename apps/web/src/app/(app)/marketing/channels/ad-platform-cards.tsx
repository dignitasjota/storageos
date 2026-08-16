'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import {
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
  const settings = useGoogleAdsSettings();
  const update = useUpdateGoogleAdsSettings();
  const test = useTestGoogleAds();

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [developerToken, setDeveloperToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [loginCustomerId, setLoginCustomerId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const data = settings.data;
  if (data && !initialized) {
    setEnabled(data.enabled);
    setCustomerId(data.customerId ?? '');
    setLoginCustomerId(data.loginCustomerId ?? '');
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
    const res = await test.mutateAsync();
    if (res.ok) toast.success(res.message);
    else toast.error(res.message);
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
            <Label className="text-xs">Client ID</Label>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="•••.apps.googleusercontent.com"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Client secret</Label>
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={data?.hasCredentials ? '•••••••• (guardado)' : 'Pégalo'}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Developer token</Label>
            <Input
              type="password"
              value={developerToken}
              onChange={(e) => setDeveloperToken(e.target.value)}
              placeholder={data?.hasCredentials ? '•••••••• (guardado)' : 'Pégalo'}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Refresh token</Label>
            <Input
              type="password"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder={data?.hasCredentials ? '•••••••• (guardado)' : 'Pégalo'}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">ID de cuenta (customer ID)</Label>
            <Input
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="123-456-7890"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">ID de cuenta gestora (MCC, opcional)</Label>
            <Input value={loginCustomerId} onChange={(e) => setLoginCustomerId(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Sincronizar el gasto automáticamente
        </label>
        {data?.lastSyncAt && (
          <p className="text-xs text-muted-foreground">
            Última sincronización: {new Date(data.lastSyncAt).toLocaleString('es-ES')}
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
        </div>
      </CardContent>
    </Card>
  );
}

export function MetaAdsCard() {
  const settings = useMetaAdsSettings();
  const update = useUpdateMetaAdsSettings();
  const test = useTestMetaAds();

  const [accessToken, setAccessToken] = useState('');
  const [adAccountId, setAdAccountId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const data = settings.data;
  if (data && !initialized) {
    setEnabled(data.enabled);
    setAdAccountId(data.adAccountId ?? '');
    setInitialized(true);
  }

  async function save() {
    try {
      await update.mutateAsync({
        enabled,
        ...(accessToken ? { accessToken } : {}),
        ...(adAccountId ? { adAccountId } : {}),
      });
      setAccessToken('');
      toast.success('Integración con Meta Ads guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error al guardar');
    }
  }

  async function runTest() {
    const res = await test.mutateAsync();
    if (res.ok) toast.success(res.message);
    else toast.error(res.message);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Meta Ads (Facebook/Instagram)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Genera un token de acceso de larga duración desde tu Business Manager (System User o Graph
          API Explorer con permiso <code>ads_read</code>) y pégalo aquí.
        </p>
        <div className="space-y-1">
          <Label className="text-xs">Token de acceso</Label>
          <Input
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder={data?.hasAccessToken ? '•••••••• (guardado)' : 'Pégalo'}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">ID de cuenta publicitaria</Label>
          <Input
            value={adAccountId}
            onChange={(e) => setAdAccountId(e.target.value)}
            placeholder="act_1234567890 (o solo los dígitos)"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Sincronizar el gasto automáticamente
        </label>
        {data?.lastSyncAt && (
          <p className="text-xs text-muted-foreground">
            Última sincronización: {new Date(data.lastSyncAt).toLocaleString('es-ES')}
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
        </div>
      </CardContent>
    </Card>
  );
}
