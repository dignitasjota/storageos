'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Verify2faSetupSchema, type Verify2faSetupInput } from '@storageos/shared';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useEnrol2faRequiredSetup, useEnrol2faRequiredVerify } from '@/lib/two-factor/hooks';

type Stage = 'loading' | 'setup' | 'codes';

interface EnrolmentClientProps {
  enrolmentToken: string;
}

export function EnrolmentClient({ enrolmentToken }: EnrolmentClientProps) {
  const t = useTranslations('enrolment');
  const tCommon = useTranslations('common');
  const router = useRouter();

  const setup = useEnrol2faRequiredSetup();
  const verify = useEnrol2faRequiredVerify();

  const [stage, setStage] = useState<Stage>('loading');
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [secretBase32, setSecretBase32] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [tokenInvalid, setTokenInvalid] = useState(false);

  // Guardia: solo dispara setup una vez por montaje aunque React 19 vuelva
  // a invocar el effect en dev/strict mode.
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    setup
      .mutateAsync({ enrolmentToken })
      .then((data) => {
        setOtpauthUri(data.otpauthUri);
        setSecretBase32(data.secretBase32);
        setStage('setup');
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 403)) {
          setTokenInvalid(true);
          return;
        }
        toast.error(err instanceof ApiError ? err.body.message : tCommon('errors.network'));
        setTokenInvalid(true);
      });
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bloquea cierre accidental de la pestana mientras esta en mitad del flow.
  useEffect(() => {
    if (stage === 'codes' && acknowledged) return;
    if (tokenInvalid) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [stage, acknowledged, tokenInvalid]);

  const verifyForm = useForm<Verify2faSetupInput>({
    resolver: zodResolver(Verify2faSetupSchema),
    defaultValues: { code: '' },
  });

  async function handleVerify(values: Verify2faSetupInput) {
    try {
      const result = await verify.mutateAsync({
        enrolmentToken,
        code: values.code,
      });
      setRecoveryCodes(result.recoveryCodes);
      setStage('codes');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.statusCode === 401) {
          setTokenInvalid(true);
          return;
        }
        if ((err.body as { code?: string }).code === 'invalid_code') {
          toast.error(t('errors.invalidCode'));
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
    if (!recoveryCodes) return;
    void navigator.clipboard.writeText(recoveryCodes.join('\n'));
    toast.success(t('copied'));
  }

  function handleDownload() {
    if (!recoveryCodes) return;
    const blob = new Blob([recoveryCodes.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'storageos-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleFinish() {
    router.replace('/dashboard');
  }

  if (tokenInvalid) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>{t('errors.tokenInvalidTitle')}</AlertTitle>
        <AlertDescription>
          {t('errors.tokenInvalidBody')}{' '}
          <a className="underline" href="/login">
            {t('errors.backToLogin')}
          </a>
        </AlertDescription>
      </Alert>
    );
  }

  if (stage === 'loading' || !otpauthUri || !secretBase32) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <Alert>
        <AlertTriangle className="size-4" />
        <AlertTitle>{t('mandatoryTitle')}</AlertTitle>
        <AlertDescription>{t('mandatoryBody')}</AlertDescription>
      </Alert>

      {stage === 'setup' && (
        <div className="space-y-6">
          <div className="space-y-2">
            <h2 className="text-lg font-medium">{t('scanTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('scanBody')}</p>
          </div>
          <div className="flex justify-center rounded-md border bg-white p-4">
            <QRCodeSVG value={otpauthUri} size={192} />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('secretLabel')}</p>
            <code className="block break-all rounded bg-muted px-3 py-2 text-xs">
              {secretBase32}
            </code>
          </div>
          <div className="space-y-2 border-t pt-4">
            <h3 className="font-medium">{t('verifyTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('verifyBody')}</p>
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
                      <FormLabel>{t('code')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          autoFocus
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={verifyForm.formState.isSubmitting}
                >
                  {verifyForm.formState.isSubmitting ? tCommon('loading') : t('submit')}
                </Button>
              </form>
            </Form>
          </div>
        </div>
      )}

      {stage === 'codes' && recoveryCodes && (
        <div className="space-y-4">
          <div className="space-y-2">
            <h2 className="text-lg font-medium">{t('codesTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('codesBody')}</p>
          </div>
          <ul className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-4 font-mono text-sm">
            {recoveryCodes.map((code) => (
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
          </div>
          <label className="flex items-start gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              aria-label={t('ack')}
            />
            <span>{t('ack')}</span>
          </label>
          <Button className="w-full" disabled={!acknowledged} onClick={handleFinish}>
            {t('continue')}
          </Button>
        </div>
      )}
    </>
  );
}
