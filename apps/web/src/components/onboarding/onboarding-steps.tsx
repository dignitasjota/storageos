'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import Link from 'next/link';

import type { OnboardingDto, OnboardingStepDto } from '@storageos/shared';

import { apiFetch } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';

/** Puesta en marcha del tenant: solo quien puede hacer los pasos (propietario y gestor). */
export function useOnboarding() {
  const canRead = useHasPermission('facilities:manage');
  return useQuery({
    queryKey: ['dashboard', 'onboarding'],
    queryFn: () => apiFetch<OnboardingDto>('/dashboard/onboarding'),
    enabled: canRead,
  });
}

function useSkipStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, skipped }: { key: string; skipped: boolean }) =>
      apiFetch<OnboardingDto>(`/dashboard/onboarding/steps/${key}`, {
        method: 'PUT',
        json: { skipped },
      }),
    onSuccess: (data) => qc.setQueryData(['dashboard', 'onboarding'], data),
  });
}

/** Si la web ya se ve y acepta reservas, y qué falta para ello. */
export function WebStatusNote({ web }: { web: OnboardingDto['web'] }) {
  if (web.bookable) {
    return (
      <p className="text-sm text-muted-foreground">
        Tu web está publicada y acepta reservas online:{' '}
        <a href={web.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
          abrirla
        </a>
        .
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {web.published
        ? 'Tu web ya se ve, pero aún no acepta reservas online. '
        : 'Tu web aún no está publicada. '}
      Falta: {web.missing.join(', ')}.
    </p>
  );
}

/** Lista de pasos: hechos tachados; los pendientes con su explicación y atajo. */
export function OnboardingStepList({ steps }: { steps: OnboardingStepDto[] }) {
  const skip = useSkipStep();
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
                {s.skippable && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      disabled={skip.isPending}
                      onClick={() => skip.mutate({ key: s.key, skipped: true })}
                    >
                      {s.skipLabel}
                    </button>
                  </>
                )}
              </p>
            )}
            {s.skipped && (
              <p className="text-xs text-muted-foreground">
                Marcado como resuelto.{' '}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  disabled={skip.isPending}
                  onClick={() => skip.mutate({ key: s.key, skipped: false })}
                >
                  Deshacer
                </button>
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
