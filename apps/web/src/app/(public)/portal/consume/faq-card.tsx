'use client';

import { ChevronDown, HelpCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { FaqEntryDto, PortalSessionDto } from '@storageos/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

export function FaqCard({ session }: { session: PortalSessionDto }) {
  const [entries, setEntries] = useState<FaqEntryDto[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<FaqEntryDto[]>('/portal/me/faq', {
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
          <HelpCircle className="h-5 w-5 text-muted-foreground" /> Centro de ayuda
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {entries.map((f) => {
            const expanded = open === f.id;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : f.id)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-3 text-left text-sm font-medium"
                  aria-expanded={expanded}
                >
                  {f.question}
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                      expanded ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {expanded && (
                  <p className="whitespace-pre-wrap px-3 pb-3 text-sm text-muted-foreground">
                    {f.answer}
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
