'use client';

import { OFFERED_WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS } from '@storageos/shared';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  ApiKeyDto,
  ApiKeyScope,
  ApiKeyWithPlaintextDto,
  WebhookDto,
  WebhookEventType,
  WebhookWithSecretDto,
} from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';
import {
  useApiKeys,
  useCreateApiKey,
  useCreateWebhook,
  useRevokeApiKey,
  useRevokeWebhook,
  useRotateWebhookSecret,
  useWebhooks,
} from '@/lib/integrations/hooks';

const SCOPES: ApiKeyScope[] = [
  'invoices:read',
  'invoices:write',
  'contracts:read',
  'customers:read',
  'webhooks:trigger',
];

const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'invoices:read': 'Leer facturas',
  'invoices:write': 'Crear y cambiar facturas',
  'contracts:read': 'Leer contratos',
  'customers:read': 'Leer inquilinos',
  'webhooks:trigger': 'Lanzar webhooks',
};

const EVENT_TYPES: WebhookEventType[] = [...OFFERED_WEBHOOK_EVENTS];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.body.message : fallback;
}

export default function SettingsIntegrationsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integraciones</h1>
        <p className="text-sm text-muted-foreground">
          Avisos a otros sistemas cuando pasa algo en tu cuenta (webhooks) y claves para la API.
        </p>
      </div>
      <Tabs defaultValue="api-keys" className="space-y-4">
        <TabsList>
          <TabsTrigger value="api-keys">Claves de API</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>
        <TabsContent value="api-keys">
          <ApiKeysSection />
        </TabsContent>
        <TabsContent value="webhooks">
          <WebhooksSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================================
// API keys
// ============================================================================

