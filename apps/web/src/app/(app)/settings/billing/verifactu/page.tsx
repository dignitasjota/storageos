'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  Loader2,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/auth/api';
import {
  type AeatCredentialMetadata,
  useRevokeVerifactuCredentialMutation,
  useUploadVerifactuCredentialMutation,
  useVerifactuCredentialQuery,
} from '@/lib/billing/verifactu-hooks';

const MAX_FILE_BYTES = 50 * 1024;

/**
 * Schema del formulario de subida. Usamos `z.custom<File>` en lugar de
 * `z.instanceof(File)` para que el módulo se pueda evaluar en el servidor
 * (durante el RSC build) aunque el global `File` no esté disponible.
 */
const UploadSchema = z.object({
  file: z
    .custom<File>(
      (val) => typeof File !== 'undefined' && val instanceof File,
      'Selecciona un archivo .p12 o .pfx.',
    )
    .refine((f) => f.size > 0, 'El archivo está vacío.')
    .refine(
      (f) => f.size <= MAX_FILE_BYTES,
      `El archivo es demasiado grande (máx. ${MAX_FILE_BYTES / 1024} KB).`,
    )
    .refine((f) => /\.(p12|pfx)$/i.test(f.name), 'El archivo debe tener extensión .p12 o .pfx.'),
  password: z.string().min(1, 'La contraseña es obligatoria.'),
  environment: z.enum(['sandbox', 'production']),
});

type UploadFormValues = z.infer<typeof UploadSchema>;

const RevokeSchema = z.object({
  reason: z.string().trim().min(3, 'Indica el motivo (mínimo 3 caracteres).').max(500),
});
type RevokeFormValues = z.infer<typeof RevokeSchema>;

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

export default function VerifactuSettingsPage() {
  const t = useTranslations('settings.billing.verifactu');
  const credential = useVerifactuCredentialQuery();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      {credential.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : credential.data ? (
        <CredentialDetails
          credential={credential.data}
          onUpload={() => setUploadOpen(true)}
          onRevoke={() => setRevokeOpen(true)}
        />
      ) : (
        <EmptyState onUpload={() => setUploadOpen(true)} />
      )}

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <RevokeDialog open={revokeOpen} onOpenChange={setRevokeOpen} />
    </div>
  );
}

