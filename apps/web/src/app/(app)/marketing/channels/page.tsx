'use client';

import {
  MARKETING_CHANNEL_STATUS_LABELS,
  MARKETING_CHANNEL_TYPE_LABELS,
  MarketingChannelStatusEnum,
  MarketingChannelTypeEnum,
  type MarketingChannelDto,
  type MarketingChannelStatus,
  type MarketingChannelType,
} from '@storageos/shared';
import { Copy, ExternalLink, Loader2, MousePointerClick, Pencil, Plus, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { toast } from 'sonner';

import { GoogleAdsCard, MetaAdsCard } from './ad-platform-cards';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import {
  useCreateMarketingChannel,
  useDeleteMarketingChannel,
  useMarketingChannels,
  useSyncAdSpend,
  useUpdateMarketingChannel,
} from '@/lib/marketing/hooks';
import { usePromotions } from '@/lib/promotions/hooks';

const NONE = '__none__';
const AD_PLATFORM_TYPES = new Set(['google_ads', 'meta_ads']);
const TYPES = MarketingChannelTypeEnum.options;
const STATUSES = MarketingChannelStatusEnum.options;

const STATUS_VARIANT: Record<MarketingChannelStatus, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  paused: 'secondary',
  ended: 'outline',
};

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export default function MarketingChannelsPage() {
  const canManage = useHasPermission('marketing:manage');
  const channels = useMarketingChannels();
  const facilities = useFacilities();
  const promotions = usePromotions();
  const del = useDeleteMarketingChannel();
  const [editing, setEditing] = useState<MarketingChannelDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [showLink, setShowLink] = useState<MarketingChannelDto | null>(null);

  const rows = channels.data ?? [];
  const facilityOptions = facilities.data ?? [];
  const promotionOptions = promotions.data ?? [];

  async function remove(id: string) {
    if (!window.confirm('¿Eliminar este canal? El histórico de gasto/rendimiento se conserva.'))
      return;
    try {
      await del.mutateAsync(id);
      toast.success('Canal eliminado.');
    } catch {
      toast.error('No se pudo eliminar.');
    }
  }

  function copyLink(url: string) {
    navigator.clipboard.writeText(url).then(
      () => toast.success('Enlace copiado.'),
      () => toast.error('No se pudo copiar.'),
    );
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Canales de marketing</h1>
          <p className="text-sm text-muted-foreground">
            Portales inmobiliarios, Google/Meta Ads, publicidad física… Vincula el gasto (Gastos →
            categoría Marketing) para ver el rendimiento de cada canal.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-4" /> Nuevo canal
          </Button>
        )}
      </div>

      {canManage && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Conexiones con plataformas de anuncios
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <GoogleAdsCard />
            <MetaAdsCard />
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Canales</CardTitle>
        </CardHeader>
        <CardContent>
          {channels.isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sin canales todavía. Crea el primero (p. ej. tu anuncio en Idealista).
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">Canal</th>
                    <th className="p-2">Tipo</th>
                    <th className="p-2">Estado</th>
                    <th className="p-2">Local</th>
                    <th className="p-2 text-right">Coste/mes</th>
                    <th className="p-2">Renueva</th>
                    <th className="p-2 text-right">Clics</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="p-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{c.name}</span>
                          {c.externalCampaignId && (
                            <Badge variant="outline" className="text-[10px]">
                              Gasto sincronizado
                            </Badge>
                          )}
                        </div>
                        {c.externalUrl && (
                          <a
                            href={c.externalUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="size-3" /> Ver anuncio
                          </a>
                        )}
                      </td>
                      <td className="p-2">{MARKETING_CHANNEL_TYPE_LABELS[c.type]}</td>
                      <td className="p-2">
                        <Badge variant={STATUS_VARIANT[c.status]}>
                          {MARKETING_CHANNEL_STATUS_LABELS[c.status]}
                        </Badge>
                      </td>
                      <td className="p-2 text-muted-foreground">{c.facilityName ?? '— General'}</td>
                      <td className="p-2 text-right tabular-nums">
                        {c.monthlyCost !== null ? eur(c.monthlyCost) : '—'}
                      </td>
                      <td className="p-2 text-muted-foreground">{c.renewsOn ?? '—'}</td>
                      <td className="p-2 text-right tabular-nums">
                        {c.shortUrl ? (
                          <button
                            type="button"
                            onClick={() => setShowLink(c)}
                            className="inline-flex items-center gap-1 hover:text-foreground"
                            title="Ver enlace corto / QR"
                          >
                            <MousePointerClick className="size-3.5" /> {c.clickCount}
                          </button>
                        ) : (
                          c.clickCount
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex justify-end gap-1">
                          {canManage && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                aria-label="Editar"
                                onClick={() => setEditing(c)}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-muted-foreground hover:text-red-600"
                                aria-label="Eliminar"
                                onClick={() => remove(c.id)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {(creating || editing) && (
        <ChannelDialog
          channel={editing}
          facilities={facilityOptions}
          promotions={promotionOptions}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {showLink && (
        <Dialog open onOpenChange={(o) => !o && setShowLink(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Enlace corto — {showLink.name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Imprime este QR o el enlace en carteles/flyers. Cada visita se cuenta y se atribuye
                a este canal ({showLink.clickCount} clic
                {showLink.clickCount === 1 ? '' : 's'} hasta ahora).
              </p>
              {showLink.shortUrl && (
                <>
                  <div className="flex justify-center rounded-md border bg-white p-4">
                    <QRCodeSVG value={showLink.shortUrl} size={160} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={showLink.shortUrl} className="font-mono text-xs" />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => copyLink(showLink.shortUrl!)}
                      aria-label="Copiar enlace"
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function ChannelDialog({
  channel,
  facilities,
  promotions,
  onClose,
}: {
  channel: MarketingChannelDto | null;
  facilities: { id: string; name: string }[];
  promotions: { id: string; code: string; name: string }[];
  onClose: () => void;
}) {
  const create = useCreateMarketingChannel();
  const update = useUpdateMarketingChannel();
  const sync = useSyncAdSpend();
  const [type, setType] = useState<MarketingChannelType>(channel?.type ?? 'other');
  const [name, setName] = useState(channel?.name ?? '');
  const [status, setStatus] = useState<MarketingChannelStatus>(channel?.status ?? 'active');
  const [facilityId, setFacilityId] = useState(channel?.facilityId ?? NONE);
  const [promotionId, setPromotionId] = useState(channel?.promotionId ?? NONE);
  const [externalUrl, setExternalUrl] = useState(channel?.externalUrl ?? '');
  const [monthlyCost, setMonthlyCost] = useState(
    channel?.monthlyCost !== null && channel?.monthlyCost !== undefined
      ? String(channel.monthlyCost)
      : '',
  );
  const [renewsOn, setRenewsOn] = useState(channel?.renewsOn ?? '');
  const [utmSourceMatch, setUtmSourceMatch] = useState(channel?.utmSourceMatch ?? '');
  const [externalCampaignId, setExternalCampaignId] = useState(channel?.externalCampaignId ?? '');
  const [notes, setNotes] = useState(channel?.notes ?? '');
  const busy = create.isPending || update.isPending;

  async function syncNow() {
    if (!channel) return;
    try {
      const res = await sync.mutateAsync({ channelId: channel.id });
      toast.success(
        res.synced > 0
          ? `Gasto sincronizado: ${res.synced} día(s), ${res.totalCost.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}.`
          : 'Sincronizado: sin gasto en el periodo.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo sincronizar.');
    }
  }

  async function save() {
    if (!name.trim()) {
      toast.error('Indica un nombre para el canal.');
      return;
    }
    const payload = {
      type,
      name: name.trim(),
      status,
      facilityId: facilityId === NONE ? null : facilityId,
      promotionId: promotionId === NONE ? null : promotionId,
      externalUrl: externalUrl.trim(),
      ...(monthlyCost.trim() ? { monthlyCost: Number(monthlyCost) } : { monthlyCost: undefined }),
      renewsOn,
      utmSourceMatch: utmSourceMatch.trim(),
      externalCampaignId: externalCampaignId.trim(),
      notes: notes.trim(),
    };
    try {
      if (channel) await update.mutateAsync({ id: channel.id, input: payload });
      else await create.mutateAsync(payload);
      toast.success('Canal guardado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{channel ? 'Editar canal' : 'Nuevo canal de marketing'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Tipo</Label>
              <Select value={type} onValueChange={(v) => setType(v as MarketingChannelType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {MARKETING_CHANNEL_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Estado</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as MarketingChannelStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {MARKETING_CHANNEL_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Nombre</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej.: Idealista — anuncio Local Norte"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Local (opcional)</Label>
              <Select value={facilityId} onValueChange={setFacilityId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Todos los locales</SelectItem>
                  {facilities.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Promoción vinculada (opcional)</Label>
              <Select value={promotionId} onValueChange={setPromotionId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Ninguna</SelectItem>
                  {promotions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.code} — {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Coste mensual estimado (€, opcional)</Label>
              <Input
                type="number"
                step="0.01"
                value={monthlyCost}
                onChange={(e) => setMonthlyCost(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Renueva el (opcional)</Label>
              <Input type="date" value={renewsOn} onChange={(e) => setRenewsOn(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">URL del anuncio/listado (opcional)</Label>
            <Input
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Origen a atribuir (opcional)</Label>
            <Input
              value={utmSourceMatch}
              onChange={(e) => setUtmSourceMatch(e.target.value)}
              placeholder="Se rellena solo a partir del nombre si lo dejas vacío"
            />
            <p className="text-xs text-muted-foreground">
              Los leads con este origen (o `utm_source`) se atribuyen a este canal en el
              rendimiento.
            </p>
          </div>
          {AD_PLATFORM_TYPES.has(type) && (
            <div className="space-y-1">
              <Label className="text-xs">ID de campaña externa (opcional)</Label>
              <Input
                value={externalCampaignId}
                onChange={(e) => setExternalCampaignId(e.target.value)}
                placeholder={
                  type === 'google_ads'
                    ? 'ID de campaña de Google Ads'
                    : 'ID de campaña de Meta Ads'
                }
              />
              <p className="text-xs text-muted-foreground">
                Vincúlala a una campaña para sincronizar su gasto automáticamente (requiere activar
                la conexión con {MARKETING_CHANNEL_TYPE_LABELS[type]} arriba).
              </p>
              {channel && externalCampaignId.trim() && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={syncNow}
                  disabled={sync.isPending}
                >
                  {sync.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  Sincronizar gasto ahora
                </Button>
              )}
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Notas (opcional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
