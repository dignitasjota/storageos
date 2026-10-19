'use client';

import { Gift, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { OpportunityKind, PortalOfferDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/auth/api';

/** Dónde se contrata cada propuesta dentro del portal. */
export const OFFER_TAB: Record<OpportunityKind, string> = {
  insurance: 'contratos',
  larger_unit: 'cambio',
  additional_unit: 'nuevo',
  night_pass: 'accesos',
  autopay: 'facturas',
};

/**
 * «Ofertas para ti»: lo que el negocio le ha propuesto (desde Oportunidades).
 * Puede ir a contratarlo, decir que le interesa (avisa al equipo) o que no.
 */
export function OffersCard({
  session,
  onNavigate,
}: {
  session: PortalSessionDto;
  onNavigate: (tab: string) => void;
}) {
  const t = useTranslations('portal.consume.offers');
  const { locale } = usePortalLocale();
  const [offers, setOffers] = useState<PortalOfferDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const headers = { Authorization: `Bearer ${session.accessToken}` };

  useEffect(() => {
    let cancelled = false;
    apiFetch<PortalOfferDto[]>('/portal/me/offers', { headers, requiresAuth: false })
      .then((o) => {
        if (!cancelled) setOffers(o);
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  async function respond(o: PortalOfferDto, response: 'interested' | 'declined') {
    setBusy(o.id);
    try {
      const next = await apiFetch<PortalOfferDto[]>(`/portal/me/offers/${o.id}/respond`, {
        method: 'POST',
        json: { response },
        headers,
        requiresAuth: false,
      });
      setOffers(next);
      toast.success(response === 'interested' ? t('interestedDone') : t('declinedDone'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(null);
    }
  }

  if (offers.length === 0) return null;

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="size-4 text-primary" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {offers.map((o) => (
          <div key={o.id} className="space-y-2 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">{t(`kind.${o.kind}`)}</p>
              {o.priceGross != null && (
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t('perMonth', {
                    price: o.priceGross.toLocaleString(intlLocaleForPortal(locale), {
                      style: 'currency',
                      currency: 'EUR',
                    }),
                  })}
                </span>
              )}
            </div>
            <p className="text-muted-foreground">{o.message}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onNavigate(OFFER_TAB[o.kind])}>
                {t(`cta.${o.kind}`)}
              </Button>
              {o.status === 'interested' ? (
                <span className="self-center text-xs text-emerald-700 dark:text-emerald-400">
                  {t('interestedBadge')}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === o.id}
                  onClick={() => void respond(o, 'interested')}
                >
                  {busy === o.id && <Loader2 className="mr-1 size-4 animate-spin" />}
                  {t('interested')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === o.id}
                onClick={() => void respond(o, 'declined')}
              >
                {t('decline')}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
