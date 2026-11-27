'use client';

import type { ReactNode } from 'react';

import { FeatureGate } from '@/components/auth/feature-gate';
import { useTenantAiSettings } from '@/lib/ai/hooks';
import { useHasFeature, useHasPermission, useMe } from '@/lib/auth/hooks';

/**
 * Asistente IA del panel. Sin el asistente en el plan pero con una clave
 * propia guardada (p. ej. tras bajar de plan), la página se abre para quitarla.
 */
export default function AiSettingsLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  // SEO Avanzado también gasta consultas de IA: la clave propia se pone aquí.
  const hasAssistant = useHasFeature('ai_assistant');
  const hasSeo = useHasFeature('seo_advanced');
  const hasFeature = hasAssistant || hasSeo;
  const canManage = useHasPermission('settings:manage');
  const settings = useTenantAiSettings(!!me.data && !hasFeature && canManage);

  if (!me.data) return null;
  if (hasFeature) return <>{children}</>;
  if (canManage && settings.isLoading) return null;
  if (settings.data?.ownKeyConfigured) return <>{children}</>;
  return <FeatureGate feature="ai_assistant">{children}</FeatureGate>;
}
