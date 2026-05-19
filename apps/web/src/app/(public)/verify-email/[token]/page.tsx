import { Suspense } from 'react';

import { VerifyEmailContent } from './verify-email-content';

export const metadata = { title: 'Verificando cuenta' };

export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <Suspense fallback={null}>
      <VerifyEmailContent token={token} />
    </Suspense>
  );
}
