'use client';

import { BellRing, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalSessionDto, PortalWaitlistDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/auth/api';

/**
 * Lista de espera desde el portal: el inquilino se apunta a un tipo de trastero
 * AGOTADO en uno de sus locales y le avisamos por email en cuanto se libere uno.
 * Se oculta si no hay tipos agotados ni altas vigentes (nada que mostrar).
 */
export function WaitlistCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.waitlist');
  const { locale } = usePortalLocale();
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const [data, setData] = useState<PortalWaitlistDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PortalWaitlistDto>('/portal/me/waitlist', { headers: auth, requiresAuth: false })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData({ options: [], entries: [] });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  if (!data) return null;
  if (data.options.length === 0 && data.entries.length === 0) return null;

  const joinedKeys = new Set(data.entries.map((e) => `${e.facilityId}:${e.unitTypeId}`));
  const money = new Intl.NumberFormat(intlLocaleForPortal(locale), {
    style: 'currency',
    currency: 'EUR',
  });

  async function join(facilityId: string, unitTypeId: string) {
    setBusy(`${facilityId}:${unitTypeId}`);
    try {
      const d = await apiFetch<PortalWaitlistDto>('/portal/me/waitlist', {
        method: 'POST',
        json: { facilityId, unitTypeId },
        headers: auth,
        requiresAuth: false,
      });
      setData(d);
      toast.success(t('joined'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(null);
    }
  }

  async function leave(id: string) {
    setBusy(id);
    try {
      const d = await apiFetch<PortalWaitlistDto>(`/portal/me/waitlist/${id}`, {
        method: 'DELETE',
        headers: auth,
        requiresAuth: false,
      });
      setData(d);
      toast.success(t('left'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="h-5 w-5" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.entries.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('myEntries')}</p>
            <ul className="space-y-2">
              {data.entries.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{e.unitTypeName}</p>
                    <p className="text-muted-foreground">{e.facilityName}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={e.status === 'notified' ? 'default' : 'secondary'}>
                      {e.status === 'notified' ? t('statusNotified') : t('statusWaiting')}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === e.id}
                      onClick={() => void leave(e.id)}
                    >
                      {busy === e.id && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      {t('leave')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {data.options.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('soldOut')}</p>
            <ul className="space-y-2">
              {data.options.flatMap((f) =>
                f.unitTypes.map((ut) => {
                  const key = `${f.facilityId}:${ut.id}`;
                  const already = joinedKeys.has(key);
                  return (
                    <li
                      key={key}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                    >
                      <div>
                        <p className="font-medium">{ut.name}</p>
                        <p className="text-muted-foreground">
                          {f.facilityName} ·{' '}
                          {t('pricePerMonth', { price: money.format(ut.priceMonthly * 1.21) })}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={already ? 'outline' : 'default'}
                        disabled={already || busy === key}
                        onClick={() => void join(f.facilityId, ut.id)}
                      >
                        {busy === key && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                        {already ? t('alreadyJoined') : t('join')}
                      </Button>
                    </li>
                  );
                }),
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
