'use client';

import { FileSignature, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { signHref } from '../../s/[slug]/i18n/messages';
import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type {
  PortalAnnexDto,
  PortalPendingSignatureDto,
  PortalSessionDto,
  PortalSignLinkDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/**
 * «Pendiente de firmar»: contratos que el inquilino aún no ha firmado (se le
 * envió el enlace o reservó online y no terminó) y anexos de sus contratos.
 * «Firmar» abre la firma con un enlace nuevo, aunque el del correo ya no
 * valga. Sin ninguno, no se pinta.
 */
export function PendingSignatureCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.pendingSignature');
  const { locale } = usePortalLocale();
  const [items, setItems] = useState<PortalPendingSignatureDto[]>([]);
  const [annexes, setAnnexes] = useState<PortalAnnexDto[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const headers = { Authorization: `Bearer ${session.accessToken}` };

  useEffect(() => {
    let cancelled = false;
    portalApiFetch<PortalPendingSignatureDto[]>('/portal/me/contracts/pending-signature', {
      headers,
      requiresAuth: false,
    })
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch(() => {
        /* opcional */
      });
    portalApiFetch<PortalAnnexDto[]>('/portal/me/annexes', { headers, requiresAuth: false })
      .then((rows) => {
        if (!cancelled) setAnnexes(rows.filter((a) => a.status === 'pending'));
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  if (items.length === 0 && annexes.length === 0) return null;
  const intl = intlLocaleForPortal(locale);
  const money = (n: number) =>
    n.toLocaleString(intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = (iso: string) =>
    new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString(intl, {
      day: 'numeric',
      month: 'long',
    });
  const time = (iso: string) =>
    new Date(iso).toLocaleString(intl, {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });

  async function sign(id: string, kind: 'contract' | 'annex' = 'contract') {
    setOpening(id);
    try {
      const res = await portalApiFetch<PortalSignLinkDto>(
        kind === 'annex'
          ? `/portal/me/annexes/${id}/sign-link`
          : `/portal/me/contracts/${id}/sign-link`,
        { method: 'POST', headers, requiresAuth: false },
      );
      window.location.assign(
        kind === 'annex'
          ? `/sign/annex/${encodeURIComponent(res.token)}`
          : signHref(res.token, locale === 'en' ? 'en' : 'es'),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
      setOpening(null);
    }
  }

  return (
    <Card className="border-amber-300 dark:border-amber-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSignature className="h-4 w-4 text-amber-600" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          >
            <div className="text-sm">
              <p className="font-medium">
                {c.unitCode} · {c.facilityName}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('details', {
                  number: c.contractNumber,
                  start: date(c.startDate),
                  price: money(c.priceMonthlyWithVat),
                })}
              </p>
              {c.holdUntil && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t('holdUntil', { date: time(c.holdUntil) })}
                </p>
              )}
            </div>
            <Button size="sm" onClick={() => void sign(c.id)} disabled={opening !== null}>
              {opening === c.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('sign')}
            </Button>
          </div>
        ))}
        {annexes.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          >
            <div className="text-sm">
              <p className="font-medium">{t('annex', { number: a.number, title: a.title })}</p>
              <p className="text-xs text-muted-foreground">
                {t('annexDetails', {
                  number: a.contractNumber,
                  unit: a.unitCode,
                  facility: a.facilityName,
                })}
              </p>
            </div>
            <Button size="sm" onClick={() => void sign(a.id, 'annex')} disabled={opening !== null}>
              {opening === a.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('sign')}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
