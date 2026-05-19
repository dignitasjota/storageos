'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type LoginInput, LoginSchema } from '@storageos/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
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

  async function onSubmit(values: LoginInput) {
    try {
      await login.mutateAsync(values);
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