function CredentialDetails({
  credential,
  onUpload,
  onRevoke,
}: {
  credential: AeatCredentialMetadata;
  onUpload: () => void;
  onRevoke: () => void;
}) {
  const t = useTranslations('settings.billing.verifactu');
  const format = useFormatter();
  const validTo = new Date(credential.certValidTo);
  const now = new Date();
  const days = daysBetween(now, validTo);
  const isExpired = days < 0;
  const isExpiringSoon = !isExpired && days <= 30;

  return (
    <div className="space-y-4">
      {isExpired && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{t('status.expiredTitle')}</AlertTitle>
          <AlertDescription>{t('status.expiredBody')}</AlertDescription>
        </Alert>
      )}
      {isExpiringSoon && (
        <Alert className="border-amber-500/50 text-amber-900 dark:text-amber-200 [&>svg]:text-amber-500">
          <FileWarning className="size-4" />
          <AlertTitle>{t('status.expiringSoonTitle', { days })}</AlertTitle>
          <AlertDescription>{t('status.expiringSoonBody')}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" />
            <CardTitle className="text-base">{t('current.title')}</CardTitle>
            <Badge variant={credential.environment === 'production' ? 'default' : 'outline'}>
              {credential.environment === 'production'
                ? t('environment.production')
                : t('environment.sandbox')}
            </Badge>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onUpload}>
              <Upload className="mr-1 size-4" />
              {t('actions.replace')}
            </Button>
            <Button variant="destructive" size="sm" onClick={onRevoke}>
              <Trash2 className="mr-1 size-4" />
              {t('actions.revoke')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Field label={t('fields.commonName')} value={credential.certCommonName} />
            <Field label={t('fields.nif')} value={credential.certNif} mono />
            <Field
              label={t('fields.issuer')}
              value={credential.certIssuer}
              className="sm:col-span-2"
            />
            <Field
              label={t('fields.validFrom')}
              value={format.dateTime(new Date(credential.certValidFrom), {
                dateStyle: 'long',
              })}
            />
            <Field
              label={t('fields.validTo')}
              value={format.dateTime(new Date(credential.certValidTo), {
                dateStyle: 'long',
              })}
            />
            <Field
              label={t('fields.uploadedAt')}
              value={format.dateTime(new Date(credential.uploadedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-sm' : 'text-sm'}>{value}</dd>
    </div>
  );
}

function EmptyState({ onUpload }: { onUpload: () => void }) {
  const t = useTranslations('settings.billing.verifactu');
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <ShieldCheck className="size-10 text-muted-foreground" aria-hidden />
        <div>
          <p className="font-medium">{t('empty.title')}</p>
          <p className="text-sm text-muted-foreground">{t('empty.body')}</p>
        </div>
        <Button onClick={onUpload}>
          <Upload className="mr-1 size-4" />
          {t('actions.upload')}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Mapea el `code` del error del backend a la clave i18n del frontend. La
 * traducción real se hace en el llamador con `useTranslations`.
 */
function mapUploadError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'generic';
  const code = (err.body as { code?: string }).code;
  switch (code) {
    case 'invalid_certificate_password':
      return 'invalidPassword';
    case 'certificate_expired':
      return 'expired';
    case 'certificate_missing_nif':
      return 'missingNif';
    case 'invalid_certificate_format':
      return 'invalidFormat';
    case 'file_required':
      return 'fileRequired';
    default:
      return 'generic';
  }
}

function UploadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useTranslations('settings.billing.verifactu');
  const upload = useUploadVerifactuCredentialMutation();
  const form = useForm<UploadFormValues>({
    resolver: zodResolver(UploadSchema),
    defaultValues: {
      password: '',
      environment: 'sandbox',
    },
  });

  async function onSubmit(values: UploadFormValues) {
    try {
      await upload.mutateAsync({
        file: values.file,
        password: values.password,
        environment: values.environment,
      });
      toast.success(t('toasts.uploadSuccess'));
      form.reset({ password: '', environment: 'sandbox' });
      onOpenChange(false);
    } catch (err) {
      const key = mapUploadError(err);
      const msg = (
        {
          invalidPassword: t('errors.invalidPassword'),
          expired: t('errors.expired'),
          missingNif: t('errors.missingNif'),
          invalidFormat: t('errors.invalidFormat'),
          fileRequired: t('errors.fileRequired'),
          generic: err instanceof ApiError ? err.body.message : t('errors.generic'),
        } as Record<string, string>
      )[key];
      toast.error(msg ?? t('errors.generic'));
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) form.reset({ password: '', environment: 'sandbox' });
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('upload.title')}</DialogTitle>
          <DialogDescription>{t('upload.description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="file"
              render={({ field: { onChange, value: _value, ...field } }) => (
                <FormItem>
                  <FormLabel>{t('upload.file')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="file"
                      accept=".p12,.pfx,application/x-pkcs12"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onChange(f);
                      }}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">{t('upload.fileHint')}</p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('upload.password')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="password"
                      autoComplete="off"
                      placeholder={t('upload.passwordPlaceholder')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="environment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('upload.environment')}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(v) => field.onChange(v as 'sandbox' | 'production')}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sandbox">{t('environment.sandbox')}</SelectItem>
                        <SelectItem value="production">{t('environment.production')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <p className="text-xs text-muted-foreground">{t('upload.environmentHint')}</p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" disabled={upload.isPending}>
                {upload.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Upload className="mr-1 size-4" />
                )}
                {upload.isPending ? t('actions.uploading') : t('actions.upload')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useTranslations('settings.billing.verifactu');
  const revoke = useRevokeVerifactuCredentialMutation();
  const form = useForm<RevokeFormValues>({
    resolver: zodResolver(RevokeSchema),
    defaultValues: { reason: '' },
  });

  async function onSubmit(values: RevokeFormValues) {
    try {
      await revoke.mutateAsync(values);
      toast.success(t('toasts.revokeSuccess'));
      form.reset({ reason: '' });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : t('errors.generic'));
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) form.reset({ reason: '' });
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive" />
            {t('revoke.title')}
          </DialogTitle>
          <DialogDescription>{t('revoke.description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('revoke.reason')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      autoFocus
                      placeholder={t('revoke.reasonPlaceholder')}
                      maxLength={500}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={revoke.isPending}>
                {revoke.isPending ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1 size-4" />
                )}
                {t('actions.confirmRevoke')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
