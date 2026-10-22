'use client';

import { type StaffPushStatusDto } from '@storageos/shared';
import { BellRing, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { pushSupported, urlBase64ToUint8Array } from '@/lib/push/vapid';

type State =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'not_configured' }
  | { kind: 'ready'; publicKey: string; subscribed: boolean; endpoint: string | null };

/** Llamada a la API del panel que muestra la tarjeta (equipo o super admin). */
type Fetcher = <T>(path: string, init?: { method?: 'GET' | 'POST'; json?: unknown }) => Promise<T>;

/**
 * Avisos en el móvil o el ordenador del usuario (panel instalado como app):
 * las notificaciones de la campana que piden actuar. Se activa en cada
 * dispositivo. La usan el panel del equipo (`/me/push`) y el del super admin
 * (`/admin/me/push`).
 */
export function DevicePushCard({
  fetcher,
  basePath,
  topics,
  scopeNote,
}: {
  fetcher: Fetcher;
  /** Ruta con `GET` (estado), `/subscribe` y `/unsubscribe`. */
  basePath: string;
  /** De qué avisa, para que el usuario sepa qué le llegará. */
  topics: string[];
  scopeNote?: string;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) {
        setState({ kind: 'unsupported' });
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      const current = await reg?.pushManager.getSubscription();
      const endpoint = current?.endpoint ?? null;
      const qs = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
      const status = await fetcher<StaffPushStatusDto>(`${basePath}${qs}`).catch(() => null);
      if (cancelled) return;
      if (!status?.publicKey) {
        setState({ kind: 'not_configured' });
        return;
      }
      setState({
        kind: 'ready',
        publicKey: status.publicKey,
        subscribed: status.subscribed,
        endpoint,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher, basePath]);

  async function enable() {
    if (state.kind !== 'ready') return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error('Has bloqueado las notificaciones: actívalas en los ajustes del navegador.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.publicKey) as BufferSource,
      });
      await fetcher<void>(`${basePath}/subscribe`, { method: 'POST', json: sub.toJSON() });
      setState({ ...state, subscribed: true, endpoint: sub.endpoint });
      toast.success('Avisos activados en este dispositivo');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron activar los avisos');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (state.kind !== 'ready' || !state.endpoint) return;
    setBusy(true);
    try {
      await fetcher<void>(`${basePath}/unsubscribe`, {
        method: 'POST',
        json: { endpoint: state.endpoint },
      });
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
      setState({ ...state, subscribed: false, endpoint: null });
      toast.success('Avisos desactivados en este dispositivo');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron desactivar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="size-4 text-primary" aria-hidden />
          Avisos en este dispositivo
        </CardTitle>
        <CardDescription>
          Te llegan al móvil o al ordenador al momento, aunque no tengas el panel abierto.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {state.kind === 'loading' ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : state.kind === 'unsupported' ? (
          <p className="text-muted-foreground">
            Este navegador no admite avisos. En el iPhone, instala primero la app: en Safari,
            Compartir → «Añadir a pantalla de inicio», y ábrela desde el icono.
          </p>
        ) : state.kind === 'not_configured' ? (
          <p className="text-muted-foreground">Los avisos al móvil aún no están disponibles.</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Te avisaremos de: {topics.join(', ').toLowerCase()}.{scopeNote ? ` ${scopeNote}` : ''}
            </p>
            {state.subscribed ? (
              <Button variant="outline" size="sm" onClick={disable} disabled={busy}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                Desactivar en este dispositivo
              </Button>
            ) : (
              <Button size="sm" onClick={enable} disabled={busy}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                Activar en este dispositivo
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
