'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';
import Link from 'next/link';

import type { OnboardingDto } from '@storageos/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

/**
 * Checklist de primeros pasos del operador. Solo se muestra hasta completarlo
 * (guía al «aha moment»: primer contrato). Oculto si ya está todo hecho.
 */
export function OnboardingCard() {
  const { data } = useQuery({
    queryKey: ['dashboard', 'onboarding'],
    queryFn: () => apiFetch<OnboardingDto>('/dashboard/onboarding'),
  });

  if (!data || data.completed) return null;
  const done = data.steps.filter((s) => s.done).length;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Primeros pasos ({done}/{data.steps.length})
        </CardTitle>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.round(data.progress * 100)}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {data.steps.map((s) => (
          <Link
            key={s.key}
            href={s.href}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/50"
          >
            {s.done ? (
              <CheckCircle2 className="size-4 shrink-0 text-green-600" />
            ) : (
              <Circle className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className={s.done ? 'text-muted-foreground line-through' : ''}>{s.label}</span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
