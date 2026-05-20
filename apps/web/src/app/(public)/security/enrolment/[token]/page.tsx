import { getTranslations } from 'next-intl/server';

import type { Metadata } from 'next';

import { EnrolmentClient } from '@/components/auth/enrolment-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('enrolment');
  return { title: t('title') };
}

interface EnrolmentPageProps {
  params: Promise<{ token: string }>;
}

/**
 * Pagina publica para el enrolment 2FA forzoso. Se renderiza cuando el
 * tenant tiene `requireTwoFactorForManagers=true` y el usuario (owner|manager)
 * intenta hacer login sin tener 2FA configurado.
 *
 * No tiene `JwtAuthGuard`: la autenticacion la aporta el `enrolmentToken`
 * de la URL, que el backend valido al emitirlo en el login.
 *
 * Tres pasos visibles: setup (QR + secret) -> verify (codigo TOTP) ->
 * recovery codes. No se puede saltar ni cerrar sin completar (banner
 * persistente).
 */
export default async function EnrolmentPage({ params }: EnrolmentPageProps) {
  const t = await getTranslations('enrolment');
  const { token } = await params;
  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-2xl border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <EnrolmentClient enrolmentToken={token} />
        </CardContent>
      </Card>
    </div>
  );
}
