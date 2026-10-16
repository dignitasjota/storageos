'use client';

import {
  BarChart3,
  Copy,
  CopyPlus,
  ExternalLink,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { SettingsHeader } from '../settings-header';

import { PromoLandingDialog } from './promo-landing-dialog';
import { PromoLinksDialog } from './promo-links-dialog';
import { PromoStatsDialog } from './promo-stats-dialog';

import type { PromoLandingDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission, useMe } from '@/lib/auth/hooks';
import { useTenantBranding } from '@/lib/branding/hooks';
import {
  useDeletePromoLanding,
  useDuplicatePromoLanding,
  usePromoLandings,
  useUpdatePromoLanding,
} from '@/lib/promo-landings/hooks';

const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');

export default function PromoLandingsPage() {
  const landings = usePromoLandings();
  const update = useUpdatePromoLanding();
  const duplicate = useDuplicatePromoLanding();
  const remove = useDeletePromoLanding();
  const me = useMe();
  const branding = useTenantBranding();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PromoLandingDto | undefined>(undefined);
  const [linksOf, setLinksOf] = useState<PromoLandingDto | null>(null);
  const [statsOf, setStatsOf] = useState<PromoLandingDto | null>(null);
  const canMarket = useHasPermission('marketing:manage');

  const domain =
    branding.data?.customDomain && branding.data.customDomainVerifiedAt
      ? branding.data.customDomain
      : null;
  const site =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (typeof window !== 'undefined' ? window.location.origin : '');
  const urlOf = (p: PromoLandingDto) =>
    domain
      ? `https://${domain}/promo/${p.slug}`
      : `${site}/s/${me.data?.tenant.slug ?? ''}/promo/${p.slug}`;

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <SettingsHeader
        title="Landings de promoción"
        description="Páginas propias para cada promoción, con el estilo de tu web, su dirección y el botón de reservar. Incluido en Web Premium."
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Landings ({landings.data?.length ?? 0})</CardTitle>
          <Button
            onClick={() => {
              setEditing(undefined);
              setOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            Nueva landing
          </Button>
        </CardHeader>
        <CardContent>
          {!domain && (
            <p className="mb-4 text-sm text-muted-foreground">
              Con dominio propio la dirección será{' '}
              <span className="font-mono">tudominio.com/promo/…</span>.
            </p>
          )}
          {landings.isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (landings.data?.length ?? 0) === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Aún no hay landings. Crea una para tu próxima promoción, un local nuevo o una campaña.
            </p>
          ) : (
            <ul className="divide-y">
              {landings.data!.map((p) => (
                <li key={p.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      setEditing(p);
                      setOpen(true);
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium hover:underline">{p.name}</span>
                      {p.live ? (
                        <Badge>En la web</Badge>
                      ) : p.isActive ? (
                        <Badge variant="secondary">Fuera de fechas</Badge>
                      ) : (
                        <Badge variant="secondary">Apagada</Badge>
                      )}
                      {p.couponCode && <Badge variant="outline">Cupón {p.couponCode}</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{urlOf(p)}</p>
                    {(p.startsAt || p.endsAt) && (
                      <p className="text-xs text-muted-foreground">
                        {p.startsAt ? `desde el ${day(p.startsAt)}` : ''}
                        {p.startsAt && p.endsAt ? ' · ' : ''}
                        {p.endsAt ? `hasta el ${day(p.endsAt)}` : ''}
                      </p>
                    )}
                  </button>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Resultados"
                      aria-label="Resultados"
                      onClick={() => setStatsOf(p)}
                    >
                      <BarChart3 className="size-4" />
                    </Button>
                    {canMarket && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Enlaces y QR por origen"
                        aria-label="Enlaces y QR por origen"
                        onClick={() => setLinksOf(p)}
                      >
                        <Link2 className="size-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Copiar la dirección"
                      aria-label="Copiar la dirección"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(urlOf(p))
                          .then(() => toast.success('Dirección copiada.'))
                      }
                    >
                      <Copy className="size-4" />
                    </Button>
                    {p.live && (
                      <Button variant="ghost" size="icon" asChild title="Abrir" aria-label="Abrir">
                        <a href={urlOf(p)} target="_blank" rel="noreferrer">
                          <ExternalLink className="size-4" />
                        </a>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      title={p.isActive ? 'Apagar' : 'Activar'}
                      aria-label={p.isActive ? 'Apagar' : 'Activar'}
                      onClick={() =>
                        void run(
                          () => update.mutateAsync({ id: p.id, input: { isActive: !p.isActive } }),
                          p.isActive ? 'Landing apagada.' : 'Landing activada.',
                        )
                      }
                    >
                      {p.isActive ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Duplicar"
                      aria-label="Duplicar"
                      onClick={() =>
                        void run(() => duplicate.mutateAsync(p.id), 'Copia creada (apagada).')
                      }
                    >
                      <CopyPlus className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Borrar"
                      aria-label="Borrar"
                      onClick={() => {
                        if (!window.confirm(`¿Borrar «${p.name}»? No se puede deshacer.`)) return;
                        void run(() => remove.mutateAsync(p.id), 'Landing borrada.');
                      }}
                    >
                      <Trash2 className="size-4 text-muted-foreground" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <PromoLandingDialog open={open} onOpenChange={setOpen} landing={editing} />
      <PromoLinksDialog landing={linksOf} onOpenChange={(o) => !o && setLinksOf(null)} />
      <PromoStatsDialog landing={statsOf} onOpenChange={(o) => !o && setStatsOf(null)} />
    </div>
  );
}
