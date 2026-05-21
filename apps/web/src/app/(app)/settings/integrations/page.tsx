'use client';

import Link from 'next/link';
import { useState } from 'react';

import type {
  ApiKeyDto,
  ApiKeyScope,
  ApiKeyWithPlaintextDto,
  WebhookDto,
  WebhookEventType,
  WebhookWithSecretDto,
} from '@storageos/shared';

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

const EVENT_TYPES: WebhookEventType[] = [
  'invoice.created',
  'invoice.paid',
  'invoice.overdue',
  'contract.signed',
  'lead.created',
];

export default function SettingsIntegrationsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integraciones</h1>
        <p className="text-sm text-muted-foreground">
          API keys para integraciones externas y webhooks para recibir eventos en tu sistema.
        </p>
      </div>
      <Tabs defaultValue="api-keys" className="space-y-4">
        <TabsList>
          <TabsTrigger value="api-keys">API keys</TabsTrigger>
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
  const { data, isLoading } = useApiKeys();
  const revoke = useRevokeApiKey();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<ApiKeyWithPlaintextDto | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Tokens Bearer (`sk_live_...`) para integraciones programáticas. Se muestran en plano
            solo una vez al crearlos.
          </CardDescription>
        </div>
        <Button onClick={() => setCreating(true)}>Nueva API key</Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : data && data.length > 0 ? (
          <div className="space-y-2">
            {data.map((k) => (
              <ApiKeyRow key={k.id} item={k} onRevoke={() => revoke.mutate(k.id)} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No tienes API keys todavía.</p>
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
    <div className="flex items-center justify-between rounded-md border p-3 text-sm">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{item.name}</span>
          {revoked ? <Badge variant="outline">Revocada</Badge> : <Badge>Activa</Badge>}
        </div>
        <code className="text-xs text-muted-foreground">{item.keyPrefix}.***</code>
        {item.scopes.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-1">
            {(item.scopes as readonly string[]).map((s) => (
              <Badge key={s} variant={s === '*' ? 'secondary' : 'outline'} className="text-[10px]">
                {s === '*' ? 'acceso total' : s}
              </Badge>
            ))}
          </div>
        ) : null}
        <span className="text-xs text-muted-foreground">
          Creada {new Date(item.createdAt).toLocaleString('es-ES')}
          {item.lastUsedAt
            ? ` · usada ${new Date(item.lastUsedAt).toLocaleString('es-ES')}`
            : ' · sin uso'}
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
  // Por defecto todos los scopes marcados. El backend comprime los 5 a
  // `['*']` (wildcard) al persistir, asi que si el user no toca nada la
  // key creada tiene acceso total.
  const [scopes, setScopes] = useState<ApiKeyScope[]>([...SCOPES]);

  const submit = async () => {
    if (!name.trim()) return;
    const k = await create.mutateAsync({ name: name.trim(), scopes });
    onCreated(k);
    setName('');
    setScopes([...SCOPES]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva API key</DialogTitle>
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
            <Label>Scopes</Label>
            <div className="grid grid-cols-2 gap-2">
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
                    <code className="text-xs">{s}</code>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Cada endpoint de `/integrations/*` declara el scope que requiere. Una API key sin
              ningun scope marcado se crea con acceso total (wildcard) por compatibilidad.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>
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
          <DialogTitle>API key creada</DialogTitle>
        </DialogHeader>
        <Alert>
          <AlertTitle>Guarda esta clave ahora</AlertTitle>
          <AlertDescription>
            No volverá a mostrarse. Si la pierdes, tendrás que revocarla y crear una nueva.
          </AlertDescription>
        </Alert>
        <div className="space-y-2">
          <Label>Token</Label>
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
  const { data, isLoading } = useWebhooks();
  const revoke = useRevokeWebhook();
  const rotate = useRotateWebhookSecret();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<WebhookWithSecretDto | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Webhooks salientes</CardTitle>
          <CardDescription>
            Recibe eventos firmados con HMAC SHA-256 en tu URL. Retry exponencial: 60s, 5min, 30min.
          </CardDescription>
        </div>
        <Button onClick={() => setCreating(true)}>Nuevo webhook</Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : data && data.length > 0 ? (
          <div className="space-y-2">
            {data.map((w) => (
              <WebhookRow
                key={w.id}
                item={w}
                onRevoke={() => revoke.mutate(w.id)}
                onRotate={async () => {
                  const r = await rotate.mutateAsync(w.id);
                  setRevealed(r);
                }}
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
    <div className="flex items-center justify-between rounded-md border p-3 text-sm">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{item.name}</span>
          {item.isActive ? <Badge>Activo</Badge> : <Badge variant="outline">Revocado</Badge>}
        </div>
        <code className="text-xs text-muted-foreground">{item.url}</code>
        <div className="flex flex-wrap gap-1 pt-1">
          {item.events.map((e) => (
            <Badge key={e} variant="outline" className="text-[10px]">
              {e}
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
              Rotar secret
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
    const w = await create.mutateAsync({ name: name.trim(), url: url.trim(), events });
    onCreated(w);
    setName('');
    setUrl('');
    setEvents([]);
    onOpenChange(false);
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
            <Label htmlFor="wh-url">URL</Label>
            <Input
              id="wh-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mi-app.com/webhooks/storageos"
            />
          </div>
          <div className="space-y-2">
            <Label>Eventos suscritos</Label>
            <div className="grid grid-cols-2 gap-2">
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
                    <code className="text-xs">{e}</code>
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
            onClick={submit}
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
          <DialogTitle>Secret del webhook</DialogTitle>
        </DialogHeader>
        <Alert>
          <AlertTitle>Guarda este secret ahora</AlertTitle>
          <AlertDescription>
            Lo necesitarás para verificar el HMAC SHA-256 de cada llamada. No volverá a mostrarse.
          </AlertDescription>
        </Alert>
        <div className="space-y-2">
          <Label>Signing secret</Label>
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
