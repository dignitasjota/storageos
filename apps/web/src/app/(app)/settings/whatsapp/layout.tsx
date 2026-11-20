'use client';

import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';
import { useHasFeature, useMe } from '@/lib/auth/hooks';
import { useWhatsappSettings } from '@/lib/whatsapp/hooks';

/**
 * Extra «WhatsApp Business». Sin el extra pero con un número ya conectado (p.
 * ej. tras bajar de plan), la página se abre para desactivarlo o desconectarlo.
 */
export default function WhatsappSettingsLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const hasFeature = useHasFeature('whatsapp_business');
  const settings = useWhatsappSettings(!!me.data && !hasFeature);

  if (!me.data) return null;
  if (hasFeature) return <>{children}</>;
  if (settings.isLoading) return null;
  if (settings.data?.configured) return <>{children}</>;
  return <FeatureGate feature="whatsapp_business">{children}</FeatureGate>;
}
