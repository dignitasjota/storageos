'use client';

import { Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PortalPreferencesDto, PortalSessionDto } from '@storageos/shared';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/auth/api';
import { portalApiFetch } from '@/lib/portal/portal-fetch';

/** Qué comunicaciones quiere recibir: ofertas del negocio y avisos por WhatsApp. */
export function PreferencesCard({ session }: { session: PortalSessionDto }) {
  const t = useTranslations('portal.consume.preferences');
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const [prefs, setPrefs] = useState<PortalPreferencesDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    portalApiFetch<PortalPreferencesDto>('/portal/me/preferences', {
      headers,
      requiresAuth: false,
    })
      .then((p) => {
        if (!cancelled) setPrefs(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.accessToken]);

  async function set(key: keyof PortalPreferencesDto, value: boolean) {
    const previous = prefs;
    setPrefs((p) => (p ? { ...p, [key]: value } : p));
    try {
      setPrefs(
        await portalApiFetch<PortalPreferencesDto>('/portal/me/preferences', {
          method: 'PATCH',
          json: { [key]: value },
          headers,
          requiresAuth: false,
        }),
      );
      toast.success(t('saved'));
    } catch (err) {
      setPrefs(previous);
      toast.error(err instanceof ApiError ? err.body.message : t('error'));
    }
  }

  if (!prefs) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="flex items-start gap-3">
          <Checkbox
            checked={prefs.marketing}
            onCheckedChange={(v) => void set('marketing', v === true)}
          />
          <span>
            <span className="block font-medium">{t('marketing')}</span>
            <span className="block text-xs text-muted-foreground">{t('marketingHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-3">
          <Checkbox
            checked={prefs.whatsapp}
            onCheckedChange={(v) => void set('whatsapp', v === true)}
          />
          <span>
            <span className="block font-medium">{t('whatsapp')}</span>
            <span className="block text-xs text-muted-foreground">{t('whatsappHint')}</span>
          </span>
        </label>
        <p className="text-xs text-muted-foreground">{t('note')}</p>
      </CardContent>
    </Card>
  );
}
