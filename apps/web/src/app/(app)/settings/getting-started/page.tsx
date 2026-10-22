'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import { OnboardingStepList, useOnboarding } from '@/components/onboarding/onboarding-steps';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe } from '@/lib/auth/hooks';

/** Puesta en marcha completa: lo imprescindible y lo recomendado, siempre a mano. */
export default function GettingStartedPage() {
  const { data, isLoading } = useOnboarding();
  const slug = useMe().data?.tenant.slug;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Puesta en marcha</h1>
        <p className="text-sm text-muted-foreground">
          Lo que hay que configurar para operar y lo que conviene revisar. Se marca solo al hacerlo.
          ¿Cómo es el día a día?{' '}
          <Link href="/help" className="text-primary hover:underline">
            Cómo funciona
          </Link>
          .
        </p>
      </div>
      {isLoading || !data ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Imprescindible ({data.requiredDone}/{data.requiredTotal})
              </CardTitle>
              <CardDescription>
                {data.completed
                  ? 'Todo listo para operar.'
                  : 'Sin esto no puedes alquilar ni cobrar con normalidad.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <OnboardingStepList steps={data.steps.filter((s) => s.group === 'required')} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Recomendado ({data.recommendedDone}/{data.recommendedTotal})
              </CardTitle>
              <CardDescription>
                Mejora lo que ven tus inquilinos y cómo trabaja tu equipo.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <OnboardingStepList steps={data.steps.filter((s) => s.group === 'recommended')} />
            </CardContent>
          </Card>
          {slug && (
            <p className="text-sm text-muted-foreground">
              Tu web pública ya está activa:{' '}
              <a
                href={`/s/${slug}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                /s/{slug}
              </a>
              . Su aspecto se cambia en Web pública y portal.
            </p>
          )}
        </>
      )}
    </div>
  );
}
