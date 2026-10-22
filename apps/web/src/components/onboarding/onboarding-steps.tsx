'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import Link from 'next/link';

import type { OnboardingDto, OnboardingStepDto } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';

/** Puesta en marcha del tenant (los pasos se deducen de lo ya configurado). */
export function useOnboarding() {
  const canRead = useHasPermission('settings:read');
  return useQuery({
    queryKey: ['dashboard', 'onboarding'],
    queryFn: () => apiFetch<OnboardingDto>('/dashboard/onboarding'),
    enabled: canRead,
  });
}

/** Lista de pasos: hechos tachados; los pendientes con su explicación y atajo. */
export function OnboardingStepList({ steps }: { steps: OnboardingStepDto[] }) {
  return (
    <ul className="space-y-1">
      {steps.map((s) => (
        <li
          key={s.key}
          className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
        >
          {s.done ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" aria-label="Hecho" />
          ) : (
            <Circle
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-label="Pendiente"
            />
          )}
          <div className="min-w-0 flex-1">
            <Link
              href={s.href}
              className={`flex items-center gap-1 text-sm font-medium hover:underline ${
                s.done ? 'text-muted-foreground line-through' : ''
              }`}
            >
              {s.label}
              {!s.done && <ChevronRight className="size-3.5 shrink-0" />}
            </Link>
            {!s.done && (
              <p className="text-xs text-muted-foreground">
                {s.hint}
                {s.secondary && (
                  <>
                    {' '}
                    <Link href={s.secondary.href} className="text-primary hover:underline">
                      {s.secondary.label}
                    </Link>
                  </>
                )}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
