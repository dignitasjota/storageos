'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type LoginInput, LoginSchema } from '@storageos/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { ApiError } from '@/lib/auth/api';
import { useLogin } from '@/lib/auth/hooks';
import { useChallenge2fa } from '@/lib/two-factor/hooks';

export function LoginForm() {
  const t = useTranslations('auth.login');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const params = useSearchParams();
  const login = useLogin();

  const next = params.get('next');
  const reason = params.get('reason');

  useEffect(() => {
    if (reason === 'expired') {
      toast.info(t('sessionExpiredNotice'));
    } else if (reason === 'password_changed') {
      toast.success(t('passwordChangedNotice'));
    } else if (reason === 'email_verified') {
      toast.success(t('emailVerifiedNotice'));
    }
    // Solo notificar al primer render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const form = useForm<LoginInput>({
    resolver: zodResolver(LoginSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      tenantSlug: '',
      email: '',
      password: '',
    },
  });

  const [pendingToken, setPendingToken] = useState<string | null>(null);

  async function onSubmit(values: LoginInput) {
    try {
      const result = await login.mutateAsync(values);
      if ('requires2fa' in result) {
        setPendingToken(result.pendingToken);
        return;
      }
      router.replace(next && next.startsWith('/') ? next : '/dashboard');
    } catch (err) {
      // Limpiar password tras cualquier fallo: estandar de UX seguro.
      form.setValue('password', '');
      if (err instanceof ApiError) {
        if (err.statusCode === 401) {
          toast.error(t('errors.invalidCredentials'));
          return;
        }
        if (err.statusCode === 403) {
          const code = (err.body as { code?: string }).code;
          if (code === 'email_not_verified') {
            toast.error(t('errors.emailNotVerified'), {
              action: {
                label: t('errors.resendVerification'),
                onClick: () => {
                  router.push(
                    `/verify-email-sent?email=${encodeURIComponent(form.getValues('email'))}` +
                      `&tenantSlug=${encodeURIComponent(form.getValues('tenantSlug'))}` +
                      `&resend=1`,
                  );
                },
              },
            });
            return;
          }
          toast.error(t('errors.accountDisabled'));
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

  if (pendingToken) {
    return (
      <ChallengeStep
        pendingToken={pendingToken}
        onSuccess={() => router.replace(next && next.startsWith('/') ? next : '/dashboard')}
        onExpired={() => {
          setPendingToken(null);
          form.setValue('password', '');
        }}
      />
    );
  }

  return (
    <Form {...form}>
      <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FormField
          control={form.control}
          name="tenantSlug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('tenantSlug')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="acme"
                  autoComplete="organization"
                  autoCapitalize="off"
                />
              </FormControl>
              <FormDescription>{t('tenantSlugHint')}</FormDescription>
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
                <Input {...field} type="password" autoComplete="current-password" />
              </FormControl>
              <FormMessage />
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

interface ChallengeStepProps {
  pendingToken: string;
  onSuccess: () => void;
  onExpired: () => void;
}

function ChallengeStep({ pendingToken, onSuccess, onExpired }: ChallengeStepProps) {
  const t = useTranslations('loginChallenge');
  const tCommon = useTranslations('common');
  const challenge = useChallenge2fa();
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const payload =
        method === 'totp' ? { pendingToken, code: value } : { pendingToken, recoveryCode: value };
      await challenge.mutateAsync(payload);
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 401) {
          toast.error(t('errors.expired'));
          onExpired();
          return;
        }
        if (err.statusCode === 403) {
          toast.error(t('errors.invalid'));
          setValue('');
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
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div className="space-y-1">
        <h2 className="text-lg font-medium">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">
          {method === 'totp' ? t('code') : t('recoveryLabel')}
        </label>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          autoComplete="one-time-code"
          inputMode={method === 'totp' ? 'numeric' : 'text'}
          maxLength={method === 'totp' ? 6 : 20}
        />
      </div>
      <Button type="submit" className="w-full" disabled={submitting || value.length < 4}>
        {submitting ? tCommon('loading') : t('submit')}
      </Button>
      <button
        type="button"
        className="block w-full text-center text-sm text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => {
          setMethod((m) => (m === 'totp' ? 'recovery' : 'totp'));
          setValue('');
        }}
      >
        {method === 'totp' ? t('useRecovery') : t('useTotp')}
      </button>
    </form>
  );
}
