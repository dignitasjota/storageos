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
import {
  AlertTriangle,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  MousePointerClick,
  Pencil,
  Plus,
  QrCode,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { useState } from 'react';
import { toast } from 'sonner';

import { GoogleAdsCard, MetaAdsCard } from './ad-platform-cards';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
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
import { apiFetchBlob, ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  useCreateMarketingChannel,
  useDeleteMarketingChannel,
  useMarketingChannels,
  useSuggestAdCampaign,
  useSyncAdSpend,
  useUpdateMarketingChannel,
} from '@/lib/marketing/hooks';
import { usePromotions } from '@/lib/promotions/hooks';
import { downloadQrPng } from '@/lib/qr-download';

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

/** Cada cuántos meses se renueva (null = no se renueva). */
const RENEWAL_OPTIONS: { value: string; label: string }[] = [
  { value: NONE, label: 'No se renueva' },
  { value: '1', label: 'Cada mes' },
  { value: '3', label: 'Cada 3 meses' },
  { value: '6', label: 'Cada 6 meses' },
  { value: '12', label: 'Cada año' },
];
const renewalLabel = (months: number | null) =>
  months == null
    ? null
    : (RENEWAL_OPTIONS.find((o) => o.value === String(months))?.label ?? `Cada ${months} meses`);

const AD_DRAFT_PLATFORMS = ['google_ads', 'meta_ads'] as const;
type AdDraftPlatform = (typeof AD_DRAFT_PLATFORMS)[number];

export default function MarketingChannelsPage() {
  const ask = useConfirm();
  const canManage = useHasPermission('marketing:manage');
  // El coste mensual es un gasto: sin permiso para verlos, ni la columna.
  const seeCost = useHasPermission('expenses:read');
  const hasAi = useHasFeature('ai_assistant');
  const channels = useMarketingChannels();
  const facilities = useFacilities();
  const promotions = usePromotions();
  const del = useDeleteMarketingChannel();
  const suggestAdCampaign = useSuggestAdCampaign();
  const [editing, setEditing] = useState<MarketingChannelDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [showLink, setShowLink] = useState<MarketingChannelDto | null>(null);
  const [exportingFeed, setExportingFeed] = useState(false);
  const [draftPlatform, setDraftPlatform] = useState<AdDraftPlatform>('google_ads');
  const [draftFacilityId, setDraftFacilityId] = useState(NONE);
  const [draft, setDraft] = useState<string | null>(null);

  const rows = channels.data ?? [];
  const facilityOptions = facilities.data ?? [];
  const promotionOptions = promotions.data ?? [];

  async function remove(id: string) {
    if (
      !(await ask({
        title: '¿Eliminar este canal?',
        description:
          'Su gasto y sus resultados siguen en Rendimiento (como «borrado»), su QR sigue llevando a tu web sin contar las visitas y sus gastos recurrentes se pausan.',
        destructive: true,
      }))
    )
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

  function copyDraft() {
    if (!draft) return;
    navigator.clipboard.writeText(draft).then(
      () => toast.success('Borrador copiado.'),
      () => toast.error('No se pudo copiar.'),
    );
  }

  async function generateDraft() {
    setDraft(null);
    try {
      const res = await suggestAdCampaign.mutateAsync({
        platform: draftPlatform,
        ...(draftFacilityId !== NONE ? { facilityId: draftFacilityId } : {}),
      });
      setDraft(res.draft);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar el borrador.');
    }
  }

  async function downloadCatalogFeed() {
    setExportingFeed(true);
    try {
      const blob = await apiFetchBlob('/marketing/catalog-feed');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'catalogo-trasteros.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Catálogo exportado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo exportar.');
    } finally {
      setExportingFeed(false);
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Canales de marketing</h1>
          <p className="text-sm text-muted-foreground">
            Portales inmobiliarios, Google Ads, Meta Ads, carteles… Vincula su gasto (Gastos,
            categoría Marketing) y en Rendimiento verás cuánto te cuesta cada cliente.
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
          <CardTitle className="text-base">Feed para portales inmobiliarios</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Ni Idealista ni Fotocasa ofrecen una API de publicación abierta a terceros, así que la
            publicación del anuncio la sigues haciendo tú en su web — esto exporta un CSV genérico
            (local, tipo de trastero, precio, superficie, fotos, contacto…) con todos los datos ya
            listos, para copiar/pegar sin teclear cada campo a mano.
          </p>
          <Button onClick={downloadCatalogFeed} disabled={exportingFeed} variant="outline">
            {exportingFeed ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Download className="mr-1 size-4" />
            )}
            Descargar catálogo (CSV)
          </Button>
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <Sparkles className="size-4" /> Borrador de campaña con IA
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!hasAi ? (
              <p className="text-sm text-muted-foreground">
                Redacta titulares, descripciones y palabras clave para Google Ads / Meta Ads con IA,
                a partir de tus locales y precios reales — no está en tu plan.{' '}
                <a href="/settings/saas-billing" className="underline">
                  Ver planes
                </a>
                .
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Ni Google ni Meta se integran para publicar campañas por API — esto redacta un
                  borrador (titulares, descripciones, palabras clave, público, presupuesto
                  orientativo) que copias en su gestor de campañas.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="draft-platform" className="text-xs">
                      Plataforma
                    </Label>
                    <Select
                      value={draftPlatform}
                      onValueChange={(v) => setDraftPlatform(v as AdDraftPlatform)}
                    >
                      <SelectTrigger id="draft-platform">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AD_DRAFT_PLATFORMS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {MARKETING_CHANNEL_TYPE_LABELS[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="draft-facility" className="text-xs">
                      Local a destacar (opcional)
                    </Label>
                    <Select value={draftFacilityId} onValueChange={setDraftFacilityId}>
                      <SelectTrigger id="draft-facility">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Todos los locales</SelectItem>
                        {facilityOptions.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button onClick={generateDraft} disabled={suggestAdCampaign.isPending}>
                  {suggestAdCampaign.isPending ? (
                    <Loader2 className="mr-1 size-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1 size-4" />
                  )}
                  Generar borrador
                </Button>
                {draft && (
                  <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                    <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap font-sans text-sm">
                      {draft}
                    </pre>
                    <Button type="button" variant="outline" size="sm" onClick={copyDraft}>
                      <Copy className="mr-1 size-3.5" /> Copiar
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Canales</CardTitle>
        </CardHeader>
        <CardContent>
          {channels.isError ? (
            <SectionError onRetry={() => void channels.refetch()} />
          ) : channels.isLoading ? (
            <div
              className="flex h-24 items-center justify-center"
              role="status"
              aria-label="Cargando"
            >
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
                    {seeCost && <th className="p-2 text-right">Coste/mes</th>}
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
                          {c.externalCampaignId && !c.lastSyncError && (
                            <Badge variant="outline" className="text-[10px]">
                              Gasto sincronizado
                            </Badge>
                          )}
                        </div>
                        {c.lastSyncError && (
                          <p className="mt-0.5 flex items-start gap-1 text-xs text-red-700 dark:text-red-400">
                            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                            <span>
                              El gasto no se sincroniza
                              {c.syncFailingSince
                                ? ` desde el ${formatDate(c.syncFailingSince)}`
                                : ''}
                              : {c.lastSyncError}
                            </span>
                          </p>
                        )}
                        {c.sourceConflictWith && (
                          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                            Comparte origen con «{c.sourceConflictWith}»: los contactos van a uno
                            solo (el activo más antiguo), salvo que el enlace lleve la campaña del
                            canal.
                          </p>
                        )}
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
                      <td className="p-2 text-muted-foreground">
                        {c.facilityName ?? 'Todos los locales'}
                      </td>
                      {seeCost && (
                        <td className="p-2 text-right tabular-nums">
                          {c.monthlyCost !== null ? eur(c.monthlyCost) : '—'}
                        </td>
                      )}
                      <td className="p-2 text-muted-foreground">
                        {c.renewsOn ? formatDate(c.renewsOn) : '—'}
                        {c.renewalMonths && (
                          <span className="block text-xs">{renewalLabel(c.renewalMonths)}</span>
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        <span className="inline-flex items-center gap-1">
                          <MousePointerClick className="size-3.5" /> {c.clickCount}
                        </span>
                      </td>
                      <td className="p-2">
                        <div className="flex justify-end gap-1">
                          {c.shortUrl && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-9 gap-1 px-2"
                              onClick={() => setShowLink(c)}
                            >
                              <QrCode className="size-4" /> QR
                            </Button>
                          )}
                          {canManage && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-9"
                                aria-label={`Editar ${c.name}`}
                                onClick={() => setEditing(c)}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-9 text-muted-foreground hover:text-red-600"
                                aria-label={`Eliminar ${c.name}`}
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
                Imprime este QR o el enlace en carteles o flyers. Las visitas y las reservas que
                lleguen por él cuentan para este canal ({showLink.clickCount}{' '}
                {showLink.clickCount === 1 ? 'visita' : 'visitas'} hasta ahora; la misma persona
                cuenta una vez cada media hora y las vistas previas de WhatsApp no cuentan).
              </p>
              {showLink.status !== 'active' && (
                <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  Este canal está {MARKETING_CHANNEL_STATUS_LABELS[showLink.status].toLowerCase()}:
                  el QR sigue llevando a tu web, pero no cuenta las visitas.
                </p>
              )}
              {showLink.shortUrl && (
                <>
                  <div className="flex flex-col items-center gap-3">
                    <div className="rounded-md border bg-white p-4">
                      <QRCodeCanvas
                        id={`channel-qr-${showLink.id}`}
                        value={showLink.shortUrl}
                        size={200}
                        marginSize={1}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => downloadQrPng(`channel-qr-${showLink.id}`, showLink.name)}
                    >
                      <Download className="mr-1 size-4" /> Descargar PNG
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {showLink.promoLandingName
                      ? `Lleva a la landing «${showLink.promoLandingName}».`
                      : 'Lleva a la reserva online. Para que lleve a una landing de promoción, crea el enlace desde «Enlaces y QR» de esa landing.'}
                  </p>
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
  const [renewalMonths, setRenewalMonths] = useState(
    channel?.renewalMonths ? String(channel.renewalMonths) : NONE,
  );
  const [utmSourceMatch, setUtmSourceMatch] = useState(channel?.utmSourceMatch ?? '');
  const [externalCampaignId, setExternalCampaignId] = useState(channel?.externalCampaignId ?? '');
  const [notes, setNotes] = useState(channel?.notes ?? '');
  const busy = create.isPending || update.isPending;

  async function syncNow() {
    if (!channel) return;
    try {
      // Si se acaba de escribir otra campaña, se guarda antes (si no, sincronizaba la anterior).
      const campaign = externalCampaignId.trim();
      if (campaign !== (channel.externalCampaignId ?? '')) {
        await update.mutateAsync({ id: channel.id, input: { externalCampaignId: campaign } });
      }
      const res = await sync.mutateAsync({ channelId: channel.id });
      toast.success(
        res.synced > 0
          ? `Gasto sincronizado: ${res.synced} ${res.synced === 1 ? 'día' : 'días'}, ${eur(res.totalCost)}.`
          : 'Sincronizado: sin gasto en esos días.',
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
      // Vacío lo quita (antes no había forma de borrarlo).
      monthlyCost: monthlyCost.trim() ? Number(monthlyCost) : null,
      renewsOn,
      renewalMonths: renewalMonths === NONE ? null : Number(renewalMonths),
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
              <Label htmlFor="ch-type" className="text-xs">
                Tipo
              </Label>
              <Select value={type} onValueChange={(v) => setType(v as MarketingChannelType)}>
                <SelectTrigger id="ch-type">
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
              <Label htmlFor="ch-status" className="text-xs">
                Estado
              </Label>
              <Select value={status} onValueChange={(v) => setStatus(v as MarketingChannelStatus)}>
                <SelectTrigger id="ch-status">
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
            <Label htmlFor="ch-name" className="text-xs">
              Nombre
            </Label>
            <Input
              id="ch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej.: Idealista — anuncio Local Norte"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ch-facility" className="text-xs">
                Local (opcional)
              </Label>
              <Select value={facilityId} onValueChange={setFacilityId}>
                <SelectTrigger id="ch-facility">
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
              <Label htmlFor="ch-promotion" className="text-xs">
                Promoción vinculada (opcional)
              </Label>
              <Select value={promotionId} onValueChange={setPromotionId}>
                <SelectTrigger id="ch-promotion">
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
          {promotionId !== NONE && (
            <p className="text-xs text-muted-foreground">
              Los contratos con esta promoción que no lleguen por otro canal cuentan para este (los
              clientes de un flyer que llaman o van al local).
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="ch-cost" className="text-xs">
              Coste mensual estimado (€, opcional)
            </Label>
            <Input
              id="ch-cost"
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={monthlyCost}
              onChange={(e) => setMonthlyCost(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="text-xs font-medium">Renueva el (opcional)</span>
              <div className="flex flex-wrap items-center gap-2">
                <DateSelect
                  value={renewsOn || undefined}
                  onChange={(v) => setRenewsOn(v ?? '')}
                  around
                />
                {renewsOn && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRenewsOn('')}>
                    Quitar
                  </Button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ch-renewal" className="text-xs">
                Se renueva
              </Label>
              <Select value={renewalMonths} onValueChange={setRenewalMonths}>
                <SelectTrigger id="ch-renewal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RENEWAL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {renewsOn && (
            <p className="text-xs text-muted-foreground">
              Te avisamos una semana antes para que revises lo que ha traído.
              {renewalMonths !== NONE ? ' Al pasar la fecha, avanza sola a la siguiente.' : ''}
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="ch-url" className="text-xs">
              Dirección del anuncio (opcional)
            </Label>
            <Input
              id="ch-url"
              type="url"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ch-source" className="text-xs">
              Origen a atribuir (opcional)
            </Label>
            <Input
              id="ch-source"
              value={utmSourceMatch}
              onChange={(e) => setUtmSourceMatch(e.target.value)}
              placeholder="Si lo dejas vacío, se propone según el tipo"
            />
            <p className="text-xs text-muted-foreground">
              Los contactos con este origen (`utm_source`, varios separados por comas) cuentan para
              este canal. Google Ads y Meta Ads solo cuentan el tráfico de sus anuncios (no el de
              las búsquedas ni el de las publicaciones), y un portal conocido se reconoce por su
              nombre.
            </p>
          </div>
          {AD_PLATFORM_TYPES.has(type) && (
            <div className="space-y-1">
              <Label htmlFor="ch-campaign" className="text-xs">
                ID de campaña externa (opcional)
              </Label>
              <Input
                id="ch-campaign"
                value={externalCampaignId}
                onChange={(e) => setExternalCampaignId(e.target.value)}
                placeholder={
                  type === 'google_ads'
                    ? 'ID de campaña de Google Ads'
                    : 'ID de campaña de Meta Ads'
                }
              />
              <p className="text-xs text-muted-foreground">
                Vincúlala a una campaña para sincronizar su gasto cada día (requiere activar la
                conexión con {MARKETING_CHANNEL_TYPE_LABELS[type]} arriba). La primera vez se traen
                los últimos 90 días.
              </p>
              {channel?.lastSyncAt && (
                <p className="text-xs text-muted-foreground">
                  Última sincronización: {formatDateTime(channel.lastSyncAt)}
                  {channel.lastSyncError ? ` (falló: ${channel.lastSyncError})` : ''}
                </p>
              )}
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
            <Label htmlFor="ch-notes" className="text-xs">
              Notas (opcional)
            </Label>
            <Textarea
              id="ch-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
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
