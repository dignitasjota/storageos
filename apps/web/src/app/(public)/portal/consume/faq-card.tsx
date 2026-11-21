'use client';

import { faqInLanguage, type FaqEntryDto, type PortalSessionDto } from '@storageos/shared';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { usePortalLocale } from '../i18n/provider';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

export function FaqCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.helpCenter');
  const { locale } = usePortalLocale();
  const [entries, setEntries] = useState<FaqEntryDto[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    portalApiFetch<FaqEntryDto[]>('/portal/me/faq', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);

  if (!entries || entries.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HelpCircle className="h-5 w-5 text-muted-foreground" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {entries.map((f) => {
            const expanded = open === f.id;
            // En inglés, la versión inglesa si el negocio la escribió.
            const text = faqInLanguage(f, locale);
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : f.id)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-3 text-left text-sm font-medium"
                  aria-expanded={expanded}
                >
                  {text.question}
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                      expanded ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {expanded && (
                  <p className="whitespace-pre-wrap px-3 pb-3 text-sm text-muted-foreground">
                    {text.answer}
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