function ApiKeysSection() {
  const { data, isLoading, isError, refetch } = useApiKeys();
  const revoke = useRevokeApiKey();
  const ask = useConfirm();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<ApiKeyWithPlaintextDto | null>(null);

  async function onRevoke(k: ApiKeyDto) {
    const ok = await ask({
      title: `¿Revocar la clave «${k.name}»?`,
      description:
        'Lo que la use dejará de funcionar al momento. No se puede deshacer: tendrás que crear otra.',
      confirmLabel: 'Revocar',
      destructive: true,
    });
    if (!ok) return;
    try {
      await revoke.mutateAsync(k.id);
      toast.success('Clave revocada.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo revocar la clave.'));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Claves de API</CardTitle>
          <CardDescription>
            Para que otro programa se conecte a tu cuenta. La clave completa solo se ve una vez, al
            crearla.
          </CardDescription>
        </div>
        <Button onClick={() => setCreating(true)}>Nueva clave</Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <Alert>
          <AlertTitle>La API está empezando</AlertTitle>
          <AlertDescription>
            Por ahora solo permite comprobar que la clave funciona (
            <code className="text-xs">GET /v1/integrations/whoami</code>). Las consultas de
            facturas, contratos e inquilinos llegarán pronto. Para recibir avisos cuando pasa algo,
            usa los webhooks.
          </AlertDescription>
        </Alert>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : isError ? (
          <SectionError onRetry={() => void refetch()} />
        ) : data && data.length > 0 ? (
          <div className="space-y-2">
            {data.map((k) => (
              <ApiKeyRow key={k.id} item={k} onRevoke={() => void onRevoke(k)} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No tienes claves de API todavía.</p>
        )}
      </CardContent>

      <CreateApiKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(k) => setRevealed(k)}
      />

      <RevealedApiKeyDialog item={revealed} onClose={() => setRevealed(null)} />
    </Card>
  );
}

function ApiKeyRow({ item, onRevoke }: { item: ApiKeyDto; onRevoke: () => void }) {
  const revoked = !!item.revokedAt;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{item.name}</span>
          {revoked ? <Badge variant="outline">Revocada</Badge> : <Badge>Activa</Badge>}
        </div>
        <code className="truncate text-xs text-muted-foreground">{item.keyPrefix}…</code>
        {item.scopes.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-1">
            {(item.scopes as readonly string[]).map((s) => (
              <Badge key={s} variant={s === '*' ? 'secondary' : 'outline'} className="text-[10px]">
                {s === '*' ? 'Acceso total' : (SCOPE_LABELS[s as ApiKeyScope] ?? s)}
              </Badge>
            ))}
          </div>
        ) : null}
        <span className="text-xs text-muted-foreground">
          Creada {formatDateTime(item.createdAt)}
          {item.lastUsedAt ? ` · usada ${formatDateTime(item.lastUsedAt)}` : ' · sin uso'}
        </span>
      </div>
      {!revoked ? (
        <Button variant="outline" size="sm" onClick={onRevoke}>
          Revocar
        </Button>
      ) : null}
    </div>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (k: ApiKeyWithPlaintextDto) => void;
}) {
  const create = useCreateApiKey();
  const [name, setName] = useState('');
  // Hay que marcar al menos un permiso (el servidor rechaza una clave sin
  // ninguno). Por defecto, solo leer facturas.
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['invoices:read']);

  const submit = async () => {
    if (!name.trim() || scopes.length === 0) return;
    try {
      const k = await create.mutateAsync({ name: name.trim(), scopes });
      onCreated(k);
      setName('');
      setScopes(['invoices:read']);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear la clave.'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva clave de API</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="api-key-name">Nombre</Label>
            <Input
              id="api-key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mi integración"
            />
          </div>
          <div className="space-y-2">
            <Label>Qué puede hacer</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {SCOPES.map((s) => {
                const checked = scopes.includes(s);
                return (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        const isOn = v === true;
                        setScopes((cur) => (isOn ? [...cur, s] : cur.filter((x) => x !== s)));
                      }}
                    />
                    <span>{SCOPE_LABELS[s]}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Marca solo lo que vaya a necesitar el otro programa (al menos uno).
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!name.trim() || scopes.length === 0 || create.isPending}
          >
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevealedApiKeyDialog({
  item,
  onClose,
}: {
  item: ApiKeyWithPlaintextDto | null;
  onClose: () => void;
}) {
  const copy = () => {
    if (item?.keyPlaintext) navigator.clipboard.writeText(item.keyPlaintext);
  };
  return (
    <Dialog open={!!item} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clave creada</DialogTitle>
        </DialogHeader>
        <Alert>
          <AlertTitle>Guarda esta clave ahora</AlertTitle>
          <AlertDescription>
            No volverá a mostrarse. Si la pierdes, tendrás que revocarla y crear una nueva.
          </AlertDescription>
        </Alert>
        <div className="space-y-2">
          <Label>Clave</Label>
          <Input readOnly value={item?.keyPlaintext ?? ''} className="font-mono text-xs" />
          <Button variant="outline" size="sm" onClick={copy}>
            Copiar
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Hecho</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Webhooks
// ============================================================================

function WebhooksSection() {
  const { data, isLoading, isError, refetch } = useWebhooks();
  const revoke = useRevokeWebhook();
  const rotate = useRotateWebhookSecret();
  const ask = useConfirm();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<WebhookWithSecretDto | null>(null);

  async function onRevoke(w: WebhookDto) {
    const ok = await ask({
      title: `¿Revocar el webhook «${w.name}»?`,
      description:
        'Dejará de recibir avisos al momento. No se puede deshacer: tendrás que crear otro.',
      confirmLabel: 'Revocar',
      destructive: true,
    });
    if (!ok) return;
    try {
      await revoke.mutateAsync(w.id);
      toast.success('Webhook revocado.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo revocar el webhook.'));
    }
  }

  async function onRotate(w: WebhookDto) {
    const ok = await ask({
      title: '¿Renovar el secreto?',
      description:
        'El secreto actual deja de valer al momento: tendrás que poner el nuevo en tu sistema para que siga comprobando la firma.',
      confirmLabel: 'Renovar',
      destructive: true,
    });
    if (!ok) return;
    try {
      setRevealed(await rotate.mutateAsync(w.id));
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo renovar el secreto.'));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Webhooks</CardTitle>
          <CardDescription>
            Avisamos a tu dirección cada vez que pasa algo (una factura cobrada, un contrato
            firmado…), con una firma HMAC SHA-256 para que compruebes que somos nosotros. Si tu
            servidor no responde, se reintenta dos veces más: al minuto y dos minutos después.
          </CardDescription>
        </div>
        <Button onClick={() => setCreating(true)}>Nuevo webhook</Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : isError ? (
          <SectionError onRetry={() => void refetch()} />
        ) : data && data.length > 0 ? (
          <div className="space-y-2">
            {data.map((w) => (
              <WebhookRow
                key={w.id}
                item={w}
                onRevoke={() => void onRevoke(w)}
                onRotate={() => void onRotate(w)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No tienes webhooks todavía.</p>
        )}
      </CardContent>

      <CreateWebhookDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(w) => setRevealed(w)}
      />

      <RevealedWebhookDialog item={revealed} onClose={() => setRevealed(null)} />
    </Card>
  );
}

function WebhookRow({
  item,
  onRevoke,
  onRotate,
}: {
  item: WebhookDto;
  onRevoke: () => void;
  onRotate: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{item.name}</span>
          {item.isActive ? <Badge>Activo</Badge> : <Badge variant="outline">Revocado</Badge>}
        </div>
        <code className="break-all text-xs text-muted-foreground">{item.url}</code>
        <div className="flex flex-wrap gap-1 pt-1">
          {item.events.map((e) => (
            <Badge key={e} variant="outline" className="text-[10px]" title={e}>
              {WEBHOOK_EVENT_LABELS[e] ?? e}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="outline" size="sm" asChild>
          <Link href={`/settings/webhooks/${item.id}`}>Ver</Link>
        </Button>
        {item.isActive ? (
          <>
            <Button variant="outline" size="sm" onClick={onRotate}>
              Renovar secreto
            </Button>
            <Button variant="outline" size="sm" onClick={onRevoke}>
              Revocar
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CreateWebhookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (w: WebhookWithSecretDto) => void;
}) {
  const create = useCreateWebhook();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([]);

  const submit = async () => {
    if (!name.trim() || !url.trim() || events.length === 0) return;
    try {
      const w = await create.mutateAsync({ name: name.trim(), url: url.trim(), events });
      onCreated(w);
      setName('');
      setUrl('');
      setEvents([]);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear el webhook.'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo webhook</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="wh-name">Nombre</Label>
            <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wh-url">Dirección (https)</Label>
            <Input
              id="wh-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mi-app.com/webhooks/trasteros"
            />
          </div>
          <div className="space-y-2">
            <Label>Eventos suscritos</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {EVENT_TYPES.map((e) => {
                const checked = events.includes(e);
                return (
                  <label key={e} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        const isOn = v === true;
                        setEvents((cur) => (isOn ? [...cur, e] : cur.filter((x) => x !== e)));
                      }}
                    />
                    <span>
                      {WEBHOOK_EVENT_LABELS[e]}{' '}
                      <code className="text-xs text-muted-foreground">{e}</code>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!name.trim() || !url.trim() || events.length === 0 || create.isPending}
          >
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevealedWebhookDialog({
  item,
  onClose,
}: {
  item: WebhookWithSecretDto | null;
  onClose: () => void;
}) {
  const copy = () => {
    if (item?.secret) navigator.clipboard.writeText(item.secret);
  };
  return (
    <Dialog open={!!item} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Secreto del webhook</DialogTitle>
        </DialogHeader>
        <Alert>
          <AlertTitle>Guarda este secreto ahora</AlertTitle>
          <AlertDescription>
            Lo necesitarás para verificar el HMAC SHA-256 de cada llamada. No volverá a mostrarse.
          </AlertDescription>
        </Alert>
        <div className="space-y-2">
          <Label>Secreto para la firma</Label>
          <Input readOnly value={item?.secret ?? ''} className="font-mono text-xs" />
          <Button variant="outline" size="sm" onClick={copy}>
            Copiar
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Hecho</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
