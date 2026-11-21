'use client';

import {
  FEATURE_LABELS,
  PRODUCT_UPDATE_CATEGORY_LABELS,
  PRODUCT_UPDATE_CATEGORY_SLUGS,
  ProductUpdateCategoryEnum,
  productUpdateCategoryFromSlug,
  type ProductUpdateCategory,
  type ProductUpdateDto,
  type ProductUpdateReaction,
} from '@storageos/shared';
import { ArrowRight, Gift, Loader2, Search, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { MarkdownView } from '@/components/public/markdown-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { PLANS_HREF, useRouteAccess } from '@/lib/navigation/route-access';
import {
  useMarkProductUpdatesSeen,
  useProductUpdatesPages,
  useSetProductUpdateReaction,
  useStartAddonTrialFromUpdate,
} from '@/lib/product-updates/hooks';

const CATEGORY_CLASS: Record<ProductUpdateDto['category'], string> = {
  new: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  improvement: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  fix: 'bg-muted text-muted-foreground',
};

/** Etiquetas de los botones de tipo (en plural, para filtrar). */
const CATEGORY_FILTER_LABELS: Record<ProductUpdateCategory, string> = {
  new: 'Novedades',
  improvement: 'Mejoras',
  fix: 'Correcciones',
};

export default function ProductUpdatesPage() {
  return (
    <Suspense>
      <ProductUpdates />
    </Suspense>
  );
}

function ProductUpdates() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // Los filtros van en la dirección (?tipo=&q=&plan=1): al recargar o
  // compartir el enlace se conservan.
  const category = productUpdateCategoryFromSlug(params.get('tipo'));
  const onlyMyPlan = params.get('plan') === '1';
  const urlSearch = params.get('q') ?? '';
  const [searchInput, setSearchInput] = useState(urlSearch);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  // El buscador pasa a la dirección con un pequeño retraso.
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== urlSearch) setParam('q', searchInput.trim() || null);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, urlSearch, setParam]);

  const updates = useProductUpdatesPages({ category, search: urlSearch, onlyMyPlan });
  const markSeen = useMarkProductUpdatesSeen();
  const access = useRouteAccess();
  const marked = useRef(false);
  // Hasta cuándo estaban leídas al abrir la página, tomado de la primera carga
  // de esta visita (no de la caché de otra anterior). Aunque luego la lista se
  // recargue (ya marcada como vista), se filtre o se pidan más páginas, se
  // sigue viendo qué era nuevo.
  const [readUntil, setReadUntil] = useState<string | null>(null);
  const fresh = updates.isFetchedAfterMount && updates.isSuccess;
  const firstReadUntil = updates.data?.pages[0]?.readUntil ?? null;

  useEffect(() => {
    if (!fresh || marked.current || !firstReadUntil) return;
    marked.current = true;
    setReadUntil(firstReadUntil);
    markSeen.mutate();
  }, [fresh, firstReadUntil, markSeen]);

  const isUnread = (u: ProductUpdateDto) =>
    readUntil ? new Date(u.publishedAt) > new Date(readUntil) : u.unread;
  const canSeePlans = access(PLANS_HREF).allowed;
  const filtered = !!category || !!urlSearch || onlyMyPlan;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Sparkles className="size-5 text-primary" />
          Novedades
        </h1>
        <p className="text-sm text-muted-foreground">
          Lo último que hemos añadido y mejorado en TrasterOS.
        </p>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar en las novedades"
            aria-label="Buscar en las novedades"
            className="pl-9 text-base sm:text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={category ? 'outline' : 'secondary'}
            aria-pressed={!category}
            onClick={() => setParam('tipo', null)}
          >
            Todas
          </Button>
          {ProductUpdateCategoryEnum.options.map((c) => (
            <Button
              key={c}
              size="sm"
              variant={category === c ? 'secondary' : 'outline'}
              aria-pressed={category === c}
              onClick={() =>
                setParam('tipo', category === c ? null : PRODUCT_UPDATE_CATEGORY_SLUGS[c])
              }
            >
              {CATEGORY_FILTER_LABELS[c]}
            </Button>
          ))}
          <label className="flex items-center gap-2 text-sm sm:ml-auto">
            <input
              type="checkbox"
              className="size-4"
              checked={onlyMyPlan}
              onChange={(e) => setParam('plan', e.target.checked ? '1' : null)}
            />
            Solo lo de mi plan
          </label>
        </div>
      </div>

      {updates.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : updates.isError && updates.rows.length === 0 ? (
        <Card>
          <CardContent>
            <SectionError onRetry={() => void updates.refetch()} />
          </CardContent>
        </Card>
      ) : updates.rows.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-10 text-center text-sm text-muted-foreground">
            <p>
              {filtered
                ? 'No hay novedades que coincidan con lo que buscas.'
                : 'Todavía no hay novedades publicadas.'}
            </p>
            {filtered && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSearchInput('');
                  router.replace(pathname, { scroll: false });
                }}
              >
                Quitar los filtros
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {updates.rows.map((u) => (
            <UpdateCard
              key={u.id}
              update={u}
              unread={isUnread(u)}
              access={access}
              canSeePlans={canSeePlans}
            />
          ))}
          {updates.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={updates.isFetchingNextPage}
                onClick={() => void updates.fetchNextPage()}
              >
                {updates.isFetchingNextPage && <Loader2 className="mr-2 size-4 animate-spin" />}
                Cargar más
              </Button>
            </div>
          )}
          {updates.isFetchNextPageError && (
            <p className="text-center text-sm text-muted-foreground">
              No se han podido cargar más novedades. Vuelve a intentarlo.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function UpdateCard({
  update: u,
  unread,
  access,
  canSeePlans,
}: {
  update: ProductUpdateDto;
  unread: boolean;
  access: ReturnType<typeof useRouteAccess>;
  canSeePlans: boolean;
}) {
  const confirm = useConfirm();
  const react = useSetProductUpdateReaction();
  const trial = useStartAddonTrialFromUpdate();
  const canManageBilling = useHasPermission('billing:configure');
  const link = u.link ? access(u.link) : null;
  // La función que falta: la de la novedad o la que pide la página enlazada.
  const missing =
    u.feature && u.featureIncluded === false
      ? u.feature
      : link?.allowed
        ? link.missingFeature
        : null;
  // La prueba gratis solo la activa quien gestiona la suscripción.
  const offer = u.trialOffer && canManageBilling ? u.trialOffer : null;

  function setReaction(value: ProductUpdateReaction) {
    react.mutate(
      { id: u.id, value: u.myReaction === value ? null : value },
      { onError: () => toast.error('No se ha podido guardar tu respuesta.') },
    );
  }

  async function startTrial() {
    if (!offer) return;
    const ok = await confirm({
      title: `¿Probar «${offer.addonName}» gratis ${offer.days} días?`,
      description:
        'Se activa ahora, sin coste. Al terminar se desactiva sola y te avisamos por si quieres contratarlo. Cada extra solo se puede probar una vez.',
      confirmLabel: 'Probar gratis',
    });
    if (!ok) return;
    try {
      const res = await trial.mutateAsync(offer.addonId);
      toast.success(
        `Activado hasta el ${new Date(res.expiresAt).toLocaleDateString('es-ES', { dateStyle: 'long' })}.`,
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.body.message : 'No se ha podido activar la prueba.',
      );
    }
  }

  return (
    <Card className={unread ? 'border-primary/40' : undefined}>
      <CardHeader className="space-y-2 pb-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded px-2 py-0.5 ${CATEGORY_CLASS[u.category]}`}>
            {PRODUCT_UPDATE_CATEGORY_LABELS[u.category]}
          </span>
          {unread && (
            <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]">
              <span aria-hidden className="size-1.5 rounded-full bg-primary" />
              Sin leer
            </Badge>
          )}
          <span className="text-muted-foreground">
            {new Date(u.publishedAt).toLocaleDateString('es-ES', { dateStyle: 'long' })}
          </span>
        </div>
        <CardTitle className="text-lg">{u.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {u.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={u.imageUrl} alt="" className="w-full max-w-2xl rounded-md border" />
        )}
        <MarkdownView content={u.body} />
        <div className="flex flex-wrap items-center gap-3">
          {missing ? (
            <>
              <span className="text-xs text-muted-foreground">
                {FEATURE_LABELS[missing]} no está en tu plan.
                {canSeePlans && !offer && (
                  <>
                    {' '}
                    <Link href={PLANS_HREF} className="text-primary hover:underline">
                      Ver planes y extras
                    </Link>
                  </>
                )}
              </span>
              {offer && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={trial.isPending}
                  onClick={() => void startTrial()}
                >
                  {trial.isPending ? (
                    <Loader2 className="mr-1 size-4 animate-spin" />
                  ) : (
                    <Gift className="mr-1 size-4" />
                  )}
                  Probar gratis {offer.days} días
                </Button>
              )}
            </>
          ) : (
            u.link &&
            link?.allowed && (
              <Button asChild size="sm" variant="outline">
                <Link href={u.link}>
                  Ver
                  <ArrowRight className="ml-1 size-4" />
                </Link>
              </Button>
            )
          )}
          {u.feature && u.featureIncluded === true && (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">
              Incluido en tu plan
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 border-t pt-3 text-xs text-muted-foreground">
          <span className="mr-1">¿Te ha sido útil?</span>
          <Button
            size="icon"
            variant={u.myReaction === 'up' ? 'secondary' : 'ghost'}
            className="size-8"
            aria-label="Sí, me ha sido útil"
            aria-pressed={u.myReaction === 'up'}
            title="Sí"
            disabled={react.isPending}
            onClick={() => setReaction('up')}
          >
            <ThumbsUp className="size-4" />
          </Button>
          <Button
            size="icon"
            variant={u.myReaction === 'down' ? 'secondary' : 'ghost'}
            className="size-8"
            aria-label="No me ha sido útil"
            aria-pressed={u.myReaction === 'down'}
            title="No"
            disabled={react.isPending}
            onClick={() => setReaction('down')}
          >
            <ThumbsDown className="size-4" />
          </Button>
          {u.myReaction && <span className="ml-1">Gracias por decírnoslo.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
