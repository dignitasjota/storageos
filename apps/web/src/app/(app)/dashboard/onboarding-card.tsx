'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';

import {
  OnboardingStepList,
  useOnboarding,
  WebStatusNote,
} from '@/components/onboarding/onboarding-steps';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Puesta en marcha en el Resumen: lo imprescindible para empezar a operar.
 * Se oculta al completarlo; lo recomendado sigue en Configuración → Puesta en marcha.
 */
export function OnboardingCard() {
  const { data } = useOnboarding();

  if (!data) return null;
  if (data.wizardPending) {
    return (
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="text-lg">Vamos a dejar tu negocio listo</CardTitle>
          <CardDescription>
            Cuatro preguntas, unos cinco minutos: tu punto de partida, tu local, tus trasteros y
            cómo cobras. Lo demás puedes hacerlo cuando quieras.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/onboarding">Empezar</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/settings/getting-started">Prefiero ir por mi cuenta</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (data.completed) return null;
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
          {data.web.published && (
            <Button asChild size="sm" variant="outline">
              <a href={data.web.url} target="_blank" rel="noreferrer">
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
        <div className="px-2">
          <WebStatusNote web={data.web} />
        </div>
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
