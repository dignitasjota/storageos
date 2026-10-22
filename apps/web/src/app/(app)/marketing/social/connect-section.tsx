'use client';

import { type SocialPageOptionDto, type SocialSettingsDto } from '@storageos/shared';
import { Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useSocialAction } from '@/lib/marketing/hooks';

function sinceLabel(iso: string | null): string {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Pegar el token de Meta y, si da acceso a varias páginas, elegir una. */
function ConnectForm() {
  const canManage = useHasPermission('marketing:manage');
  const action = useSocialAction();
  const [token, setToken] = useState('');
  const [pages, setPages] = useState<SocialPageOptionDto[] | null>(null);

  async function connect(pageId?: string) {
    try {
      await action.mutateAsync({ accessToken: token.trim(), ...(pageId ? { pageId } : {}) });
      toast.success('Instagram y Facebook conectados');
      setPages(null);
      setToken('');
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'social_choose_page') {
        setPages((err.body.details as { pages: SocialPageOptionDto[] }).pages);
        return;
      }
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo conectar');
    }
  }

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        Pide a un responsable que conecte Instagram y Facebook.
      </p>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
        <li>
          Tu cuenta de Instagram debe ser <strong>profesional</strong> (empresa o creador) y estar
          vinculada a tu página de Facebook.
        </li>
        <li>
          En <strong>Meta Business Suite → Configuración del negocio → Usuarios del sistema</strong>
          , crea un usuario del sistema, dale acceso a tu página y genera un token con los permisos{' '}
          <code className="text-xs">pages_show_list</code>,{' '}
          <code className="text-xs">pages_read_engagement</code>,{' '}
          <code className="text-xs">read_insights</code>,{' '}
          <code className="text-xs">instagram_basic</code> e{' '}
          <code className="text-xs">instagram_manage_insights</code>. Ese token no caduca.
        </li>
        <li>Pégalo aquí. Lo guardamos cifrado y solo lo usamos para leer tus estadísticas.</li>
      </ol>
      <div className="flex max-w-xl flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token de Meta"
          autoComplete="off"
          aria-label="Token de Meta"
        />
        <Button onClick={() => connect()} disabled={token.trim().length < 20 || action.isPending}>
          {action.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
          Conectar
        </Button>
      </div>
      {pages && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="font-medium">El token da acceso a varias páginas: ¿cuál conectamos?</p>
          {pages.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => connect(p.id)}
              disabled={action.isPending}
              className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left hover:bg-accent"
            >
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted-foreground">
                {p.instagramUsername
                  ? `Instagram @${p.instagramUsername}`
                  : 'Sin Instagram vinculado'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Estado de la conexión con Meta: conectar, actualizar o desconectar. */
export function SocialConnectSection({ settings }: { settings: SocialSettingsDto }) {
  const canManage = useHasPermission('marketing:manage');
  const action = useSocialAction();
  const ask = useConfirm();

  async function sync() {
    const res = await action.mutateAsync('sync');
    if (res.status === 'error') toast.error(res.lastError ?? 'No se pudo actualizar');
    else toast.success('Datos actualizados');
  }

  async function disconnect() {
    const ok = await ask({
      title: 'Desconectar Instagram y Facebook',
      description:
        'Se borran el token y los datos descargados. Puedes volver a conectar cuando quieras.',
      confirmLabel: 'Desconectar',
      destructive: true,
    });
    if (ok) await action.mutateAsync(null);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Conexión con Meta</CardTitle>
          <CardDescription>
            {settings.connected
              ? `Página «${settings.pageName}»${settings.instagramUsername ? ` · Instagram @${settings.instagramUsername}` : ' · sin Instagram vinculado'} · actualizado ${sinceLabel(settings.lastSyncedAt)}`
              : 'Las estadísticas de tu página de Facebook y tu cuenta de Instagram, cada día.'}
          </CardDescription>
        </div>
        {settings.connected && canManage && (
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
      <CardContent className="space-y-3">
        {settings.status === 'error' && settings.lastError && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {settings.lastError}
          </p>
        )}
        {(!settings.connected || settings.status === 'error') && <ConnectForm />}
      </CardContent>
    </Card>
  );
}
