import { ConfirmEmailChange } from './confirm-email-change';

export const metadata = { title: 'Confirmar el email nuevo' };

export default async function ConfirmEmailChangePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ConfirmEmailChange token={token} />;
}
