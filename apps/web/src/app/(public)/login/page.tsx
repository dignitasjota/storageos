import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import type { Metadata } from 'next';

import { LoginForm } from '@/components/auth/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.login');
  return { title: t('title') };
}

export default async function LoginPage() {
  const t = await getTranslations('auth.login');
  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-md border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* useSearchParams obliga a Suspense en pages estaticas. */}
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
          <div className="space-y-2 text-center text-sm text-muted-foreground">
            <p>
              <Link href="/forgot-password" className="font-medium text-primary hover:underline">
                {t('forgot')}
              </Link>
            </p>
            <p>
              {t('noAccount')}{' '}
              <Link href="/register" className="font-medium text-primary hover:underline">
                {t('registerLink')}
              </Link>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
