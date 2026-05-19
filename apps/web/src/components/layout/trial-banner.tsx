'use client';

import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useMe } from '@/lib/auth/hooks';

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * Banner sutil debajo del header cuando el tenant esta en estado `trial`.
 * Si la prueba ya termino, mostramos el aviso correspondiente.
 */
export function TrialBanner() {
  const t = useTranslations('appHeader.trialBanner');
  const me = useMe();
  if (!me.data) return null;
  const tenant = me.data.tenant;
  if (tenant.status !== 'trial') return null;

  const days = daysUntil(tenant.trialEndsAt);
  if (days === null) return null;

  return (
    <div className="border-b border-border bg-primary/5 text-primary">
      <div className="container flex h-9 items-center gap-2 text-xs font-medium">
        <Clock className="size-3.5" aria-hidden />
        <span>{days > 0 ? t('remaining', { days }) : t('ended')}</span>
      </div>
    </div>
  );
}
