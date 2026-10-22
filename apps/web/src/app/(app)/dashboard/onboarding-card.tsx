'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';

import { OnboardingStepList, useOnboarding } from '@/components/onboarding/onboarding-steps';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe } from '@/lib/auth/hooks';

/**
 * Puesta en marcha en el Resumen: lo imprescindible para empezar a operar.
 * Se oculta al completarlo; lo recomendado sigue en Configuración → Puesta en marcha.
 */
export function OnboardingCard() {
  const { data } = useOnboarding();
  const slug = useMe().data?.tenant.slug;

  if (!data || data.completed) return null;
  const required = data.steps.filter((s) => s.group === 'required');

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">
              Puesta en marcha ({data.requiredDone}/{data.requiredTotal})
            </CardTitle>
            <CardDescription>
              Lo imprescindible para empezar a trabajar con TrasterOS.
            </CardDescription>
          </div>
          {slug && (
            <Button asChild size="sm" variant="outline">
              <a href={`/s/${slug}`} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-1 size-4" /> Ver tu web
              </a>
            </Button>
          )}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.round(data.progress * 100)}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <OnboardingStepList steps={required} />
        {data.recommendedTotal > 0 && (
          <p className="px-2 text-xs text-muted-foreground">
            Recomendado: {data.recommendedDone}/{data.recommendedTotal}.{' '}
            <Link href="/settings/getting-started" className="text-primary hover:underline">
              Ver todo
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
