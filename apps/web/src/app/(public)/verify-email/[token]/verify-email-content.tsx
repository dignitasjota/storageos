'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useVerifyEmail } from '@/lib/auth/hooks';

export function VerifyEmailContent({ token }: { token: string }) {
  const t = useTranslations('auth.verifyToken');
  const router = useRouter();
  const verify = useVerifyEmail();
  const triggered = useRef(false);

  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;
    verify.mutate(
      { token },
      {
        onSuccess: () => {
          // Pequena pausa para que se vea el estado de exito.
          setTimeout(() => router.replace('/dashboard'), 600);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-md border-border/60 text-center">
        <CardHeader className="space-y-3">
          {verify.isPending || verify.isIdle ? (
            <>
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Loader2 className="size-6 animate-spin" aria-hidden />
              </div>
              <CardTitle className="text-xl">{t('verifying')}</CardTitle>
            </>
          ) : verify.isSuccess ? (
            <>
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CheckCircle2 className="size-6" aria-hidden />
              </div>
              <CardTitle className="text-xl">{t('success')}</CardTitle>
            </>
          ) : (
            <>
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <XCircle className="size-6" aria-hidden />
              </div>
              <CardTitle className="text-xl">{t('errorTitle')}</CardTitle>
              <CardDescription>{t('errorBody')}</CardDescription>
            </>
          )}
        </CardHeader>
        {verify.isError ? (
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/login">{t('goToLogin')}</Link>
            </Button>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
