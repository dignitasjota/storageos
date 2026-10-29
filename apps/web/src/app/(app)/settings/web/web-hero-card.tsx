'use client';

import { WEB_HERO_MAX_BYTES, type WebHeroSlot } from '@storageos/shared';
import { ImageIcon, Loader2, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useRemoveWebHeroImage, useUploadWebHeroImage } from '@/lib/web-settings/hooks';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Fotos de la portada de la web pública: la entrada del local (a la derecha
 * del titular) y el interior (difuminado de fondo). Sin ellas, la portada se
 * ve como siempre.
 */
export function WebHeroCard({
  heroImageUrl,
  heroBackgroundUrl,
}: {
  heroImageUrl: string | null;
  heroBackgroundUrl: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fotos de la portada</CardTitle>
        <CardDescription>
          La foto de la entrada sale a la derecha del titular y la del interior, difuminada de
          fondo. JPG, PNG o WebP; se reducen solas antes de subirlas. Si no subes ninguna, la
          portada se ve como ahora.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        <HeroSlot
          slot="image"
          title="Entrada del local"
          hint="Mejor en vertical o cuadrada. Sin ella se usa la primera foto del local."
          url={heroImageUrl}
        />
        <HeroSlot
          slot="background"
          title="Fondo: el interior"
          hint="Una foto amplia de los trasteros por dentro. Se ve difuminada detrás del texto."
          url={heroBackgroundUrl}
        />
      </CardContent>
    </Card>
  );
}

function HeroSlot({
  slot,
  title,
  hint,
  url,
}: {
  slot: WebHeroSlot;
  title: string;
  hint: string;
  url: string | null;
}) {
  const upload = useUploadWebHeroImage();
  const remove = useRemoveWebHeroImage();
  const input = useRef<HTMLInputElement>(null);
  const busy = upload.isPending || remove.isPending;

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      toast.error('Sube una foto JPG, PNG o WebP.');
      return;
    }
    try {
      await upload.mutateAsync({ slot, file });
      toast.success('Foto actualizada. Puede tardar un minuto en verse en tu web.');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error(`No se pudo subir la foto (máximo ${WEB_HERO_MAX_BYTES / 1024 / 1024} MB).`);
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  async function onRemove() {
    try {
      await remove.mutateAsync(slot);
      toast.success('Foto quitada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border bg-muted/40">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={title} className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" aria-hidden />
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED.join(',')}
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => input.current?.click()} disabled={busy}>
          {upload.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Upload className="mr-2 size-4" />
          )}
          {url ? 'Cambiar' : 'Subir foto'}
        </Button>
        {url && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void onRemove()}
            disabled={busy}
          >
            <Trash2 className="mr-2 size-4" />
            Quitar
          </Button>
        )}
      </div>
    </div>
  );
}
