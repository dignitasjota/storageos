import { normalizeSalesCode, REGISTER_PLAN_SLUGS, SALES_CODE_PARAM } from '@storageos/shared';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import type { Metadata } from 'next';

import { RegisterForm, type RegisterPlanOption } from '@/components/auth/register-form';
import { PlatformAttribution } from '@/components/public/platform-attribution';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchPublicPlans } from '@/lib/platform-plans';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.register');
  return { title: t('title') };
}

/** Un valor de la URL (el enlace de una propuesta trae email, empresa y nombre). */
function param(v: string | string[] | undefined, max: number): string | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s.slice(0, max) : undefined;
}

const eur = (n: number) =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2 })} €`;

/** Planes que se pueden elegir para la prueba, con su precio y límites. */
async function registerPlans(): Promise<RegisterPlanOption[]> {
  const catalog = (await fetchPublicPlans()) ?? [];
  const allowed = new Set<string>(REGISTER_PLAN_SLUGS);
  // Con punto de miles también en 4 cifras («1.000»).
  const num = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const n = (v: number | null, one: string, many: string) =>
    v == null ? `${many} sin límite` : `${num(v)} ${v === 1 ? one : many}`;
  return catalog
    .filter((p) => allowed.has(p.slug))
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      price:
        p.includedUnits != null && p.extraUnitPrice != null
          ? `${eur(p.extraUnitPrice)}/trastero`
          : `${eur(p.priceMonthly)}/mes`,
      limits: [
        n(p.maxUnits, 'trastero', 'trasteros'),
        n(p.maxFacilities, 'local', 'locales'),
        n(p.maxUsers, 'usuario', 'usuarios'),
      ]
        .join(' · ')
        .replace(/^./, (c) => c.toUpperCase()),
    }));
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('auth.register');
  const sp = await searchParams;
  const email = param(sp.email, 254);
  const tenantName = param(sp.company, 100);
  const fullName = param(sp.name, 200);
  const salesCode = normalizeSalesCode(param(sp[SALES_CODE_PARAM], 40));
  const planSlug = param(sp.plan, 40);
  const plans = await registerPlans();
  const defaults = {
    ...(planSlug ? { planSlug } : {}),
    ...(email ? { email } : {}),
    ...(tenantName ? { tenantName } : {}),
    ...(fullName ? { fullName } : {}),
    ...(salesCode ? { salesCode } : {}),
  };
  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-lg border-border/60">
        <CardHeader className="space-y-2 text-center">
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <PlatformAttribution />
          <RegisterForm defaults={defaults} plans={plans} />
          <p className="text-center text-sm text-muted-foreground">
            {t('haveAccount')}{' '}
            <Link href="/login" className="font-medium text-primary hover:underline">
              {t('loginLink')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
