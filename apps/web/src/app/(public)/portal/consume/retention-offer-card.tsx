'use client';

import { Gift } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalRetentionOfferDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/**
 * Oferta de retención: si el inquilino ha pedido la baja y el operador le ofrece
 * un descuento, la ve aquí y puede aceptarla (revierte la baja) o rechazarla.
 */
export function RetentionOfferCard({
  session,
  onChanged,
}: {
  session: PortalSessionDto;
  /** Se llama tras aceptar (para recargar contratos/facturas). */
  onChanged?: () => void;
}) {
  const t = useTranslations('portal.consume.retention');
  const { locale } = usePortalLocale();
  const money = (n: number) =>
    n.toLocaleString(intlLocaleForPortal(locale), { style: 'currency', currency: 'EUR' });
  const [offers, setOffers] = useState<PortalRetentionOfferDto[]>([]);
  const [busy, setBusy] = useState(false);

  function load() {
    portalApiFetch<PortalRetentionOfferDto[]>('/portal/me/retention-offers', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then(setOffers)
      .catch(() => setOffers([]));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  async function respond(id: string, action: 'accept' | 'decline') {
    setBusy(true);
    try {
      await portalApiFetch(`/portal/me/retention-offers/${id}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        requiresAuth: false,
      });
      toast.success(action === 'accept' ? t('acceptSuccess') : t('declineSuccess'));
      load();
      if (action === 'accept') onChanged?.();
    } catch {
      toast.error(t('respondError'));
    } finally {
      setBusy(false);
    }
  }

  if (offers.length === 0) return null;

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="size-4 text-primary" />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {offers.map((o) => (
          <div key={o.id} className="space-y-2 rounded-md border p-3">
            <p className="text-sm">
              {t('offerLine', {
                unitCode: o.unitCode,
                discount:
                  o.discountType === 'percentage'
                    ? t('offerPercentage', { value: o.discountValue })
                    : t('offerFixed', { value: money(o.discountValue) }),
                months: o.months,
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('priceChangeIntro')}{' '}
              <span className="line-through">{money(o.currentPriceMonthly)}</span>{' '}
              {t('priceChangeTo')}{' '}
              <strong className="text-foreground">
                {t('perMonth', { price: money(o.discountedPriceMonthly) })}
              </strong>
              .
            </p>
            {o.message && <p className="text-sm italic text-muted-foreground">«{o.message}»</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => respond(o.id, 'accept')} disabled={busy}>
                {t('accept')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => respond(o.id, 'decline')}
                disabled={busy}
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
