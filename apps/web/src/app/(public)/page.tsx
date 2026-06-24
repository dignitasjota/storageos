import {
  ArrowRight,
  BarChart3,
  Check,
  CreditCard,
  FileSignature,
  KeyRound,
  Map,
  Megaphone,
  ReceiptText,
  Smartphone,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const FEATURES = [
  { key: 'plan', icon: Map },
  { key: 'contracts', icon: FileSignature },
  { key: 'billing', icon: ReceiptText },
  { key: 'payments', icon: CreditCard },
  { key: 'access', icon: KeyRound },
  { key: 'portal', icon: Smartphone },
  { key: 'crm', icon: Megaphone },
  { key: 'operations', icon: Wrench },
  { key: 'analytics', icon: BarChart3 },
] as const;

const EXTRAS = ['multiLocal', 'fiscal', 'rgpd', 'reports', 'ai', 'reservations'] as const;

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
        <p className="text-sm text-muted-foreground">{t('heroNote')}</p>
      </section>

      <section className="container pb-16">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('features.title')}
          </h2>
          <p className="mt-2 text-muted-foreground">{t('features.subtitle')}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }) => (
            <Card key={key} className="border-border/60">
              <CardHeader>
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <CardTitle className="mt-3 text-lg">{t(`features.${key}.title`)}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {t(`features.${key}.description`)}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="container pb-20">
        <div className="rounded-2xl border bg-muted/30 p-8 md:p-10">
          <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{t('extras.title')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('extras.subtitle')}</p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {EXTRAS.map((key) => (
              <li key={key} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>{t(`extras.${key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="container pb-24 text-center">
        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{t('cta.title')}</h2>
        <p className="mx-auto mt-2 max-w-xl text-muted-foreground">{t('cta.subtitle')}</p>
        <Button asChild size="lg" className="mt-6">
          <Link href="/register">
            {t('primaryCta')}
            <ArrowRight className="ml-2 size-4" aria-hidden />
          </Link>
        </Button>
      </section>
    </>
  );
}
