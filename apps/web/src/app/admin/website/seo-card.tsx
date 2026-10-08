'use client';

import {
  PLATFORM_LOGO_MAX_BYTES,
  UpdatePlatformSeoSchema,
  type UpdatePlatformSeoInput,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminPlatformWebsite,
  useResetPlatformOgImage,
  useUpdatePlatformSeo,
  useUploadPlatformOgImage,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

/** Lo que se ve en Google si los campos quedan vacíos. */
const DEFAULT_TITLE = 'TrasterOS — Software de gestión para self-storage y trasteros';
const DEFAULT_DESCRIPTION =
  'Gestiona tu self-storage en la nube: contratos con firma electrónica, facturación Veri*Factu, cobros por SEPA y Bizum, accesos y CRM. Prueba gratis 30 días.';

/** Longitudes que Google suele mostrar sin cortar. */
const TITLE_IDEAL = 60;
const DESCRIPTION_IDEAL = 160;

function Counter({ value, ideal, max }: { value: number; ideal: number; max: number }) {
  const tone = value > ideal ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground';
  return (
    <span className={`text-xs ${tone}`}>
      {value}/{ideal}
      {value > ideal && value <= max ? ' · Google puede cortarlo' : ''}
    </span>
  );
}

/** Título, descripción, imagen para redes, verificaciones, analítica e indexación. */
export function SeoCard() {
  const { data } = useAdminPlatformWebsite();
  const update = useUpdatePlatformSeo();
  const upload = useUploadPlatformOgImage();
  const resetImage = useResetPlatformOgImage();
  const input = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<UpdatePlatformSeoInput | null>(null);
  const siteHost =
    (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://trasteros.pro').replace(/^https?:\/\//, '') ||
    'trasteros.pro';

  useEffect(() => {
    if (data && !form) {
      // Solo los campos editables (la URL de la imagen va aparte).
      const { ogImageUrl: _ignored, ...editable } = data.seo;
      setForm(editable);
    }
  }, [data, form]);

  if (!form || !data) {
    return (
      <Card>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  async function onSave() {
    if (!form) return;
    const parsed = UpdatePlatformSeoSchema.safeParse(form);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Revisa los datos.');
      return;
    }
    try {
      await update.mutateAsync(parsed.data);
      toast.success('SEO guardado. La web lo aplicará en un minuto como mucho.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Sube un PNG, JPG o WebP.');
      return;
    }
    if (file.size > PLATFORM_LOGO_MAX_BYTES) {
      toast.error('La imagen no puede pasar de 1 MB.');
      return;
    }
    try {
      await upload.mutateAsync(file);
      toast.success('Imagen guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir la imagen.');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  const previewTitle = form.title || DEFAULT_TITLE;
  const previewDescription = form.description || DEFAULT_DESCRIPTION;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">SEO de la web</CardTitle>
        <CardDescription>
          Cómo aparece trasteros.pro en Google y al compartir el enlace. Lo que dejes vacío usa el
          texto por defecto.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="seo-title">Título de la portada</Label>
            <Counter value={form.title.length} ideal={TITLE_IDEAL} max={70} />
          </div>
          <Input
            id="seo-title"
            value={form.title}
            maxLength={70}
            placeholder={DEFAULT_TITLE}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="seo-description">Descripción</Label>
            <Counter value={form.description.length} ideal={DESCRIPTION_IDEAL} max={200} />
          </div>
          <Textarea
            id="seo-description"
            value={form.description}
            maxLength={200}
            placeholder={DEFAULT_DESCRIPTION}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Incluye lo que busca tu cliente (p. ej. «software para trasteros», «self-storage») y una
            llamada a la acción.
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Vista previa en Google</p>
          <div className="rounded-lg border bg-white p-4 dark:bg-slate-950">
            <p className="truncate text-xs text-slate-600 dark:text-slate-400">{siteHost}</p>
            <p className="mt-0.5 line-clamp-1 text-lg text-[#1a0dab] dark:text-[#8ab4f8]">
              {previewTitle}
            </p>
            <p className="mt-0.5 line-clamp-2 text-sm text-slate-700 dark:text-slate-300">
              {previewDescription}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Imagen al compartir en redes y mensajería</p>
          <p className="text-xs text-muted-foreground">
            1200 × 630 px, PNG, JPG o WebP de hasta 1 MB. Sin imagen se usa una generada con la
            marca.
          </p>
          <div className="aspect-[1200/630] w-full max-w-md overflow-hidden rounded-lg border bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={data.seo.ogImageUrl ?? '/opengraph-image'}
              alt="Imagen para redes"
              className="size-full object-cover"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <Button
              variant="outline"
              onClick={() => input.current?.click()}
              disabled={upload.isPending}
            >
              {upload.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              Subir imagen
            </Button>
            {data.seo.ogImageUrl && (
              <Button
                variant="ghost"
                disabled={resetImage.isPending}
                onClick={() =>
                  void resetImage
                    .mutateAsync()
                    .then(() => toast.success('Vuelve la imagen generada con la marca.'))
                }
              >
                Usar la imagen de la marca
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="seo-google">Google Search Console</Label>
            <Input
              id="seo-google"
              value={form.googleVerification}
              placeholder="Código de verificación"
              onChange={(e) => setForm({ ...form, googleVerification: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Al añadir la propiedad, elige «Etiqueta HTML» y pega solo lo que va en{' '}
              <code>content=&quot;…&quot;</code>.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="seo-bing">Bing Webmaster Tools</Label>
            <Input
              id="seo-bing"
              value={form.bingVerification}
              placeholder="Código de verificación"
              onChange={(e) => setForm({ ...form, bingVerification: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Opción «Etiqueta meta» (<code>msvalidate.01</code>).
            </p>
          </div>
        </div>
        <p className="-mt-3 text-xs text-muted-foreground">
          En los dos, envía después el sitemap: <code>https://{siteHost}/sitemap.xml</code>
        </p>

        <div className="space-y-1">
          <Label htmlFor="seo-ga4">Google Analytics 4</Label>
          <Input
            id="seo-ga4"
            value={form.ga4MeasurementId}
            placeholder="G-XXXXXXXXXX"
            className="max-w-xs"
            onChange={(e) => setForm({ ...form, ga4MeasurementId: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Solo se carga si el visitante acepta las cookies de analítica en el aviso. Si lo
            activas, añade Google Analytics a la Política de Cookies (Comunicación → Páginas
            legales).
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="seo-org">Nombre de la empresa (datos para Google)</Label>
          <Input
            id="seo-org"
            value={form.organizationName}
            maxLength={120}
            placeholder="TrasterOS"
            className="max-w-sm"
            onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Junto con el email, el teléfono, la dirección y las redes del pie de la web, forma la
            ficha de la empresa que leen los buscadores.
          </p>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.indexable}
            onChange={(e) => setForm({ ...form, indexable: e.target.checked })}
          />
          <span>
            <span className="font-medium">Permitir que los buscadores indexen la web</span>
            <span className="block text-xs text-muted-foreground">
              Desactívalo solo si no quieres aparecer en Google (por ejemplo, mientras preparas el
              lanzamiento). Las webs de los tenants no se ven afectadas.
            </span>
          </span>
        </label>
        {!form.indexable && (
          <p className="-mt-3 text-xs text-amber-600 dark:text-amber-400">
            Con esto desactivado, Google irá retirando trasteros.pro de sus resultados.
          </p>
        )}

        <div className="flex justify-end">
          <Button onClick={() => void onSave()} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
