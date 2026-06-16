'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type Disable2faInput,
  Disable2faSchema,
  type Regenerate2faRecoveryCodesInput,
  Regenerate2faRecoveryCodesSchema,
  type Verify2faSetupInput,
  Verify2faSetupSchema,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import {
  useTenantSecuritySettings,
  useUpdateTenantSecuritySettings,
} from '@/lib/tenant-settings/hooks';
import {
  useDisable2fa,
  useRegenerate2faRecoveryCodes,
  useSetup2fa,
  useTwoFactorStatus,
  useVerify2faSetup,
} from '@/lib/two-factor/hooks';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function SecuritySettingsPage() {
  const t = useTranslations('security');
  const tCommon = useTranslations('common');
  const status = useTwoFactorStatus();

  const [setupUri, setSetupUri] = useState<string | null>(null);
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [showCodes, setShowCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  const setup = useSetup2fa();
  const verify = useVerify2faSetup();
  const disable = useDisable2fa();
  const regenerate = useRegenerate2faRecoveryCodes();

  const verifyForm = useForm<Verify2faSetupInput>({
    resolver: zodResolver(Verify2faSetupSchema),
    defaultValues: { code: '' },
  });

  async function handleSetup() {
    try {
      const result = await setup.mutateAsync();
      setSetupUri(result.otpauthUri);
      setSetupSecret(result.secretBase32);
    } catch (err) {
      const msg = err instanceof ApiError ? err.body.message : tCommon('errors.generic');
      toast.error(msg);
    }
  }

  async function handleVerify(values: Verify2faSetupInput) {
    try {
      const result = await verify.mutateAsync(values);
      setShowCodes(result.recoveryCodes);
      setSetupUri(null);
      setSetupSecret(null);
      verifyForm.reset();
    } catch (err) {
      if (err instanceof ApiError) {
        if ((err.body as { code?: string }).code === 'invalid_code') {
          toast.error(t('enable.errors.invalidCode'));
          verifyForm.setValue('code', '');
          return;
        }
        toast.error(err.body.message || tCommon('errors.generic'));
        return;
      }
      toast.error(tCommon('errors.network'));
    }
  }

  function handleCopy() {
    if (!showCodes) return;
    void navigator.clipboard.writeText(showCodes.join('\n'));
    toast.success(t('copied'));
  }

  function handleDownload() {
    if (!showCodes) return;
    const blob = new Blob([showCodes.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'storageos-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (status.isLoading || !status.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const enabled = status.data.enabled;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{enabled ? t('status.enabled') : t('status.disabled')}</CardTitle>
            <Badge variant={enabled ? 'default' : 'outline'}>
              {enabled ? t('status.enabled') : t('status.disabled')}
            </Badge>
          </div>
          {enabled && (
            <CardDescription>
              {t('status.enrolledAt', { date: formatDate(status.data.enrolledAt) })} ·{' '}
              {t('status.recoveryRemaining', {
                count: status.data.recoveryCodesRemaining,
              })}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {!enabled && !setupUri && (
            <Button onClick={handleSetup} disabled={setup.isPending}>
              {setup.isPending ? tCommon('loading') : t('enable.cta')}
            </Button>
          )}
          {enabled && (
            <>
              <Button variant="outline" onClick={() => setRegenerateOpen(true)}>
                {t('regenerateCta')}
              </Button>
              <Button variant="destructive" onClick={() => setDisableOpen(true)}>
                {t('disableCta')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {setupUri && setupSecret && (
        <Card>
          <CardHeader>
            <CardTitle>{t('enable.scanTitle')}</CardTitle>
            <CardDescription>{t('enable.scanBody')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex justify-center rounded-md border bg-white p-4">
              <QRCodeSVG value={setupUri} size={192} />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('enable.secretLabel')}</p>
              <code className="block break-all rounded bg-muted px-3 py-2 text-xs">
                {setupSecret}
              </code>
            </div>
            <div className="space-y-2 border-t pt-4">
              <h3 className="font-medium">{t('enable.verifyTitle')}</h3>
              <p className="text-sm text-muted-foreground">{t('enable.verifyBody')}</p>
              <Form {...verifyForm}>
                <form
                  className="space-y-4"
                  onSubmit={verifyForm.handleSubmit(handleVerify)}
                  noValidate
                >
                  <FormField
                    control={verifyForm.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('enable.code')}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSetupUri(null);
                        setSetupSecret(null);
                        verifyForm.reset();
                      }}
                    >
                      {t('enable.cancel')}
                    </Button>
                    <Button type="submit" disabled={verifyForm.formState.isSubmitting}>
                      {verifyForm.formState.isSubmitting ? tCommon('loading') : t('enable.submit')}
                    </Button>
                  </div>
                </form>
              </Form>
            </div>
          </CardContent>
        </Card>
      )}

      {showCodes && (
        <Card>
          <CardHeader>
            <CardTitle>{t('codesTitle')}</CardTitle>
            <CardDescription>{t('codesBody')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border bg-muted/30 p-4 font-mono text-sm">
              {showCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={handleCopy}>
                {t('copy')}
              </Button>
              <Button variant="outline" onClick={handleDownload}>
                {t('download')}
              </Button>
              <Button onClick={() => setShowCodes(null)}>{t('done')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <TenantSecurityPolicyCard />

      <DisableDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onSubmit={(input) =>
          disable.mutateAsync(input).then(() => {
            toast.success(t('status.disabled'));
            setDisableOpen(false);
          })
        }
      />

      <RegenerateDialog
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        onSubmit={(input) =>
          regenerate.mutateAsync(input).then((res) => {
            setRegenerateOpen(false);
            setShowCodes(res.recoveryCodes);
          })
        }
      />
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
  const me = useMe();
  const settings = useTenantSecuritySettings(me.data?.user.role === 'owner');
  const update = useUpdateTenantSecuritySettings();

  if (me.data?.user.role !== 'owner') return null;
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

function DisableDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: Disable2faInput) => Promise<unknown>;
}) {
  const t = useTranslations('security');
  const tCommon = useTranslations('common');
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const form = useForm<Disable2faInput>({
    resolver: zodResolver(Disable2faSchema),
    defaultValues: { currentPassword: '', code: '', recoveryCode: '' },
  });

  async function handle(values: Disable2faInput) {
    const payload: Disable2faInput =
      method === 'totp'
        ? { currentPassword: values.currentPassword, code: values.code }
        : { currentPassword: values.currentPassword, recoveryCode: values.recoveryCode };
    try {
      await onSubmit(payload);
      form.reset();
      setMethod('totp');
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { code?: string }).code;
        if (code === 'wrong_current_password') {
          toast.error(t('errors.wrongPassword'));
          form.setValue('currentPassword', '');
          return;
        }
        if (code === 'invalid_code') {
          toast.error(t('errors.invalidCode'));
          return;
        }
        toast.error(err.body.message || tCommon('errors.generic'));
        return;
      }
      toast.error(tCommon('errors.network'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('disableDialog.title')}</DialogTitle>
          <DialogDescription>{t('disableDialog.description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(handle)} noValidate>
            <FormField
              control={form.control}
              name="currentPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('disableDialog.currentPassword')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="current-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormItem>
              <FormLabel>{t('disableDialog.method')}</FormLabel>
              <Select value={method} onValueChange={(v) => setMethod(v as 'totp' | 'recovery')}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="totp">{t('disableDialog.methodTotp')}</SelectItem>
                  <SelectItem value="recovery">{t('disableDialog.methodRecovery')}</SelectItem>
                </SelectContent>
              </Select>
            </FormItem>
            {method === 'totp' ? (
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('disableDialog.code')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="recoveryCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('disableDialog.code')}</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} autoComplete="off" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {tCommon('cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? tCommon('loading') : t('disableDialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RegenerateDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: Regenerate2faRecoveryCodesInput) => Promise<unknown>;
}) {
  const t = useTranslations('security');
  const tCommon = useTranslations('common');
  const form = useForm<Regenerate2faRecoveryCodesInput>({
    resolver: zodResolver(Regenerate2faRecoveryCodesSchema),
    defaultValues: { currentPassword: '', code: '' },
  });

  async function handle(values: Regenerate2faRecoveryCodesInput) {
    try {
      await onSubmit(values);
      form.reset();
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { code?: string }).code;
        if (code === 'wrong_current_password') {
          toast.error(t('errors.wrongPassword'));
          form.setValue('currentPassword', '');
          return;
        }
        if (code === 'invalid_code') {
          toast.error(t('errors.invalidCode'));
          form.setValue('code', '');
          return;
        }
        toast.error(err.body.message || tCommon('errors.generic'));
        return;
      }
      toast.error(tCommon('errors.network'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('regenerateDialog.title')}</DialogTitle>
          <DialogDescription>{t('regenerateDialog.description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(handle)} noValidate>
            <FormField
              control={form.control}
              name="currentPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('regenerateDialog.currentPassword')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="current-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('regenerateDialog.code')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? tCommon('loading') : t('regenerateDialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
