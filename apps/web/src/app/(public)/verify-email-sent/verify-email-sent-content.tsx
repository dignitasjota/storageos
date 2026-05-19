'use client';

import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useResendVerification } from '@/lib/auth/hooks';

export function VerifyEmailSentContent() {
  const t = useTranslations('auth.verifySent');
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  const tenantSlug = params.get('tenantSlug') ?? '';
  const autoResend = params.get('resend') === '1';
  const resend = useResendVerification();
  const autoResendDone = useRef(false);

  // Si llegamos aqui desde el flujo de login 403 (email_not_verified),
  // disparamos el reenvio automaticamente. Solo una vez.
  useEffect(() => {
    if (!autoResend || autoResendDone.current) return;
    if (!email || !tenantSlug) return;
    autoResendDone.current = true;
    resend.mutate(
      { email, tenantSlug },
      {
        onSuccess: () => toast.success(t('resent')),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onResend = () => {
    if (!email || !tenantSlug) {
      toast.error('Falta email o empresa para reenviar.');
      return;
    }
    resend.mutate(
      { email, tenantSlug },
      {
        onSuccess: () => toast.success(t('resent')),
      },
    );
  };

  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-md border-border/60 text-center">
        <CardHeader className="space-y-3">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MailCheck className="size-6" aria-hidden />
          </div>
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('subtitle', { email: email || '—' })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            onClick={onResend}
            disabled={resend.isPending || !email || !tenantSlug}
            variant="outline"
            className="w-full"
          >
            {t('resend')}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t('alreadyVerified')}
            <Link href="/login" className="font-medium text-primary hover:underline">
              {t('loginLink')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
