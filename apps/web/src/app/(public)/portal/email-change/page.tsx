'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

/** Confirmación del cambio de email del área de clientes (enlace del correo). */
export default function PortalEmailChangePage() {
  return (
    <Suspense fallback={null}>
      <EmailChangeContent />
    </Suspense>
  );
}

function EmailChangeContent() {
  const t = useTranslations('portal.emailChange');
  const params = useSearchParams();
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [email, setEmail] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = params.get('token');
    if (!token) {
      setState('error');
      return;
    }
    apiFetch<{ email: string }>('/portal/email-change/confirm', {
      method: 'POST',
      json: { token },
      requiresAuth: false,
    })
      .then((r) => {
        setEmail(r.email);
        setState('ok');
        // La sesión guardada en este móvil enseña el email nuevo.
        try {
          const raw = localStorage.getItem('storageos.portal.session');
          if (raw) {
            localStorage.setItem(
              'storageos.portal.session',
              JSON.stringify({ ...JSON.parse(raw), email: r.email }),
            );
          }
        } catch {
          /* ignore */
        }
      })
      .catch(() => setState('error'));
  }, [params]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          {state === 'loading' && (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('loading')}</p>
            </>
          )}
          {state === 'ok' && (
            <>
              <CheckCircle2 className="h-8 w-8 text-green-600" />
              <p className="font-medium">{t('success', { email })}</p>
            </>
          )}
          {state === 'error' && (
            <>
              <XCircle className="h-8 w-8 text-red-600" />
              <p className="text-sm text-muted-foreground">{t('error')}</p>
            </>
          )}
          {state !== 'loading' && (
            <Button asChild variant="outline">
              <a href="/portal/consume">{t('goToPortal')}</a>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
