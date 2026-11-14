'use client';

import { FileText, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalAnnexDto, PortalSessionDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/**
 * Anexos firmados de sus contratos, con su PDF. Los pendientes salen en
 * «Pendiente de firmar». Sin ninguno firmado, no se pinta.
 */
export function SignedAnnexesCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.annexes');
  const { locale } = usePortalLocale();
  const [annexes, setAnnexes] = useState<PortalAnnexDto[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const headers = { Authorization: `Bearer ${session.accessToken}` };

  useEffect(() => {
    let cancelled = false;
    portalApiFetch<PortalAnnexDto[]>('/portal/me/annexes', { headers, requiresAuth: false })
      .then((rows) => {
        if (!cancelled) setAnnexes(rows.filter((a) => a.status === 'signed'));
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  if (annexes.length === 0) return null;
  const intl = intlLocaleForPortal(locale);

  async function download(id: string) {
    setDownloading(id);
    try {
      const res = await portalApiFetch<{ url: string }>(`/portal/me/annexes/${id}/pdf`, {
        headers,
        requiresAuth: false,
      });
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {annexes.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          >
            <div className="text-sm">
              <p className="font-medium">{t('item', { number: a.number, title: a.title })}</p>
              <p className="text-xs text-muted-foreground">
                {t('details', {
                  contract: a.contractNumber,
                  unit: a.unitCode,
                  date: a.signedAt
                    ? new Date(a.signedAt).toLocaleDateString(intl, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })
                    : '',
                })}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void download(a.id)}
              disabled={downloading !== null}
            >
              {downloading === a.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('download')}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
