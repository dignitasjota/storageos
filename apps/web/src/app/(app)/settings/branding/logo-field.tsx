'use client';

import { TENANT_LOGO_MAX_BYTES } from '@storageos/shared';
import { Loader2, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useRemoveTenantLogo, useUploadTenantLogo } from '@/lib/branding/hooks';

/**
 * Logo del tenant: se sube como fichero (PNG o JPG). La dirección pegada queda
 * como alternativa para quien ya la usaba; el icono de la app solo puede usar
 * el logo subido.
 */
export function LogoField({
  logoUrl,
  logoUploaded,
  onLogoUrlChange,
  color,
}: {
  logoUrl: string;
  logoUploaded: boolean;
  onLogoUrlChange: (value: string) => void;
  color: string;
}) {
  const upload = useUploadTenantLogo();
  const remove = useRemoveTenantLogo();
  const input = useRef<HTMLInputElement>(null);
  const [showUrl, setShowUrl] = useState(!logoUploaded && logoUrl !== '');
  const busy = upload.isPending || remove.isPending;

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      toast.error('Sube una imagen PNG o JPG.');
      return;
    }
    if (file.size > TENANT_LOGO_MAX_BYTES) {
      toast.error('El logo no puede pasar de 2 MB.');
      return;
    }
    try {
      await upload.mutateAsync(file);
      setShowUrl(false);
      toast.success('Logo actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir el logo.');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  async function onRemove() {
    try {
      await remove.mutateAsync();
      toast.success('Logo quitado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo quitar.');
    }
  }

  return (
    <div className="space-y-2">
      <Label>Logo</Label>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-14 min-w-28 items-center justify-center rounded-md border bg-muted/40 px-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Logo" className="h-10 w-auto max-w-40 object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">Sin logo</span>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Button type="button" onClick={() => input.current?.click()} disabled={busy}>
          {upload.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Upload className="mr-2 size-4" />
          )}
          {logoUrl ? 'Cambiar logo' : 'Subir logo'}
        </Button>
        {logoUploaded && (
          <Button type="button" variant="outline" onClick={() => void onRemove()} disabled={busy}>
            <Trash2 className="mr-2 size-4" />
            Quitar
          </Button>
        )}
        {logoUrl && <span className="h-1 w-16 rounded-full" style={{ backgroundColor: color }} />}
      </div>
      {logoUrl && !logoUploaded && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          Tu logo es un enlace a otra web: se ve en tu web, en el portal y en el menú del panel,
          pero el icono de la app (la de tus inquilinos y la de tu equipo) sale con tus iniciales.
          Para que salga tu logo, súbelo como archivo con «Cambiar logo».
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        PNG o JPG, máximo 2 MB. Mejor con fondo transparente y, si puede ser, un símbolo que se
        entienda en pequeño: también se usa en el icono de la app de tus inquilinos.
      </p>
      {showUrl ? (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">O enlace a tu logo</Label>
          <Input
            value={logoUploaded ? '' : logoUrl}
            onChange={(e) => onLogoUrlChange(e.target.value)}
            placeholder="https://tudominio.com/logo.png"
          />
          <p className="text-xs text-muted-foreground">
            Se verá en tu web y en el portal, pero no en el icono de la app. Guarda para aplicarlo;
            vacío no muestra logo.
          </p>
        </div>
      ) : (
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => setShowUrl(true)}
        >
          Usar un enlace en vez de subir el logo
        </button>
      )}
    </div>
  );
}
