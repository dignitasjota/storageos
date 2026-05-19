'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type AcceptInvitationInput, AcceptInvitationSchema } from '@storageos/shared';
import { Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useAcceptInvitation, usePublicInvitation } from '@/lib/invitations/hooks';

export function AcceptInvitationContent({ token }: { token: string }) {
  const t = useTranslations('invite');
  const tCommon = useTranslations('common');
  const tRoles = useTranslations('settings.users.role');
  const tAuth = useTranslations('auth.verifyToken');
  const router = useRouter();
  const info = usePublicInvitation(token);
  const accept = useAcceptInvitation(token);

  const form = useForm<AcceptInvitationInput>({
    resolver: zodResolver(AcceptInvitationSchema),
    defaultValues: { fullName: '', password: '' },
  });

  async function onSubmit(values: AcceptInvitationInput) {
    try {
      await accept.mutateAsync(values);
      router.replace('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          toast.error(t('errors.invalid'));
          return;
        }
        toast.error(err.body.message || tCommon('errors.generic'));
        return;
      }
      toast.error(tCommon('errors.network'));
    }
  }

  if (info.isLoading) {
    return (
      <div className="container flex justify-center py-12">
        <Card className="w-full max-w-md border-border/60 text-center">
          <CardHeader className="space-y-3">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Loader2 className="size-6 animate-spin" aria-hidden />
            </div>
            <CardTitle className="text-xl">{tCommon('loading')}</CardTitle>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (info.isError || !info.data) {
    return (
      <div className="container flex justify-center py-12">
        <Card className="w-full max-w-md border-border/60 text-center">
          <CardHeader className="space-y-3">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <XCircle className="size-6" aria-hidden />
            </div>
            <CardTitle className="text-xl">{t('errors.invalid')}</CardTitle>
            <CardDescription>{t('errors.tryAgain')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/login">{tAuth('goToLogin')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const expiresLabel = new Date(info.data.expiresAt).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  return (
    <div className="container flex justify-center py-12">
      <Card className="w-full max-w-md border-border/60">
        <CardHeader className="space-y-2">
          <CardTitle className="text-xl">{t('title', { tenant: info.data.tenant.name })}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
          <div className="space-y-1 pt-2 text-sm text-muted-foreground">
            {info.data.inviterName && <p>{t('invitedBy', { name: info.data.inviterName })}</p>}
            <p>{t('role', { role: tRoles(info.data.role) })}</p>
            <p>{t('expires', { date: expiresLabel })}</p>
            <p className="font-mono text-xs">{info.data.email}</p>
          </div>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
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
              <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? tCommon('loading') : t('submit')}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
