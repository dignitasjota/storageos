'use client';

import { Loader2, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useRemoveTenantFavicon, useUploadTenantFavicon } from '@/lib/branding/hooks';

const MAX_BYTES = 512 * 1024;

/** Icono de la pestaña del navegador en la web pública del tenant. */
export function FaviconCard({ faviconUrl }: { faviconUrl: string | null }) {
  const upload = useUploadTenantFavicon();
  const remove = useRemoveTenantFavicon();
  const input = useRef<HTMLInputElement>(null);
  const busy = upload.isPending || remove.isPending;

  async function onFile(file: File | undefined) {
    if (!file) return;
    const isIco = file.type === 'image/x-icon' || file.name.toLowerCase().endsWith('.ico');
    if (!isIco && file.type !== 'image/png') {
      toast.error('Sube una imagen PNG o ICO.');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('El favicon no puede pasar de 512 KB.');
      return;
    }
    try {
      await upload.mutateAsync(file);
      toast.success('Favicon actualizado. Puede tardar un minuto en verse en tu web.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir el favicon.');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  async function onRemove() {
    try {
      await remove.mutateAsync();
      toast.success('Favicon quitado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Favicon de tu web</CardTitle>
        <CardDescription>
          El icono que se ve en la pestaña del navegador y en los favoritos de tu web pública. PNG
          cuadrado (recomendado 512 × 512 px) o ICO, máximo 512 KB. Sin favicon se usa el de
          TrasterOS.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-lg border bg-muted/40">
          {faviconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={faviconUrl} alt="Favicon" className="h-10 w-10 object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">Sin icono</span>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/x-icon,.ico"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Button type="button" onClick={() => input.current?.click()} disabled={busy}>
          {upload.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Upload className="mr-2 size-4" />
          )}
          {faviconUrl ? 'Cambiar favicon' : 'Subir favicon'}
        </Button>
        {faviconUrl && (
          <Button type="button" variant="outline" onClick={() => void onRemove()} disabled={busy}>
            <Trash2 className="mr-2 size-4" />
            Quitar
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
