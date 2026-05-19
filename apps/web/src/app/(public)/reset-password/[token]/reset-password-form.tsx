'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type ResetPasswordInput, ResetPasswordSchema } from '@storageos/shared';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

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
import { useResetPassword } from '@/lib/auth/hooks';

// Form-level schema con confirmacion. La API solo recibe `password` + `token`.
function buildFormSchema(token: string) {
  return ResetPasswordSchema.extend({
    confirmPassword: z.string(),
  }).superRefine((data, ctx) => {
    if (data.password !== data.confirmPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmPassword'],
        message: 'Las contrasenas no coinciden',
      });
    }
    if (data.token !== token) {
      ctx.addIssue({ code: 'custom', path: ['token'], message: 'Token alterado' });
    }
  });
}

type FormValues = ResetPasswordInput & { confirmPassword: string };

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations('auth.reset');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const resetPassword = useResetPassword();

  const form = useForm<FormValues>({
    resolver: zodResolver(buildFormSchema(token)),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { token, password: '', confirmPassword: '' },
  });

  async function onSubmit(values: FormValues) {
    try {
      await resetPassword.mutateAsync({ token, password: values.password });
      router.replace('/login?reason=password_changed');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 401) {
          toast.error(t('errors.tokenInvalid'));
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
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('confirmPassword')}</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="new-password" />
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
