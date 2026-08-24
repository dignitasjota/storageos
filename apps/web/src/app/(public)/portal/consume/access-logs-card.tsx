'use client';

import { History } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalAccessLogDto, PortalSessionDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

function methodLabel(
  m: string,
  t: ReturnType<typeof useTranslations<'portal.consume.accessLogs'>>,
): string {
  if (m === 'pin') return t('methodPin');
  if (m === 'qr') return t('methodQr');
  if (m === 'rfid') return t('methodRfid');
  return m;
}

/** Historial de accesos del inquilino: sus entradas, por transparencia y seguridad. */
export function AccessLogsCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.accessLogs');
  const { locale } = usePortalLocale();
  const [logs, setLogs] = useState<PortalAccessLogDto[]>([]);

  useEffect(() => {
    apiFetch<PortalAccessLogDto[]>('/portal/me/access-logs', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
      .then(setLogs)
      .catch(() => {
        /* opcional */
      });
  }, [session.accessToken]);

  if (logs.length === 0) return null;

  function fmtDateTime(iso: string): string {
    return new Date(iso).toLocaleString(intlLocaleForPortal(locale), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {logs.map((l) => {
            const allowed = l.result === 'allowed';
            return (
              <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{l.deviceName ?? t('fallbackDevice')}</span>
                  <span className="text-xs text-muted-foreground">
                    {fmtDateTime(l.occurredAt)} · {methodLabel(l.method, t)}
                  </span>
                </span>
                <Badge variant={allowed ? 'default' : 'destructive'} className="shrink-0">
                  {allowed ? t('resultAllowed') : t('resultDenied')}
                </Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
