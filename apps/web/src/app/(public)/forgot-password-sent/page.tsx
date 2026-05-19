import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Revisa tu correo' };

export default async function ForgotPasswordSentPage() {
  const t = await getTranslations('auth.forgotSent');
  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-md border-border/60 text-center">
        <CardHeader className="space-y-3">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MailCheck className="size-6" aria-hidden />
          </div>
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login" className="text-sm font-medium text-primary hover:underline">
            {t('backToLogin')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
