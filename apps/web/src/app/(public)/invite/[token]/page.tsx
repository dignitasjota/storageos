import { Suspense } from 'react';

import { AcceptInvitationContent } from './accept-invitation-content';

export const metadata = { title: 'Aceptar invitación' };

export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <Suspense fallback={null}>
      <AcceptInvitationContent token={token} />
    </Suspense>
  );
}
