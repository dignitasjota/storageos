'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

import type { OnboardingDto, OnboardingTestRunDto, PortalMagicLinkDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/auth/api';

/** Crea el inquilino de prueba para recorrer firma y área de clientes con tu email. */
export function TestRunCard({
  testRun,
  canStart,
}: {
  testRun: OnboardingDto['testRun'];
  canStart: boolean;
}) {
  const qc = useQueryClient();
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['dashboard', 'onboarding'] });
  const fail = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo hacer.');

  const start = useMutation({
    mutationFn: () =>
      apiFetch<OnboardingTestRunDto>('/dashboard/onboarding/test-run', { method: 'POST' }),
    onSuccess: (res) => {
      setSigningUrl(res.signingUrl);
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => apiFetch<void>('/dashboard/onboarding/test-run', { method: 'DELETE' }),
    onSuccess: () => {
      setSigningUrl(null);
      toast.success('Inquilino de prueba borrado.');
      void refresh();
    },
    onError: fail,
  });
  const portal = useMutation({
    mutationFn: (customerId: string) =>
      apiFetch<PortalMagicLinkDto>(`/customers/${customerId}/portal-link`, { method: 'POST' }),
    onSuccess: (res) => window.open(res.url, '_blank', 'noopener'),
    onError: fail,
  });

  if (!testRun && !canStart) return null;

  return (
    <Card id="prueba" className="scroll-mt-20">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Prueba tu recorrido</CardTitle>
        <CardDescription>
          Crea un inquilino de prueba con tu email y mira lo que verán tus clientes: el contrato, la
          firma y el área de clientes. No se emite ninguna factura y lo borras cuando acabes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {!testRun ? (
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            Crear inquilino de prueba
          </Button>
        ) : (
          <>
            {signingUrl ? (
              <Button asChild>
                <a href={signingUrl} target="_blank" rel="noreferrer">
                  Firmar el contrato de prueba
                </a>
              </Button>
            ) : (
              <p className="w-full text-sm text-muted-foreground">
                El enlace para firmar está en tu correo.
              </p>
            )}
            <Button
              variant="outline"
              onClick={() => portal.mutate(testRun.customerId)}
              disabled={portal.isPending}
            >
              Abrir su área de clientes
            </Button>
            <Button variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Borrar la prueba
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
