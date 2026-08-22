'use client';

import { Clock, Moon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalFacilityDto, PortalNightPassDto, PortalSessionDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/auth/api';

function passStatus(
  status: PortalNightPassDto['status'],
  t: ReturnType<typeof useTranslations<'portal.consume.nightAccess'>>,
): { label: string; variant: 'default' | 'secondary' | 'outline' } {
  if (status === 'active') return { label: t('statusActive'), variant: 'default' };
  if (status === 'used') return { label: t('statusUsed'), variant: 'secondary' };
  return { label: t('statusExpired'), variant: 'outline' };
}

function scheduleText(
  f: PortalFacilityDto,
  t: ReturnType<typeof useTranslations<'portal.consume.nightAccess'>>,
): string {
  if (!f.accessCurfewEnabled || !f.accessCurfewStart || !f.accessCurfewEnd) {
    return t('freeAccess');
  }
  return t('scheduleWindow', {
    openFrom: f.accessCurfewEnd,
    openTo: f.accessCurfewStart,
  });
}

/**
 * Informa al inquilino del horario de acceso de su local (toque de queda) para
 * que sepa cuándo necesita un pase nocturno, y muestra el historial de pases
 * comprados.
 */
export function NightAccessCard({
  session,
  facilities,
  refreshKey,
}: {
  session: PortalSessionDto;
  facilities: PortalFacilityDto[];
  /** Cambia para forzar recarga del historial tras comprar un pase. */
  refreshKey?: number;
}) {
  const t = useTranslations('portal.consume.nightAccess');
  const { locale } = usePortalLocale();
  const [passes, setPasses] = useState<PortalNightPassDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PortalNightPassDto[]>('/portal/me/access/night-passes', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then((p) => {
        if (!cancelled) setPasses(p);
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken, refreshKey]);

  const curfewFacilities = facilities.filter((f) => f.accessCurfewEnabled);

  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Clock className="size-4" /> {t('scheduleTitle')}
        </p>
        {facilities.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{t('noScheduleInfo')}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {facilities.map((f) => (
              <li key={f.id}>
                <span className="font-medium text-foreground">{f.name}:</span> {scheduleText(f, t)}
              </li>
            ))}
          </ul>
        )}
        {curfewFacilities.length > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600">
            <Moon className="size-3.5" /> {t('needPassHint')}
          </p>
        )}
      </div>

      {passes.length > 0 && (
        <div className="rounded-md border p-3">
          <p className="text-sm font-medium">{t('yourPasses')}</p>
          <ul className="mt-1 space-y-1">
            {passes.map((p) => {
              const status = passStatus(p.status, t);
              return (
                <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {new Date(p.createdAt).toLocaleDateString(intlLocaleForPortal(locale), {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
