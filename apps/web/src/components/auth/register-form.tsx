'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  DEFAULT_TRIAL_PLAN_SLUG,
  normalizeSalesCode,
  type RegisterInput,
  type RegisterPlanSlug,
  RegisterSchema,
  type SalesCodeCheckDto,
} from '@storageos/shared';
import { BadgeCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { EmailTypoHint } from '@/components/email-typo-hint';
import { platformTrafficFields } from '@/components/public/platform-attribution';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { useRegister } from '@/lib/auth/hooks';
import { forgetSalesCode, rememberSalesCode, storedSalesCode } from '@/lib/sales-code';

/** Datos que trae el enlace de una propuesta (email, empresa y nombre). */
export interface RegisterDefaults {
  email?: string;
  tenantName?: string;
  fullName?: string;
  /** Código del comercial del enlace o el QR (`?team=`). */
  salesCode?: string;
  /** Plan con el que empieza la prueba (`?plan=` desde la tabla de precios). */
  planSlug?: string;
}

/** Plan que se puede elegir al registrarse, con su precio ya escrito. */
export interface RegisterPlanOption {
  slug: string;
  name: string;
  price: string;
  limits: string;
}

/** Comprueba un código de comercial (nombre de quien atiende y días de más). */
async function checkSalesCode(code: string): Promise<SalesCodeCheckDto | null> {
  try {
    return await apiFetch<SalesCodeCheckDto>(`/public/sales/code/${encodeURIComponent(code)}`, {
      requiresAuth: false,
    });
  } catch {
    return null;
  }
}

/**
 * Código de comercial: viene puesto si la visita llegó por su enlace o su QR;
 * si no, el cliente puede escribirlo (solo así la cuenta será de ese comercial).
 */
function SalesCodeField({
  value,
  fromLink,
  onChange,
}: {
  value: string;
  fromLink: boolean;
  onChange: (code: string, fromLink: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<SalesCodeCheckDto | null>(null);
  const code = normalizeSalesCode(value);

  useEffect(() => {
    if (!code) {
      setCheck(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void checkSalesCode(code).then((r) => alive && setCheck(r));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [code]);

  // Un código guardado de otra visita que ya no existe se olvida sin avisar:
  // el cliente no lo ha escrito.
  useEffect(() => {
    if (fromLink && code && check && !check.valid) {
      forgetSalesCode();
      onChange('', false);
    }
  }, [fromLink, code, check, onChange]);

  if (fromLink && code && check?.valid) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
        <BadgeCheck className="mt-0.5 size-4 shrink-0" />
        <div className="flex-1">
          Te atiende <strong>{check.repName}</strong> (código {code}).
          {check.extraTrialDays > 0 && <> Tienes {check.extraTrialDays} días más de prueba.</>}
        </div>
        <button
          type="button"
          className="shrink-0 text-xs underline-offset-2 hover:underline"
          onClick={() => {
            setOpen(true);
            onChange(code, false);
          }}
        >
          Cambiar
        </button>
      </div>
    );
  }
  if (fromLink && code && !check) return null;

  if (!open && !value) {
    return (
      <button
        type="button"
        className="text-sm text-primary underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        ¿Te ha atendido un comercial? Añade su código
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor="register-sales-code">Código de comercial (opcional)</Label>
      <Input
        id="register-sales-code"
        value={value}
        maxLength={20}
        autoComplete="off"
        placeholder="Por ejemplo, ANA7K2"
        onChange={(e) => onChange(e.target.value.toUpperCase(), false)}
      />
      {value && !code && (
        <p className="text-xs text-destructive">El código tiene entre 4 y 12 letras o números.</p>
      )}
      {code && check && !check.valid && (
        <p className="text-xs text-destructive">
          No encontramos ese código. Revísalo con tu comercial.
        </p>
      )}
      {code && check?.valid && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">
          Te atiende {check.repName}.
          {check.extraTrialDays > 0 && ` Tienes ${check.extraTrialDays} días más de prueba.`}
        </p>
      )}
    </div>
  );
}

export function RegisterForm({
  defaults = {},
  plans = [],
}: {
  defaults?: RegisterDefaults;
  plans?: RegisterPlanOption[];
}) {
  const t = useTranslations('auth.register');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const register = useRegister();
  const [salesCode, setSalesCode] = useState(defaults.salesCode ?? '');
  const [salesCodeFromLink, setSalesCodeFromLink] = useState(!!defaults.salesCode);
  const [planSlug, setPlanSlug] = useState(
    plans.find((p) => p.slug === defaults.planSlug)?.slug ??
      plans.find((p) => p.slug === DEFAULT_TRIAL_PLAN_SLUG)?.slug ??
      plans[0]?.slug ??
      '',
  );

  // El código del enlace del comercial: el de la URL o el que guardó la web.
  useEffect(() => {
    if (defaults.salesCode) {
      rememberSalesCode(defaults.salesCode);
      return;
    }
    const stored = storedSalesCode();
    if (stored) {
      setSalesCode(stored);
      setSalesCodeFromLink(true);
    }
  }, [defaults.salesCode]);

  const form = useForm<RegisterInput>({
    resolver: zodResolver(RegisterSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      tenantName: defaults.tenantName ?? '',
      tenantSlug: '',
      fullName: defaults.fullName ?? '',
      email: defaults.email ?? '',
      password: '',
      acceptTerms: false,
    },
  });

  async function onSubmit(values: RegisterInput) {
    const code = normalizeSalesCode(salesCode);
    const payload: RegisterInput = {
      ...values,
      tenantSlug: values.tenantSlug?.trim() || undefined,
      ...platformTrafficFields(),
      ...(code ? { salesCode: code, salesCodeFrom: salesCodeFromLink ? 'link' : 'typed' } : {}),
      ...(planSlug ? { planSlug: planSlug as RegisterPlanSlug } : {}),
    };
    try {
      const res = await register.mutateAsync(payload);
      router.replace(
        `/verify-email-sent?email=${encodeURIComponent(payload.email)}` +
          `&tenantSlug=${encodeURIComponent(res.tenant.slug)}`,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409) {
          form.setError('tenantSlug', { message: t('errors.slugTaken') });
          return;
        }
        if (err.statusCode === 429) {
          toast.error(tCommon('errors.tooManyRequests'));
          return;
        }
        toast.error(err.body.message || tCommon('errors.generic'));
        return;
      }
      toast.error(tCommon('errors.network'));
    }
  }

  return (
    <Form {...form}>
      <form method="post" className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        {plans.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Plan para la prueba de 30 días</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {plans.map((p) => (
                <label
                  key={p.slug}
                  className={`flex cursor-pointer flex-col rounded-md border p-3 text-sm transition-colors ${
                    planSlug === p.slug ? 'border-primary ring-2 ring-primary/30' : 'hover:bg-muted'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="planSlug"
                      value={p.slug}
                      checked={planSlug === p.slug}
                      onChange={() => setPlanSlug(p.slug)}
                      className="accent-primary"
                    />
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-auto text-muted-foreground">{p.price}</span>
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">{p.limits}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Sin tarjeta. Durante la prueba tienes los límites de ese plan y puedes cambiarlo
              cuando quieras.
            </p>
          </fieldset>
        )}
        <FormField
          control={form.control}
          name="tenantName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('tenantName')}</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="organization" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="tenantSlug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('tenantSlug')}</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} placeholder="acme" autoComplete="off" />
              </FormControl>
              <FormDescription>{t('tenantSlugHint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('fullName')}</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="name" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('email')}</FormLabel>
              <FormControl>
                <Input {...field} type="email" autoComplete="email" />
              </FormControl>
              <EmailTypoHint value={field.value} onAccept={field.onChange} />
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('password')}</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="new-password" />
              </FormControl>
              <FormDescription>{t('passwordHint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <SalesCodeField
          value={salesCode}
          fromLink={salesCodeFromLink}
          onChange={(code, fromLink) => {
            setSalesCode(code);
            setSalesCodeFromLink(fromLink);
          }}
        />
        <FormField
          control={form.control}
          name="acceptTerms"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-3 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel className="font-normal">
                  Acepto los{' '}
                  <Link
                    href="/terminos"
                    target="_blank"
                    className="text-primary underline underline-offset-2"
                  >
                    términos
                  </Link>{' '}
                  y la{' '}
                  <Link
                    href="/privacidad"
                    target="_blank"
                    className="text-primary underline underline-offset-2"
                  >
                    política de privacidad
                  </Link>
                </FormLabel>
                <FormMessage />
              </div>
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? tCommon('loading') : t('submit')}
        </Button>
      </form>
    </Form>
  );
}
