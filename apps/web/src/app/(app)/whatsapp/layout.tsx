import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';

/** Extra «WhatsApp Business». */
export default function WhatsappLayout({ children }: { children: ReactNode }) {
  return <FeatureGate feature="whatsapp_business">{children}</FeatureGate>;
}
