'use client';

import { Bell, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalNoticeDto, PortalSessionDto } from '@storageos/shared';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/** Los avisos que el negocio le ha enviado por correo, a mano en su área de clientes. */
export function NoticesCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.notices');
  const { locale } = usePortalLocale();
  const [notices, setNotices] = useState<PortalNoticeDto[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    portalApiFetch<PortalNoticeDto[]>('/portal/me/notices', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then((n) => {
        if (!cancelled) setNotices(n);
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  if (notices.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-muted-foreground" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {notices.map((n) => {
            const expanded = open === n.id;
            return (
              <li key={n.id} className="px-3 py-2">
                <button
                  type="button"
                  className="flex w-full items-start gap-2 text-left text-sm"
                  onClick={() => setOpen(expanded ? null : n.id)}
                  aria-expanded={expanded}
                >
                  {expanded ? (
                    <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{n.subject}</span>
                    <span className="block text-xs text-muted-foreground">
                      {new Date(n.sentAt).toLocaleDateString(intlLocaleForPortal(locale), {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })}
                    </span>
                  </span>
                </button>
                {expanded && (
                  <p className="ml-6 mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {n.body}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
