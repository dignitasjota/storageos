'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import Link from 'next/link';

import type { OnboardingNextStepDto } from '@storageos/shared';

import { useOnboarding } from '@/components/onboarding/onboarding-steps';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

const key = ['dashboard', 'onboarding', 'next-step'];
const STAGES = { week: 'Tu primera semana', month: 'Tu primer mes', later: 'Cuando quieras' };

/** Con la puesta en marcha hecha, una cosa nueva que aprender cada vez. */
export function NextStepCard() {
  const qc = useQueryClient();
  const completed = useOnboarding().data?.completed ?? false;
  const { data } = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{ step: OnboardingNextStepDto | null }>('/dashboard/onboarding/next-step'),
    enabled: completed,
  });
  const dismiss = useMutation({
    mutationFn: (stepKey: string) =>
      apiFetch<{ step: OnboardingNextStepDto | null }>(
        `/dashboard/onboarding/next-step/${stepKey}/dismiss`,
        { method: 'POST' },
      ),
    onSuccess: (res) => qc.setQueryData(key, res),
  });
  const step = data?.step;
  if (!completed || !step) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs text-muted-foreground">Siguiente paso · {STAGES[step.stage]}</p>
            <CardTitle className="text-base">{step.title}</CardTitle>
            <CardDescription>{step.text}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Descartar esta sugerencia"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate(step.key)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm">
          <Link href={step.href}>{step.cta}</Link>
        </Button>
        <Link href={`/help#${step.guide}`} className="text-sm text-primary hover:underline">
          Cómo funciona
        </Link>
      </CardContent>
    </Card>
  );
}
