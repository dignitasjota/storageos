'use client';

import { CheckCircle2, Circle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import type {
  InsurancePlanDto,
  PortalAccessCredentialDto,
  PortalAccountDto,
  PortalContractDto,
  PortalNightPassInfoDto,
  PortalSessionDto,
} from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

/**
 * «Mis extras»: lo que tiene contratado y lo que puede añadir, cada cosa con
 * su botón a la sección donde se contrata.
 */
export function ExtrasCard({
  session,
  contracts,
  account,
  access,
  nightPass,
  onNavigate,
}: {
  session: PortalSessionDto;
  contracts: PortalContractDto[];
  account: PortalAccountDto | null;
  access: PortalAccessCredentialDto[];
  nightPass: PortalNightPassInfoDto | null;
  onNavigate: (tab: string) => void;
}) {
  const t = useTranslations('portal.consume.extras');
  // Sin planes de seguro en el negocio no se ofrece la protección.
  const [hasPlans, setHasPlans] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch<InsurancePlanDto[]>('/portal/me/insurance-plans', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      requiresAuth: false,
    })
      .then((p) => {
        if (!cancelled) setHasPlans(p.length > 0);
      })
      .catch(() => {
        /* opcional */
      });
    return () => {
      cancelled = true;
    };
  }, [session.accessToken]);
  const live = contracts.filter((c) => c.status === 'active' || c.status === 'ending');
  if (live.length === 0) return null;
  const insured = live.filter((c) => c.insurancePlanId).length;
  const extraAccess = Math.max(0, access.filter((a) => a.status === 'active').length - live.length);

  const items: { key: string; has: boolean; detail: string; tab: string }[] = [
    ...(hasPlans || insured > 0
      ? [
          {
            key: 'insurance',
            has: insured > 0,
            detail:
              insured === 0
                ? t('insuranceNone')
                : insured === live.length
                  ? t('insuranceAll')
                  : t('insuranceSome', { count: insured, total: live.length }),
            tab: 'contratos',
          },
        ]
      : []),
    {
      key: 'autopay',
      has: !!account?.automatic,
      detail: account?.automatic ? t('autopayOn') : t('autopayOff'),
      tab: 'facturas',
    },
    {
      key: 'extraAccess',
      has: extraAccess > 0,
      detail:
        extraAccess > 0 ? t('extraAccessCount', { count: extraAccess }) : t('extraAccessNone'),
      tab: 'accesos',
    },
    ...(nightPass?.enabled
      ? [{ key: 'nightPass', has: false, detail: t('nightPassHint'), tab: 'accesos' }]
      : []),
    { key: 'otherUnit', has: false, detail: t('otherUnitHint'), tab: 'nuevo' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-3 py-2 text-sm">
              {i.has ? (
                <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
              ) : (
                <Circle className="size-5 shrink-0 text-muted-foreground/50" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t(`item.${i.key}`)}</p>
                <p className="text-xs text-muted-foreground">{i.detail}</p>
              </div>
              <Button
                size="sm"
                variant={i.has ? 'ghost' : 'outline'}
                onClick={() => onNavigate(i.tab)}
              >
                {i.has ? t('manage') : t('add')}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
