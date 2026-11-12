import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import type { Metadata } from 'next';

import { RegisterForm } from '@/components/auth/register-form';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.register');
  return { title: t('title') };
}

/** Un valor de la URL (el enlace de una propuesta trae email, empresa y nombre). */
function param(v: string | string[] | undefined, max: number): string | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s.slice(0, max) : undefined;
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('auth.register');
  const sp = await searchParams;
  const email = param(sp.email, 254);
  const tenantName = param(sp.company, 100);
  const fullName = param(sp.name, 200);
  const defaults = {
    ...(email ? { email } : {}),
    ...(tenantName ? { tenantName } : {}),
    ...(fullName ? { fullName } : {}),
  };
  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-lg border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <PlatformAttribution />
          <RegisterForm defaults={defaults} />
          <p className="text-center text-sm text-muted-foreground">
            {t('haveAccount')}{' '}
            <Link href="/login" className="font-medium text-primary hover:underline">
              {t('loginLink')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
