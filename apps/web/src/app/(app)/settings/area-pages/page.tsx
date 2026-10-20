'use client';

import { MAX_NEARBY_AREA_PAGES, type AreaPageOverviewDto } from '@storageos/shared';
import { ExternalLink, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { SettingsHeader } from '../settings-header';

import { AreaPageDialog, type AreaPageTarget } from './area-page-dialog';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAreaPages, useDeleteAreaPage } from '@/lib/area-pages/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission, useMe } from '@/lib/auth/hooks';
import { useTenantBranding } from '@/lib/branding/hooks';

function Status({ p }: { p: AreaPageOverviewDto }) {
  if (p.redirect?.to === 'home') return <Badge variant="secondary">Lleva a la portada</Badge>;
  if (p.warnings.includes('not_published')) return <Badge variant="secondary">Apagada</Badge>;
  if (p.warnings.includes('no_facilities')) return <Badge variant="destructive">Sin locales</Badge>;
  if (!p.indexable) return <Badge variant="outline">En la web, sin ofrecer a Google</Badge>;
  return <Badge>En Google</Badge>;
}

function Warnings({ p }: { p: AreaPageOverviewDto }) {
  const lines: string[] = [];
  if (p.soleFacilityName) {
    lines.push(
      `Es tu único local en esta ciudad: la página muestra la ficha completa de ${p.soleFacilityName} y su dirección redirige aquí.`,
    );
  }
  if (p.warnings.includes('no_intro'))
    lines.push('Sin texto propio: ahora solo tiene el texto generado.');
  if (p.warnings.includes('short_intro')) {
    lines.push(
      p.kind === 'nearby'
        ? `Solo ${p.introWords} palabras: necesita 120 para ofrecerla a Google.`
        : `Solo ${p.introWords} palabras de texto propio: conviene ampliarlo.`,
    );
  }
  if (p.warnings.includes('no_facilities')) lines.push('Elige qué local se muestra.');
  if (lines.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

export default function AreaPagesPage() {
  const ask = useConfirm();
  const data = useAreaPages();
  const remove = useDeleteAreaPage();
  const me = useMe();
  const branding = useTenantBranding();
  const canManage = useHasPermission('settings:manage');
  const [target, setTarget] = useState<AreaPageTarget | null>(null);

  const domain =
    branding.data?.customDomain && branding.data.customDomainVerifiedAt
      ? branding.data.customDomain
      : null;
  const site =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (typeof window !== 'undefined' ? window.location.origin : '');
  const urlOf = (slug: string) =>
    domain
      ? `https://${domain}/trasteros-en-${slug}`
      : `${site}/s/${me.data?.tenant.slug ?? ''}/trasteros-en-${slug}`;

  const pages = data.data?.pages ?? [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const overview = data.data?.overview ?? [];
  const cities = overview.filter((p) => p.kind === 'city');
  const nearby = overview.filter((p) => p.kind === 'nearby');

  async function del(p: AreaPageOverviewDto) {
    if (!p.pageId) return;
    const ok = await ask({
      title: p.kind === 'city' ? 'Quitar el texto propio' : 'Borrar la página',
      description:
        p.kind === 'city'
          ? 'La página de la ciudad sigue existiendo con el texto generado.'
          : 'La dirección dejará de existir.',
      confirmLabel: 'Borrar',
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(p.pageId);
      toast.success('Borrado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  function Row({ p }: { p: AreaPageOverviewDto }) {
    const saved = p.pageId ? (byId.get(p.pageId) ?? null) : null;
    return (
      <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              Trasteros {p.kind === 'nearby' ? 'cerca de' : 'en'} {p.name}
            </span>
            <Status p={p} />
          </div>
          <p className="truncate text-xs text-muted-foreground">{urlOf(p.slug)}</p>
          {p.facilityNames.length > 0 && (
            <p className="text-xs text-muted-foreground">{p.facilityNames.join(', ')}</p>
          )}
          <Warnings p={p} />
        </div>
        <div className="flex shrink-0 gap-1">
          {!p.redirect && (
            <Button asChild variant="ghost" size="icon" aria-label="Abrir" title="Abrir">
              <a href={urlOf(p.slug)} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          )}
          {canManage && p.redirect?.to !== 'home' && (
            <Button
              variant={p.pageId ? 'ghost' : 'outline'}
              size={p.pageId ? 'icon' : 'sm'}
              aria-label="Editar"
              title="Editar"
              onClick={() =>
                setTarget(
                  p.kind === 'city'
                    ? { kind: 'city', name: p.name, slug: p.slug, page: saved }
                    : { kind: 'nearby', page: saved },
                )
              }
            >
              {p.pageId ? <Pencil className="h-4 w-4" /> : 'Escribir texto'}
            </Button>
          )}
          {canManage && p.pageId && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Borrar"
              title="Borrar"
              onClick={() => del(p)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <SettingsHeader
        title="Páginas de zona"
        description="Las páginas «trasteros en <ciudad>» de tu web, que es lo que más se busca en Google. Ponles texto propio: es lo que las diferencia. Incluido en el extra SEO local."
      />

      {data.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Tus ciudades</CardTitle>
              <CardDescription>
                Una por cada ciudad donde tienes un local. Con un solo local en la ciudad, esta
                página muestra la ficha completa del local y la dirección de la ficha redirige aquí
                (así no hay dos páginas iguales compitiendo en Google).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.data?.singleFacility && (
                <p className="mb-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">
                  Tienes un solo local: tu portada es tu página de «trasteros en tu ciudad». El
                  título para Google se cambia en Configuración → Web → SEO. Puedes añadir zonas
                  cercanas abajo.
                </p>
              )}
              {cities.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Pon la ciudad en la dirección de tus locales para que aparezcan aquí.
                </p>
              ) : (
                <ul className="divide-y">
                  {cities.map((p) => (
                    <Row key={p.slug} p={p} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div className="space-y-1.5">
                <CardTitle>
                  Zonas cercanas ({nearby.length}/{MAX_NEARBY_AREA_PAGES})
                </CardTitle>
                <CardDescription>
                  Pueblos donde no tienes local pero das servicio. Solo se ofrecen a Google con 120
                  palabras de texto propio. Pocas y bien escritas: muchas páginas casi iguales hacen
                  más daño que bien.
                </CardDescription>
              </div>
              {canManage && (
                <Button
                  disabled={nearby.length >= MAX_NEARBY_AREA_PAGES}
                  onClick={() => setTarget({ kind: 'nearby', page: null })}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Nueva zona
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {nearby.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aún no hay zonas cercanas.</p>
              ) : (
                <ul className="divide-y">
                  {nearby.map((p) => (
                    <Row key={p.slug} p={p} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>El perfil de Google de cada local</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                Lo que más mueve las búsquedas locales es el perfil de Google Business de cada
                local. En el enlace a la web de cada perfil pon la página de su ciudad
                (`trasteros-en-…`) o, si la ciudad tiene varios locales, la ficha de ese local; no
                la portada.
              </p>
              <p>
                El nombre, la dirección y el teléfono deben ser exactamente los mismos en Google y
                en la web.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      <AreaPageDialog target={target} onClose={() => setTarget(null)} />
    </div>
  );
}
