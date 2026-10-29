import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';

/** Vencimientos del negocio: función de los planes de pago. */
export default function RemindersLayout({ children }: { children: ReactNode }) {
  return <FeatureGate feature="business_reminders">{children}</FeatureGate>;
}
