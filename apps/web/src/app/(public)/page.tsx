import { ArrowRight, BarChart3, KeyRound, Map } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const FEATURES = [
  { key: 'plan', icon: Map },
  { key: 'billing', icon: BarChart3 },
  { key: 'access', icon: KeyRound },
] as const;

export default function LandingPage() {
  const t = useTranslations('landing');

  return (
    <>
      <section className="container flex flex-col items-center gap-6 py-20 text-center md:py-28">
        <h1 className="text-balance text-4xl font-semibold tracking-tight md:text-5xl">
          {t('heroTitle')}
        </h1>
        <p className="max-w-2xl text-pretty text-lg text-muted-foreground">{t('heroSubtitle')}</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/register">
              {t('primaryCta')}
              <ArrowRight className="ml-2 size-4" aria-hidden />
            </Link>
          </Button>
          <Button asChild size="lg" variant="ghost">
            <Link href="/login">{t('secondaryCta')}</Link>
          </Button>
        </div>
      </section>

      <section className="container pb-20">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('features.title')}
          </h2>
          <p className="mt-2 text-muted-foreground">{t('features.subtitle')}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }) => (
            <Card key={key} className="border-border/60">
              <CardHeader>
                <Icon className="size-6 text-primary" aria-hidden />
                <CardTitle className="mt-3 text-lg">{t(`features.${key}.title`)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {t(`features.${key}.description`)}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}
