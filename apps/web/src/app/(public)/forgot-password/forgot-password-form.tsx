'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type ForgotPasswordInput, ForgotPasswordSchema } from '@storageos/shared';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/auth/api';
import { useForgotPassword } from '@/lib/auth/hooks';

export function ForgotPasswordForm() {
  const t = useTranslations('auth.forgot');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const forgot = useForgotPassword();

  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(ForgotPasswordSchema),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { tenantSlug: '', email: '' },
  });

  async function onSubmit(values: ForgotPasswordInput) {
    try {
      await forgot.mutateAsync(values);
      router.replace('/forgot-password-sent');
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 429) {
        toast.error(tCommon('errors.tooManyRequests'));
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
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? tCommon('loading') : t('submit')}
        </Button>
      </form>
    </Form>
  );
}
