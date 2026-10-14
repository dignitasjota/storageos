'use client';

import { type WebSeo } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useUpdateWebSettings } from '@/lib/web-settings/hooks';

/** Google corta hacia estas longitudes en el resultado de búsqueda. */
const TITLE_SOFT = 60;
const DESCRIPTION_SOFT = 160;

type SeoKey = keyof WebSeo;

interface PageDef {
  label: string;
  path: string;
  titleKey: SeoKey;
  descriptionKey: SeoKey;
  titleHint: string;
  descriptionHint: string;
}

/**
 * Títulos y descripciones para Google de la portada, `/precios` y `/contacto`,
 * independientes del claim que se ve en la portada. Vacío = generados solos.
 */
export function WebSeoCard({
  seo,
  tenantName,
  domain,
}: {
  seo: WebSeo;
  tenantName: string;
  /** Dominio propio verificado (las páginas de precios y contacto solo existen ahí). */
  domain: string | null;
}) {
  const update = useUpdateWebSettings();
  const [values, setValues] = useState<WebSeo>(seo);
  useEffect(() => setValues(seo), [seo]);

  const pages: PageDef[] = [
    {
      label: 'Portada',
      path: '/',
      titleKey: 'homeTitle',
      descriptionKey: 'homeDescription',
      titleHint: `Por defecto: tu claim o «Trasteros en <ciudad> · ${tenantName}»`,
      descriptionHint: `Por defecto: «Alquila tu trastero con ${tenantName}…»`,
    },
    {
      label: 'Precios',
      path: '/precios',
      titleKey: 'pricesTitle',
      descriptionKey: 'pricesDescription',
      titleHint: `Por defecto: «Precios de trasteros en <ciudad> · ${tenantName}»`,
      descriptionHint: 'Por defecto: tamaños, rango de precios con IVA y reserva online',
    },
    {
      label: 'Contacto',
      path: '/contacto',
      titleKey: 'contactTitle',
      descriptionKey: 'contactDescription',
      titleHint: `Por defecto: «Contacto · ${tenantName}»`,
      descriptionHint: 'Por defecto: teléfono, dirección, horario y formulario',
    },
  ];

  function set(key: SeoKey, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function save() {
    // Se mandan todos los campos: '' vuelve al texto generado.
    const payload: Record<SeoKey, string> = {
      homeTitle: '',
      homeDescription: '',
      pricesTitle: '',
      pricesDescription: '',
      contactTitle: '',
      contactDescription: '',
    };
    for (const k of Object.keys(payload) as SeoKey[]) payload[k] = (values[k] ?? '').trim();
    try {
      await update.mutateAsync({ seo: payload });
      toast.success('Textos para Google guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">SEO de la web</CardTitle>
        <CardDescription>
          El título y la descripción que muestran Google y tus anuncios. Déjalos vacíos para que se
          generen solos con tu nombre y tu ciudad.
          {!domain && ' Las páginas de precios y contacto solo existen con dominio propio.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {pages.map((p) => {
          const title = values[p.titleKey] ?? '';
          const description = values[p.descriptionKey] ?? '';
          return (
            <div key={p.path} className="space-y-3 border-b pb-6 last:border-b-0 last:pb-0">
              <p className="text-sm font-medium">
                {p.label}{' '}
                <span className="font-normal text-muted-foreground">
                  {domain ? `${domain}${p.path === '/' ? '' : p.path}` : p.path}
                </span>
              </p>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor={`seo-${p.titleKey}`}>Título</Label>
                  <Counter value={title} soft={TITLE_SOFT} />
                </div>
                <Input
                  id={`seo-${p.titleKey}`}
                  value={title}
                  maxLength={70}
                  onChange={(e) => set(p.titleKey, e.target.value)}
                  placeholder={p.titleHint}
                  className="text-base sm:text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor={`seo-${p.descriptionKey}`}>Descripción</Label>
                  <Counter value={description} soft={DESCRIPTION_SOFT} />
                </div>
                <Textarea
                  id={`seo-${p.descriptionKey}`}
                  value={description}
                  maxLength={200}
                  rows={2}
                  onChange={(e) => set(p.descriptionKey, e.target.value)}
                  placeholder={p.descriptionHint}
                  className="text-base sm:text-sm"
                />
              </div>
              {(title || description) && (
                <div className="rounded-md border bg-card p-3">
                  <p className="truncate text-xs text-muted-foreground">
                    {domain ? `https://${domain}${p.path === '/' ? '' : p.path}` : p.path}
                  </p>
                  <p className="truncate text-base text-blue-700 dark:text-blue-400">
                    {title || p.titleHint.replace('Por defecto: ', '')}
                  </p>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {description || p.descriptionHint.replace('Por defecto: ', '')}
                  </p>
                </div>
              )}
            </div>
          );
        })}
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
          Guardar textos para Google
        </Button>
      </CardContent>
    </Card>
  );
}

function Counter({ value, soft }: { value: string; soft: number }) {
  const n = value.trim().length;
  return (
    <span className={`text-xs ${n > soft ? 'text-amber-600' : 'text-muted-foreground'}`}>
      {n}/{soft}
      {n > soft && ' · Google puede cortarlo'}
    </span>
  );
}
