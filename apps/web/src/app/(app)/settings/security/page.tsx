'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useTenantSecuritySettings,
  useUpdateTenantSecuritySettings,
} from '@/lib/tenant-settings/hooks';

/** Seguridad de la empresa: exigir la verificación en dos pasos a propietarios y gestores. */
export default function CompanySecuritySettingsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Seguridad de la empresa</h1>
        <p className="text-sm text-muted-foreground">
          Reglas que aplican a todo tu equipo. Tu propia verificación en dos pasos está en «Perfil».
        </p>
      </div>
      <TenantSecurityPolicyCard />
    </div>
  );
}

/**
 * Tarjeta de politica de seguridad del tenant. Solo visible para owners.
 * Permite activar/desactivar el requerimiento de 2FA para owners y
 * managers. Al activar no se desconecta a nadie: los managers sin 2FA
 * seran forzados a hacer enrolment en su proximo login.
 */
function TenantSecurityPolicyCard() {
  const t = useTranslations('security.policy');
  const tCommon = useTranslations('common');
  const canManage = useHasPermission('settings:manage');
  const settings = useTenantSecuritySettings(canManage);
  const update = useUpdateTenantSecuritySettings();

  if (!canManage) return null;
  if (settings.isLoading || !settings.data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const enabled = settings.data.requireTwoFactorForManagers;

  async function toggle() {
    try {
      await update.mutateAsync({ requireTwoFactorForManagers: !enabled });
      toast.success(enabled ? t('disabledNotice') : t('enabledNotice'));
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : tCommon('errors.network');
      toast.error(msg);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t('title')}</CardTitle>
          <Badge variant={enabled ? 'default' : 'outline'}>{enabled ? t('on') : t('off')}</Badge>
        </div>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('detail')}</p>
        <Button
          onClick={toggle}
          variant={enabled ? 'destructive' : 'default'}
          disabled={update.isPending}
        >
          {update.isPending ? tCommon('loading') : enabled ? t('disableCta') : t('enableCta')}
        </Button>
      </CardContent>
    </Card>
  );
}
