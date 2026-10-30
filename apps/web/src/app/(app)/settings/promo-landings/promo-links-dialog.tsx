'use client';

import {
  MARKETING_CHANNEL_TYPE_LABELS,
  type MarketingChannelType,
  type PromoLandingDto,
} from '@storageos/shared';
import { Copy, Download, QrCode } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useCreateMarketingChannel, useMarketingChannels } from '@/lib/marketing/hooks';
import { downloadQrPng } from '@/lib/qr-download';

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm';

/** Orígenes habituales de una promoción y su tipo de canal de marketing. */
const ORIGINS: { label: string; type: MarketingChannelType; hint: string }[] = [
  { label: 'Flyer o cartel', type: 'physical', hint: 'Imprime el QR o el enlace corto.' },
  { label: 'QR del escaparate', type: 'physical', hint: 'Imprime el QR.' },
  {
    label: 'Instagram / Facebook',
    type: 'meta_ads',
    hint: 'Pega el enlace en la bio o el anuncio.',
  },
  { label: 'Google Ads', type: 'google_ads', hint: 'Pega el enlace como URL final del anuncio.' },
  {
    label: 'Portal inmobiliario',
    type: 'real_estate_portal',
    hint: 'Pega el enlace en el anuncio.',
  },
  { label: 'Otro', type: 'other', hint: '' },
];

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(() => toast.success('Enlace copiado.'));
}

/**
 * Enlaces de una landing por origen (flyer, QR, Instagram, Google…). Cada
 * origen es un canal de marketing: su enlace lleva las variables de seguimiento
 * y su enlace corto / QR cuenta los clics; el coste y el informe de
 * rendimiento salen en Marketing → Canales.
 */
export function PromoLinksDialog({
  landing,
  onOpenChange,
}: {
  landing: PromoLandingDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const channels = useMarketingChannels();
  const create = useCreateMarketingChannel();
  const [origin, setOrigin] = useState(0);
  const [name, setName] = useState('');
  const [showQr, setShowQr] = useState<string | null>(null);

  const mine = (channels.data ?? []).filter((c) => c.promoLandingId === landing?.id);
  const selected = ORIGINS[origin]!;

  async function add() {
    if (!landing) return;
    try {
      const created = await create.mutateAsync({
        name: name.trim() || `${selected.label} — ${landing.name}`,
        type: selected.type,
        promoLandingId: landing.id,
        status: 'active',
      });
      setName('');
      setShowQr(created.id);
      toast.success('Enlace creado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={!!landing} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enlaces y QR · {landing?.name}</DialogTitle>
          <DialogDescription>
            Un enlace por cada sitio donde anuncias la promoción, para saber de dónde vienen las
            visitas y las reservas. El coste de cada uno se apunta en Marketing → Canales.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 rounded-md border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <Label htmlFor="pl-origin">Dónde lo vas a poner</Label>
            <select
              id="pl-origin"
              className={selectClass}
              value={origin}
              onChange={(e) => setOrigin(Number(e.target.value))}
            >
              {ORIGINS.map((o, i) => (
                <option key={o.label} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="pl-channel-name">Nombre (opcional)</Label>
            <Input
              id="pl-channel-name"
              value={name}
              placeholder="Flyer buzoneo Mislata"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button onClick={() => void add()} disabled={create.isPending}>
            Crear enlace
          </Button>
          {selected.hint && (
            <p className="text-xs text-muted-foreground sm:col-span-3">{selected.hint}</p>
          )}
        </div>

        {mine.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            Aún no hay enlaces. Si alguien entra sin ninguno, la visita cuenta como «web».
          </p>
        ) : (
          <ul className="divide-y">
            {mine.map((c) => (
              <li key={c.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {c.name}{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      · {MARKETING_CHANNEL_TYPE_LABELS[c.type]} · {c.clickCount}{' '}
                      {c.clickCount === 1 ? 'clic' : 'clics'} en el enlace corto
                    </span>
                  </p>
                  {c.shortUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowQr(showQr === c.id ? null : c.id)}
                    >
                      <QrCode className="mr-1 h-4 w-4" />
                      QR
                    </Button>
                  )}
                </div>
                {c.landingUrl && (
                  <div className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-xs text-muted-foreground">Enlace</span>
                    <Input readOnly value={c.landingUrl} className="font-mono text-xs" />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Copiar enlace"
                      onClick={() => copy(c.landingUrl!)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                )}
                {c.shortUrl && (
                  <div className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-xs text-muted-foreground">Corto</span>
                    <Input readOnly value={c.shortUrl} className="font-mono text-xs" />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Copiar enlace corto"
                      onClick={() => copy(c.shortUrl!)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                )}
                {showQr === c.id && c.shortUrl && (
                  <div className="flex items-end gap-3">
                    <div className="rounded-md bg-white p-3">
                      <QRCodeCanvas
                        id={`qr-${c.id}`}
                        value={c.shortUrl}
                        size={180}
                        marginSize={1}
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadQrPng(`qr-${c.id}`, c.name)}
                    >
                      <Download className="mr-1 h-4 w-4" />
                      Descargar PNG
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
