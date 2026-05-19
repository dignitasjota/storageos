'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type ChangePasswordInput,
  ChangePasswordSchema,
  type UpdateProfileInput,
  UpdateProfileSchema,
} from '@storageos/shared';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import { useChangePassword, useUpdateProfile } from '@/lib/users/hooks';

export default function ProfileSettingsPage() {
  const t = useTranslations('settings.profile');
  const tCommon = useTranslations('common');
  const me = useMe();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">{t('tabs.profile')}</TabsTrigger>
          <TabsTrigger value="password">{t('tabs.password')}</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="mt-6 max-w-lg">
          {me.data ? (
            <ProfileForm
              defaultValues={{
                fullName: me.data.user.fullName,
                phone: '',
              }}
              email={me.data.user.email}
              t={t}
              tCommon={tCommon}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="password" className="mt-6 max-w-lg">
          <PasswordForm t={t} tCommon={tCommon} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface ProfileFormProps {
  defaultValues: UpdateProfileInput;
  email: string;
  t: ReturnType<typeof useTranslations<'settings.profile'>>;
  tCommon: ReturnType<typeof useTranslations<'common'>>;
}

function ProfileForm({ defaultValues, email, t, tCommon }: ProfileFormProps) {
  const update = useUpdateProfile();
  const form = useForm<UpdateProfileInput>({
    resolver: zodResolver(UpdateProfileSchema),
    defaultValues,
  });

  useEffect(() => {
    form.reset(defaultValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues.fullName]);

  async function onSubmit(values: UpdateProfileInput) {
    try {
      await update.mutateAsync(values);
      toast.success(t('success'));
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : tCommon('errors.generic');
      toast.error(msg);
    }
  }

  return (
    <Form {...form}>
      <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('fullName')}</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('phone')}</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormItem>
          <FormLabel>{t('email')}</FormLabel>
          <FormControl>
            <Input value={email} disabled readOnly />
          </FormControl>
          <FormDescription>{t('emailHint')}</FormDescription>
        </FormItem>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? tCommon('loading') : t('submit')}
        </Button>
      </form>
    </Form>
  );
}

interface PasswordFormProps {
  t: ReturnType<typeof useTranslations<'settings.profile'>>;
  tCommon: ReturnType<typeof useTranslations<'common'>>;
}

function PasswordForm({ t, tCommon }: PasswordFormProps) {
  const change = useChangePassword();
  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(ChangePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  async function onSubmit(values: ChangePasswordInput) {
    try {
      await change.mutateAsync(values);
      toast.success(t('passwordTab.success'));
      form.reset({ currentPassword: '', newPassword: '' });
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { code?: string }).code;
        if (code === 'wrong_current_password' || err.statusCode === 403) {
          toast.error(t('passwordTab.errors.wrongCurrent'));
          form.setValue('currentPassword', '');
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
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('passwordTab.currentPassword')}</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="current-password" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('passwordTab.newPassword')}</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="new-password" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? tCommon('loading') : t('passwordTab.submit')}
        </Button>
      </form>
    </Form>
  );
}
