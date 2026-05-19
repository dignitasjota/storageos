import { Suspense } from 'react';

import { VerifyEmailSentContent } from './verify-email-sent-content';

export const metadata = { title: 'Revisa tu correo' };

export default function VerifyEmailSentPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailSentContent />
    </Suspense>
  );
}
