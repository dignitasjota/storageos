'use client';

import { Eye, EyeOff, Lock, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';

import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import type { PortalAccessCredentialDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';

/**
 * Un acceso del inquilino. El PIN y el QR se ocultan hasta pulsar «Mostrar»
 * (alguien puede estar mirando la pantalla). Si está suspendido se explica por
 * qué y, si es por una factura, cuánto falta para recuperarlo.
 */
export function AccessCredentialItem({
  credential: c,
  regenerating,
  onRegenerate,
  onPay,
}: {
  credential: PortalAccessCredentialDto;
  regenerating: boolean;
  onRegenerate: () => void;
  onPay: () => void;
}) {
  const t = useTranslations('portal.consume.access');
  const { locale } = usePortalLocale();
  const [shown, setShown] = useState(false);
  const title = c.label ?? (c.method === 'qr' ? t('qrLabel') : t('pinLabel'));

  if (c.suspension) {
    const s = c.suspension;
    return (
      <li className="space-y-2 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        <p className="flex items-center gap-2 font-medium">
          <Lock className="size-4" /> {title} · {t('suspendedTitle')}
        </p>
        <p>
          {s.unpaid
            ? s.invoiceNumber && s.pending
              ? t('suspendedUnpaid', {
                  number: s.invoiceNumber,
                  amount: s.pending.toLocaleString(intlLocaleForPortal(locale), {
                    style: 'currency',
                    currency: 'EUR',
                  }),
                })
              : t('suspendedUnpaidGeneric')
            : t('suspendedOther')}
        </p>
        {s.unpaid && (
          <Button size="sm" variant="destructive" onClick={onPay}>
            {t('payToRestore')}
          </Button>
        )}
      </li>
    );
  }

  return (
    <li className="rounded-md border p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <div className="flex items-center">
          {c.value !== null && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShown((v) => !v)}
              aria-label={shown ? t('hide') : t('show')}
              title={shown ? t('hide') : t('show')}
            >
              {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            title={t('regenerate')}
            disabled={regenerating}
            onClick={onRegenerate}
            aria-label={t('update')}
          >
            <RefreshCw className={`h-4 w-4 ${regenerating ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>
      {c.value === null ? (
        <p className="text-xs text-muted-foreground">{t('legacyCredential')}</p>
      ) : !shown ? (
        <button
          type="button"
          onClick={() => setShown(true)}
          className="flex w-full flex-col items-center gap-1 rounded-md bg-muted/50 py-6 text-sm text-muted-foreground hover:bg-muted"
        >
          <span className="font-mono text-2xl tracking-[0.3em]">
            {c.method === 'qr' ? '▦▦▦' : '••••••'}
          </span>
          {t('tapToShow')}
        </button>
      ) : c.method === 'qr' ? (
        <div className="flex flex-col items-center gap-2">
          <div className="rounded bg-white p-2">
            <QRCodeSVG value={c.value} size={148} />
          </div>
          <span className="break-all text-center font-mono text-[10px] text-muted-foreground">
            {c.value}
          </span>
        </div>
      ) : (
        <div className="text-center">
          <span className="font-mono text-3xl tracking-[0.3em]">{c.value}</span>
        </div>
      )}
    </li>
  );
}
