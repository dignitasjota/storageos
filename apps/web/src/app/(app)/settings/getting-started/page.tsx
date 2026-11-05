'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';

import {
  OnboardingStepList,
  useOnboarding,
  WebStatusNote,
} from '@/components/onboarding/onboarding-steps';
import { TestRunCard } from '@/components/onboarding/test-run-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Puesta en marcha completa: lo imprescindible y lo recomendado, siempre a mano. */
export default function GettingStartedPage() {
  const { data, isLoading } = useOnboarding();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Puesta en marcha</h1>
        <p className="text-sm text-muted-foreground">
          Lo que hay que configurar para operar y lo que conviene revisar. Se marca solo al hacerlo,
          y lo que no aplique a tu negocio lo puedes dar por resuelto. ¿Cómo es el día a día?{' '}
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
          <WebStatusNote web={data.web} />
          <TestRunCard
            testRun={data.testRun}
            canStart={data.steps.some((s) => s.key === 'test_run')}
          />
        </>
      )}
    </div>
  );
}
